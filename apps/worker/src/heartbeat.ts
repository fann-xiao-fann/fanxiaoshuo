import { REDIS_KEYS, WORKER_HEARTBEAT, isoDateTimeSchema, nonNegativeIntSchema } from '@fanxiaoshuo/shared';
import { z } from 'zod';
import type { WorkerLogger } from './logger.js';

/**
 * Worker 心跳负载（写入 `fanxiaoshuo:worker:heartbeat`，服务端健康检查读取）。
 * 字段与 `components/schemas/health` 的 Worker 探测口径保持一致。
 */
export const workerHeartbeatSchema = z.strictObject({
  /** 进程 ID */
  pid: z.number().int().positive(),
  /** 进程启动时间（ISO-8601） */
  startedAt: isoDateTimeSchema,
  /** 本次心跳刷新时间（ISO-8601） */
  updatedAt: isoDateTimeSchema,
  /** 当前正在执行的任务数 */
  activeJobs: nonNegativeIntSchema,
  /** 配置的并发度 */
  concurrency: z.number().int().positive(),
  status: z.literal('ok'),
});

export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;

/** 心跳写入所需的最小 Redis 接口。 */
export interface HeartbeatRedis {
  set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
}

export interface HeartbeatReporterOptions {
  readonly redis: HeartbeatRedis;
  readonly concurrency: number;
  /** 读取当前活跃任务数（每次心跳实时采样） */
  readonly activeJobs?: () => number;
  /** 默认 `REDIS_KEYS.workerHeartbeat` */
  readonly key?: string;
  /** 默认 10_000ms */
  readonly intervalMs?: number;
  /** 默认 30 秒 */
  readonly ttlSeconds?: number;
  /** 默认 `process.pid`（测试可注入固定值） */
  readonly pid?: number;
  /** 默认 `() => new Date()`（测试配合 fake timers 使用） */
  readonly now?: () => Date;
  readonly logger?: WorkerLogger;
}

export interface HeartbeatReporter {
  /** 启动：立即写入一次心跳，随后按间隔刷新 */
  start(): Promise<void>;
  /** 停止：清理定时器（Redis 键由 TTL 自然过期，不主动删除以避免竞态） */
  stop(): void;
  /** 立即上报一次（返回写入的负载；写入失败时返回 null 且不抛错） */
  reportOnce(): Promise<WorkerHeartbeat | null>;
  readonly running: boolean;
}

/**
 * 心跳上报器。
 *
 * - 启动后立即写入，之后每 10 秒刷新 `EX 30`；
 * - 心跳失败只记录警告，绝不中断队列消费（Redis 瞬时抖动不应杀死 Worker）；
 * - `stop()` 清理定时器，供优雅停机调用。
 */
export function createHeartbeatReporter(options: HeartbeatReporterOptions): HeartbeatReporter {
  const key = options.key ?? REDIS_KEYS.workerHeartbeat;
  const intervalMs = options.intervalMs ?? WORKER_HEARTBEAT.intervalMs;
  const ttlSeconds = options.ttlSeconds ?? WORKER_HEARTBEAT.ttlSeconds;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const activeJobs = options.activeJobs ?? (() => 0);

  let startedAt: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const reportOnce = async (): Promise<WorkerHeartbeat | null> => {
    const timestamp = now();
    startedAt ??= timestamp.toISOString();
    const heartbeat = workerHeartbeatSchema.parse({
      pid,
      startedAt,
      updatedAt: timestamp.toISOString(),
      activeJobs: Math.max(0, Math.trunc(activeJobs())),
      concurrency: Math.max(1, Math.trunc(options.concurrency)),
      status: 'ok',
    });

    try {
      await options.redis.set(key, JSON.stringify(heartbeat), 'EX', ttlSeconds);
      return heartbeat;
    } catch (error) {
      options.logger?.warn('[worker] 心跳写入失败（不影响队列消费）', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    }
  };

  return {
    async start(): Promise<void> {
      if (timer !== null) {
        return;
      }
      await reportOnce();
      timer = setInterval(() => {
        void reportOnce();
      }, intervalMs);
      // 心跳定时器不应单独阻止进程退出（停机流程由显式 stop + worker.close 负责）。
      timer.unref?.();
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    reportOnce,
    get running(): boolean {
      return timer !== null;
    },
  };
}
