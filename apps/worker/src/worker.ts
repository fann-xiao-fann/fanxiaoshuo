import {
  QUEUE_NAMES,
  type SmokeJobResult,
} from '@fanxiaoshuo/shared';
import { createFanXiaoshuoRuntime } from '@fanxiaoshuo/agents';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { createPgPool } from './db/pool.js';
import { createPgUsageLogger } from './db/usage-log-writer.js';
import { createModelConfigResolver } from './db/model-repository.js';
import { createJobEventPublisher } from './events/job-events.js';
import { createHeartbeatReporter, type HeartbeatReporter } from './heartbeat.js';
import { createBullMqSmokeJobHandler, createSmokeJobProcessor } from './jobs/smoke-job.js';
import { consoleWorkerLogger, type WorkerLogger } from './logger.js';
import { parseEncryptionKey } from './security/encryption.js';
import type { WorkerEnv } from './config/env.js';

export interface StartWorkerOptions {
  readonly env: WorkerEnv;
  readonly logger?: WorkerLogger;
}

export interface WorkerHandle {
  readonly worker: Worker<unknown, SmokeJobResult>;
  readonly shutdown: (signal?: NodeJS.Signals | 'shutdown') => Promise<void>;
  /** `shutdown()` 完成后 resolve，供入口进程等待退出 */
  readonly closed: Promise<void>;
}

/**
 * 组装并启动 `runtime-smoke` BullMQ Worker。
 *
 * 依赖拓扑（全部在本进程内）：
 * `BullMQ Worker` → `createSmokeJobProcessor` → `Mastra 运行时门面` → `ModelGateway`
 * → PostgreSQL（模型解析 + `llm_usage_logs`）；事件与心跳统一走 Redis。
 *
 * 优雅停机：`SIGINT` / `SIGTERM` 时停止心跳 → `worker.close()`（等待在途任务）
 * → 关闭 Redis / PG 连接。
 */
export async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
  const logger = options.logger ?? consoleWorkerLogger;
  const { env } = options;

  const encryptionKey = parseEncryptionKey(env.APP_ENCRYPTION_KEY);
  const pool: Pool = createPgPool(env.DATABASE_URL);
  const usageLogger = createPgUsageLogger(pool);
  const resolveModelConfig = createModelConfigResolver(pool, encryptionKey);

  // Mastra 运行时复用同一个实例（复用网关与引擎状态），计量钩子直接落盘用量日志。
  const runtime = createFanXiaoshuoRuntime({ usageLogger });

  const eventsConnection = createRedisConnection(env.REDIS_URL, logger, 'events');
  const queueConnection = createRedisConnection(env.REDIS_URL, logger, 'queue');

  let activeJobs = 0;
  const publishEvent = createJobEventPublisher({
    publish: (channel, message) => eventsConnection.publish(channel, message),
  });
  const heartbeat = createHeartbeatReporter({
    redis: {
      set: (key, value, expiryMode, ttlSeconds) =>
        eventsConnection.set(key, value, expiryMode, ttlSeconds),
    },
    concurrency: env.WORKER_CONCURRENCY,
    activeJobs: () => activeJobs,
    logger,
  });

  const processor = createSmokeJobProcessor({
    runtime,
    resolveModelConfig,
    publishEvent,
    logger,
  });
  const handler = createBullMqSmokeJobHandler(processor);

  const worker = new Worker<unknown, SmokeJobResult>(
    QUEUE_NAMES.runtimeSmoke,
    async (job) => {
      activeJobs += 1;
      try {
        return await handler(job);
      } finally {
        activeJobs = Math.max(0, activeJobs - 1);
      }
    },
    {
      connection: queueConnection,
      concurrency: env.WORKER_CONCURRENCY,
    },
  );

  worker.on('error', (error) => {
    logger.error('[worker] BullMQ Worker 内部错误', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  });
  worker.on('completed', (job) => {
    logger.info('[worker] 任务完成', { jobId: job.id ?? 'unknown' });
  });
  worker.on('failed', (job, error) => {
    // `error.message` 已由处理器脱敏（不含明文 API Key）。
    logger.warn('[worker] 任务失败', {
      jobId: job?.id ?? 'unknown',
      attemptsMade: job?.attemptsMade ?? 0,
      reason: error.message,
    });
  });

  await heartbeat.start();
  logger.info('[worker] 心跳上报已启动', {
    key: 'fanxiaoshuo:worker:heartbeat',
    intervalMs: 10_000,
    ttlSeconds: 30,
    concurrency: env.WORKER_CONCURRENCY,
    pid: process.pid,
  });

  let shuttingDown = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const shutdown = async (signal: NodeJS.Signals | 'shutdown' = 'shutdown'): Promise<void> => {
    if (shuttingDown) {
      await closed;
      return;
    }
    shuttingDown = true;
    logger.info(`[worker] 收到 ${signal}，开始优雅停机…`);

    heartbeat.stop();

    try {
      // 等待在途任务完成，同时不再接收新任务。
      await worker.close();
    } catch (error) {
      logger.error('[worker] 关闭 BullMQ Worker 失败', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }

    await Promise.allSettled([eventsConnection.quit(), queueConnection.quit()]);

    try {
      await pool.end();
    } catch (error) {
      logger.error('[worker] 关闭 PostgreSQL 连接池失败', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }

    logger.info('[worker] 已优雅退出');
    resolveClosed();
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return { worker, shutdown, closed };
}

/** 创建 BullMQ 兼容的 ioredis 连接（`maxRetriesPerRequest: null` 为 BullMQ 硬性要求）。 */
function createRedisConnection(
  redisUrl: string,
  logger: WorkerLogger,
  role: 'events' | 'queue',
): Redis {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    connectionName: `fanxiaoshuo-worker-${role}`,
  });
  connection.on('error', (error) => {
    logger.error(`[worker] Redis(${role}) 连接错误`, {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  });
  return connection;
}

export type { HeartbeatReporter };
