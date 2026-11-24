import { describe, expect, it } from 'vitest';
import {
  componentHealthSchema,
  componentStatusSchema,
  healthResponseSchema,
  healthStatusSchema,
  okComponentHealth,
} from '../schemas/health.js';

const TS = '2025-05-06T07:08:09.000Z';

const downComponent = {
  status: 'down',
  latencyMs: 12,
  message: 'connect ECONNREFUSED 127.0.0.1:5432',
  lastHeartbeatAt: null,
  activeJobs: null,
};

describe('componentStatusSchema', () => {
  it('允许 ok / degraded / down / unknown', () => {
    for (const status of ['ok', 'degraded', 'down', 'unknown']) {
      expect(componentStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(componentStatusSchema.safeParse('healthy').success).toBe(false);
  });

  it('healthStatusSchema 只允许 ok / degraded', () => {
    expect(healthStatusSchema.safeParse('ok').success).toBe(true);
    expect(healthStatusSchema.safeParse('degraded').success).toBe(true);
    expect(healthStatusSchema.safeParse('down').success).toBe(false);
  });
});

describe('componentHealthSchema', () => {
  it('接受带诊断信息的失败组件', () => {
    expect(componentHealthSchema.parse(downComponent).status).toBe('down');
  });

  it('接受带心跳信息的 Worker 组件', () => {
    const worker = componentHealthSchema.parse({
      status: 'ok',
      latencyMs: 1,
      message: null,
      lastHeartbeatAt: TS,
      activeJobs: 2,
    });
    expect(worker.activeJobs).toBe(2);
  });

  it('拒绝非法状态与负数延迟', () => {
    expect(componentHealthSchema.safeParse({ ...downComponent, status: 'nope' }).success).toBe(false);
    expect(componentHealthSchema.safeParse({ ...downComponent, latencyMs: -5 }).success).toBe(false);
  });

  it('okComponentHealth 生成默认健康结构并可覆写', () => {
    const health = okComponentHealth();
    expect(health).toEqual({
      status: 'ok',
      latencyMs: 0,
      message: null,
      lastHeartbeatAt: null,
      activeJobs: null,
    });
    expect(okComponentHealth({ latencyMs: 7 }).latencyMs).toBe(7);
  });
});

describe('healthResponseSchema', () => {
  const base = {
    status: 'ok',
    checks: {
      postgres: okComponentHealth({ latencyMs: 4 }),
      redis: okComponentHealth({ latencyMs: 1 }),
      worker: okComponentHealth({ lastHeartbeatAt: TS, activeJobs: 0 }),
    },
    timestamp: TS,
  };

  it('接受全链路健康响应', () => {
    const parsed = healthResponseSchema.parse(base);
    expect(parsed.checks.worker.lastHeartbeatAt).toBe(TS);
  });

  it('接受降级响应并保留组件失败原因', () => {
    const parsed = healthResponseSchema.parse({
      ...base,
      status: 'degraded',
      checks: { ...base.checks, redis: downComponent },
    });
    expect(parsed.status).toBe('degraded');
    expect(parsed.checks.redis.message).toContain('ECONNREFUSED');
  });

  it('拒绝缺失组件或未知顶层状态', () => {
    expect(healthResponseSchema.safeParse({ ...base, status: 'down' }).success).toBe(false);
    expect(
      healthResponseSchema.safeParse({ ...base, checks: { postgres: base.checks.postgres } }).success,
    ).toBe(false);
  });

  it('拒绝非 ISO 时间戳', () => {
    expect(healthResponseSchema.safeParse({ ...base, timestamp: 1700000000000 }).success).toBe(false);
  });
});
