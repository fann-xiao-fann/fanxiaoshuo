import {
  healthResponseSchema,
  type ComponentHealth,
  type HealthResponse,
} from '@fanxiaoshuo/shared';
import type { FastifyInstance } from 'fastify';
import type { ServerDependencies } from '../server-deps.js';
import { DEFAULT_SERVER_VERSION } from '../server-deps.js';

function fallbackComponent(label: string, error: unknown): ComponentHealth {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 'down',
    latencyMs: null,
    message: `${label} 探测异常：${message.slice(0, 480)}`,
    lastHeartbeatAt: null,
    activeJobs: null,
  };
}

async function runProbe(
  label: string,
  probe: () => Promise<ComponentHealth>,
): Promise<ComponentHealth> {
  try {
    return await probe();
  } catch (error) {
    return fallbackComponent(label, error);
  }
}

/**
 * `/api/v1/health`：主动探测 PG / Redis / Worker 心跳。
 * 任一组件异常时返回 `status: 'degraded'` 与可读诊断，而不是无上下文 500。
 */
export function registerHealthRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  app.get('/api/v1/health', async (): Promise<HealthResponse> => {
    const [postgres, redis, worker] = await Promise.all([
      runProbe('PostgreSQL', () => deps.health.checkPostgres()),
      runProbe('Redis', () => deps.health.checkRedis()),
      runProbe('Worker', () => deps.health.checkWorker()),
    ]);

    const status =
      postgres.status === 'ok' && redis.status === 'ok' && worker.status === 'ok'
        ? 'ok'
        : 'degraded';

    return healthResponseSchema.parse({
      status,
      checks: { postgres, redis, worker },
      timestamp: new Date().toISOString(),
      version: deps.config.version ?? DEFAULT_SERVER_VERSION,
    });
  });
}
