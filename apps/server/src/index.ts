import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelGateway } from '@fanxiaoshuo/agents';
import { config as loadDotenv } from 'dotenv';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { loadEnv } from './config/env.js';
import { createSecretCodec } from './crypto/secret-codec.js';
import { createDatabase } from './db/client.js';
import { createHealthProbes } from './health/probes.js';
import { createBullMqSmokeQueue } from './queue/bullmq-smoke-queue.js';
import { createBullMqWorkflowQueue } from './queue/bullmq-workflow-queue.js';
import { createRedisJobEventBus } from './queue/redis-event-bus.js';
import { createRedisWorkflowEventBus } from './queue/redis-workflow-event-bus.js';
import { createDrizzleAgentRoleRepository } from './repositories/drizzle/agent-role-repository.js';
import { createDrizzleBookOutlineRepository } from './repositories/drizzle/book-outline-repository.js';
import { createDrizzleBookRepository } from './repositories/drizzle/book-repository.js';
import { createDrizzleChapterRepository } from './repositories/drizzle/chapter-repository.js';
import { createDrizzleChapterRevisionRepository } from './repositories/drizzle/chapter-revision-repository.js';
import { createDrizzleChapterSummaryRepository } from './repositories/drizzle/chapter-summary-repository.js';
import { createDrizzleKnowledgeCardRepository } from './repositories/drizzle/knowledge-card-repository.js';
import { createDrizzleModelRepository } from './repositories/drizzle/model-repository.js';
import { createDrizzleProviderRepository } from './repositories/drizzle/provider-repository.js';
import { createDrizzleToolboxRunRepository } from './repositories/drizzle/toolbox-run-repository.js';
import { createDrizzleUsageLogRepository } from './repositories/drizzle/usage-log-repository.js';
import { createDrizzleVolumeRepository } from './repositories/drizzle/volume-repository.js';
import { createDrizzleWorkflowRunRepository } from './repositories/drizzle/workflow-run-repository.js';
import { buildServer } from './server.js';
import { DEFAULT_SERVER_VERSION } from './server-deps.js';

/** 依次尝试包目录与仓库根目录的 `.env`（Windows / POSIX 均适用）。 */
function loadProjectEnv(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, quiet: true });
      return;
    }
  }
}

function readServerVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : DEFAULT_SERVER_VERSION;
  } catch {
    return DEFAULT_SERVER_VERSION;
  }
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly shutdown: () => Promise<void>;
}

/**
 * 生产启动流程：环境变量校验（fail-fast）→ 基础设施连接 → 依赖注入 → 监听。
 */
export async function startServer(): Promise<RunningServer> {
  loadProjectEnv();
  const env = loadEnv();

  const { pool, db } = createDatabase(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const subscriber = redis.duplicate();
  const smokeQueue = createBullMqSmokeQueue({ redisUrl: env.REDIS_URL });
  const workflowQueue = createBullMqWorkflowQueue({ redisUrl: env.REDIS_URL });

  const providers = createDrizzleProviderRepository(db);
  const models = createDrizzleModelRepository(db);
  const agentRoles = createDrizzleAgentRoleRepository(db);
  const usageLogs = createDrizzleUsageLogRepository(db);
  const books = createDrizzleBookRepository(db);
  const volumes = createDrizzleVolumeRepository(db);
  const chapters = createDrizzleChapterRepository(db);
  const chapterRevisions = createDrizzleChapterRevisionRepository(db);
  const bookOutlines = createDrizzleBookOutlineRepository(db);
  const knowledgeCards = createDrizzleKnowledgeCardRepository(db);
  const chapterSummaries = createDrizzleChapterSummaryRepository(db);
  const workflowRuns = createDrizzleWorkflowRunRepository(db);
  const toolboxRuns = createDrizzleToolboxRunRepository(db);

  const gateway = new ModelGateway({
    usageLogger: async (record) => {
      await usageLogs.insert(record);
    },
  });

  const eventBus = createRedisJobEventBus({ publisher: redis, subscriber });
  const workflowEventBus = createRedisWorkflowEventBus({ publisher: redis, subscriber });
  const health = createHealthProbes({ postgres: pool, redis });

  const app = await buildServer({
    config: {
      APP_ENCRYPTION_KEY: env.APP_ENCRYPTION_KEY,
      API_PORT: env.API_PORT,
      NODE_ENV: env.NODE_ENV,
      version: readServerVersion(),
    },
    codec: createSecretCodec(env.APP_ENCRYPTION_KEY),
    providers,
    models,
    agentRoles,
    usageLogs,
    books,
    volumes,
    chapters,
    chapterRevisions,
    bookOutlines,
    knowledgeCards,
    chapterSummaries,
    workflowRuns,
    toolboxRuns,
    workflowQueue,
    workflowEventBus,
    gateway,
    smokeQueue,
    eventBus,
    health,
  });

  await app.listen({ host: '0.0.0.0', port: env.API_PORT });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await app.close().catch(() => undefined);
    await smokeQueue.close?.().catch(() => undefined);
    await workflowQueue.close?.().catch(() => undefined);
    await subscriber.quit().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await pool.end().catch(() => undefined);
  };

  return { app, shutdown };
}

async function main(): Promise<void> {
  const running = await startServer();
  const shutdownAndExit = (signal: string): void => {
    void running
      .shutdown()
      .then(() => {
        console.log(`[server] 收到 ${signal}，已优雅停机。`);
      })
      .catch((error: unknown) => {
        console.error('[server] 停机过程出错：', error instanceof Error ? error.message : error);
      })
      .finally(() => {
        process.exitCode = 0;
      });
  };

  process.once('SIGINT', () => shutdownAndExit('SIGINT'));
  process.once('SIGTERM', () => shutdownAndExit('SIGTERM'));
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntrypoint) {
  main().catch((error: unknown) => {
    console.error(
      '[server] 启动失败：',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
}
