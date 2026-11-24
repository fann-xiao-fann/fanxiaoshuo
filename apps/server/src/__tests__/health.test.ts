import type { ComponentHealth, HealthResponse } from '@fanxiaoshuo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPostgresHealthProbe,
  createRedisHealthProbe,
  createWorkerHealthProbe,
  type HealthProbes,
} from '../health/probes.js';
import {
  createHealthyProbes,
  createTestServer,
  type TestServerContext,
} from './helpers/in-memory.js';

const DOWN_REDIS: ComponentHealth = {
  status: 'down',
  latencyMs: 4,
  message: 'connect ECONNREFUSED 127.0.0.1:6379',
  lastHeartbeatAt: null,
  activeJobs: null,
};

describe('GET /api/v1/health', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('全部组件健康时返回 200 ok 与探测延迟', async () => {
    context = await createTestServer();
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json<HealthResponse>();
    expect(body.status).toBe('ok');
    expect(body.checks.postgres.status).toBe('ok');
    expect(body.checks.redis.status).toBe('ok');
    expect(body.checks.worker.status).toBe('ok');
    expect(body.checks.worker.activeJobs).toBe(0);
    expect(body.version).toBe('0.1.0-test');
    expect(Number.isNaN(new Date(body.timestamp).getTime())).toBe(false);
  });

  it('Redis 离线时返回 200 degraded 与组件诊断，而非 500', async () => {
    const health: HealthProbes = {
      ...createHealthyProbes(),
      checkRedis: async () => DOWN_REDIS,
    };
    context = await createTestServer({ health });
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json<HealthResponse>();
    expect(body.status).toBe('degraded');
    expect(body.checks.redis.status).toBe('down');
    expect(body.checks.redis.message).toContain('ECONNREFUSED');
    expect(body.checks.postgres.status).toBe('ok');
  });

  it('Worker 心跳过期时 status 为 degraded', async () => {
    const health: HealthProbes = {
      ...createHealthyProbes(),
      checkWorker: async () => ({
        status: 'degraded',
        latencyMs: 1,
        message: 'Worker 心跳已过期：最近上报距今 45s（阈值 30s）。',
        lastHeartbeatAt: new Date(Date.now() - 45_000).toISOString(),
        activeJobs: 0,
      }),
    };
    context = await createTestServer({ health });
    const body = (
      await context.app.inject({ method: 'GET', url: '/api/v1/health' })
    ).json<HealthResponse>();
    expect(body.status).toBe('degraded');
    expect(body.checks.worker.status).toBe('degraded');
    expect(body.checks.worker.lastHeartbeatAt).not.toBeNull();
  });

  it('探针意外抛错时兜底为 down，不冒泡成 500', async () => {
    const health: HealthProbes = {
      checkPostgres: async () => {
        throw new Error('pg pool crashed');
      },
      checkRedis: async () => {
        throw new Error('redis crashed');
      },
      checkWorker: async () => {
        throw new Error('worker probe crashed');
      },
    };
    context = await createTestServer({ health });
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json<HealthResponse>();
    expect(body.status).toBe('degraded');
    expect(body.checks.postgres.status).toBe('down');
    expect(body.checks.postgres.message).toContain('pg pool crashed');
  });
});

describe('健康探针实现', () => {
  it('PostgreSQL：SELECT 1 成功 / 抛错', async () => {
    const ok = createPostgresHealthProbe({ query: async () => [{ '?column?': 1 }] });
    expect((await ok()).status).toBe('ok');

    const failing = createPostgresHealthProbe({
      query: async () => {
        throw new Error('connection refused');
      },
    });
    const failed = await failing();
    expect(failed.status).toBe('down');
    expect(failed.message).toContain('connection refused');
  });

  it('Redis：PONG / 异常回复 / 连接失败', async () => {
    const ok = createRedisHealthProbe({ ping: async () => 'PONG', get: async () => null });
    expect((await ok()).status).toBe('ok');

    const degraded = createRedisHealthProbe({ ping: async () => 'NOAUTH', get: async () => null });
    expect((await degraded()).status).toBe('degraded');

    const down = createRedisHealthProbe({
      ping: async () => {
        throw new Error('ECONNREFUSED');
      },
      get: async () => null,
    });
    expect((await down()).status).toBe('down');
  });

  it('Worker 心跳：新鲜 / 过期 / 缺失 / 非法 JSON', async () => {
    const now = Date.parse('2025-01-01T00:00:10.000Z');
    const options = { now: () => now };

    const fresh = createWorkerHealthProbe(
      {
        ping: async () => 'PONG',
        get: async () =>
          JSON.stringify({ timestamp: new Date(now - 5_000).toISOString(), activeJobs: 2 }),
      },
      options,
    );
    const freshHealth = await fresh();
    expect(freshHealth.status).toBe('ok');
    expect(freshHealth.activeJobs).toBe(2);
    expect(freshHealth.lastHeartbeatAt).toBe(new Date(now - 5_000).toISOString());

    const stale = createWorkerHealthProbe(
      {
        ping: async () => 'PONG',
        get: async () =>
          JSON.stringify({ timestamp: new Date(now - 45_000).toISOString(), activeJobs: 1 }),
      },
      options,
    );
    expect((await stale()).status).toBe('degraded');

    const missing = createWorkerHealthProbe(
      { ping: async () => 'PONG', get: async () => null },
      options,
    );
    expect((await missing()).status).toBe('down');

    const malformed = createWorkerHealthProbe(
      { ping: async () => 'PONG', get: async () => 'not-json' },
      options,
    );
    expect((await malformed()).status).toBe('degraded');
  });
});
