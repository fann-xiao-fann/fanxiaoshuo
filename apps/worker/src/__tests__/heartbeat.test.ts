import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS, WORKER_HEARTBEAT } from '@fanxiaoshuo/shared';
import { createHeartbeatReporter, workerHeartbeatSchema, type HeartbeatRedis } from '../heartbeat.js';
import { silentWorkerLogger } from '../logger.js';

interface SetCall {
  readonly key: string;
  readonly value: string;
  readonly expiryMode: string;
  readonly ttlSeconds: number;
}

function createRedisMock(
  behavior: { fail?: boolean } = {},
): HeartbeatRedis & { readonly calls: SetCall[] } {
  const calls: SetCall[] = [];
  return {
    calls,
    async set(key, value, expiryMode, ttlSeconds) {
      if (behavior.fail === true) {
        throw new Error('redis connection reset');
      }
      calls.push({ key, value, expiryMode, ttlSeconds });
      return 'OK';
    },
  };
}

describe('createHeartbeatReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('启动立即上报，并每 10 秒刷新（TTL 30s）', async () => {
    const redis = createRedisMock();
    let activeJobs = 2;
    const reporter = createHeartbeatReporter({
      redis,
      concurrency: 4,
      activeJobs: () => activeJobs,
      pid: 4_242,
      logger: silentWorkerLogger,
    });

    await reporter.start();
    expect(reporter.running).toBe(true);
    expect(redis.calls).toHaveLength(1);

    const first = redis.calls[0];
    expect(first?.key).toBe(REDIS_KEYS.workerHeartbeat);
    expect(first?.expiryMode).toBe('EX');
    expect(first?.ttlSeconds).toBe(WORKER_HEARTBEAT.ttlSeconds);
    expect(WORKER_HEARTBEAT.ttlSeconds).toBe(30);

    const firstPayload = workerHeartbeatSchema.parse(JSON.parse(first?.value ?? '{}'));
    expect(firstPayload).toEqual({
      pid: 4_242,
      startedAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-01-02T03:04:05.000Z',
      activeJobs: 2,
      concurrency: 4,
      status: 'ok',
    });

    // 第一次刷新：10 秒后，活跃任务数实时采样为 3
    activeJobs = 3;
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT.intervalMs);
    expect(redis.calls).toHaveLength(2);
    const secondPayload = workerHeartbeatSchema.parse(
      JSON.parse(redis.calls[1]?.value ?? '{}'),
    );
    expect(secondPayload.updatedAt).toBe('2026-01-02T03:04:15.000Z');
    expect(secondPayload.startedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(secondPayload.activeJobs).toBe(3);

    // 第二次刷新
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT.intervalMs);
    expect(redis.calls).toHaveLength(3);
    expect(
      workerHeartbeatSchema.parse(JSON.parse(redis.calls[2]?.value ?? '{}')).updatedAt,
    ).toBe('2026-01-02T03:04:25.000Z');
  });

  it('stop() 清理定时器后不再写入，重复 start() 不会叠加多个定时器', async () => {
    const redis = createRedisMock();
    const reporter = createHeartbeatReporter({
      redis,
      concurrency: 3,
      pid: 1,
      logger: silentWorkerLogger,
    });

    await reporter.start();
    await reporter.start();
    expect(redis.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT.intervalMs);
    expect(redis.calls).toHaveLength(2);

    reporter.stop();
    expect(reporter.running).toBe(false);

    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT.intervalMs * 5);
    expect(redis.calls).toHaveLength(2);

    // 停机后可重新启动，仍只保留单一间隔
    await reporter.start();
    expect(reporter.running).toBe(true);
    expect(redis.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT.intervalMs);
    expect(redis.calls).toHaveLength(4);
  });

  it('Redis 写入失败只返回 null，不抛出（不阻断队列消费）', async () => {
    const redis = createRedisMock({ fail: true });
    const reporter = createHeartbeatReporter({
      redis,
      concurrency: 3,
      logger: silentWorkerLogger,
    });

    await expect(reporter.reportOnce()).resolves.toBeNull();
    await expect(reporter.start()).resolves.toBeUndefined();
    expect(reporter.running).toBe(true);
    reporter.stop();
  });
});
