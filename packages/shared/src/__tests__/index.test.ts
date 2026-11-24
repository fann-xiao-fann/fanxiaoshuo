import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLES,
  API_ERROR_CODES,
  API_PREFIX,
  JOB_RETRY_POLICY,
  PAGINATION,
  PROVIDER_PROTOCOLS,
  QUEUE_NAMES,
  REDIS_CHANNELS,
  REDIS_KEYS,
  SSE_EVENT_NAMES,
  USAGE_SCENES,
  WORKER_HEARTBEAT,
  agentRoleSchema,
  apiErrorSchema,
  createProviderSchema,
  healthResponseSchema,
  jobEventSchema,
  providerDtoSchema,
  usageLogStatusSchema,
} from '../index.js';

describe('barrel 导出（前后端 / Worker 统一入口）', () => {
  it('导出全部契约常量与 schema', () => {
    expect(AGENT_ROLES).toHaveLength(4);
    expect(PROVIDER_PROTOCOLS).toHaveLength(4);
    expect(Object.keys(API_ERROR_CODES).length).toBeGreaterThan(10);
    expect(agentRoleSchema.safeParse('showrunner').success).toBe(true);
    expect(createProviderSchema).toBeDefined();
    expect(providerDtoSchema).toBeDefined();
    expect(usageLogStatusSchema).toBeDefined();
    expect(healthResponseSchema).toBeDefined();
    expect(jobEventSchema).toBeDefined();
    expect(apiErrorSchema).toBeDefined();
  });
});

describe('运行期常量契约', () => {
  it('REST 前缀统一为 /api/v1', () => {
    expect(API_PREFIX).toBe('/api/v1');
  });

  it('队列名与设计文档一致', () => {
    expect(QUEUE_NAMES.runtimeSmoke).toBe('runtime-smoke');
    expect(new Set(Object.values(QUEUE_NAMES)).size).toBe(Object.values(QUEUE_NAMES).length);
  });

  it('Redis 心跳键 / 事件频道与设计文档一致', () => {
    expect(REDIS_KEYS.workerHeartbeat).toBe('fanxiaoshuo:worker:heartbeat');
    expect(REDIS_CHANNELS.jobEvents).toBe('fanxiaoshuo:events:jobs');
  });

  it('Worker 心跳 TTL 必须大于上报间隔（避免误判离线）', () => {
    expect(WORKER_HEARTBEAT.ttlSeconds * 1000).toBeGreaterThan(WORKER_HEARTBEAT.intervalMs);
  });

  it('重试策略固定为 3 次指数退避', () => {
    expect(JOB_RETRY_POLICY.attempts).toBe(3);
    expect(JOB_RETRY_POLICY.backoff.type).toBe('exponential');
    expect(JOB_RETRY_POLICY.backoff.delay).toBeGreaterThan(0);
  });

  it('分页上限为 100，默认值合法', () => {
    expect(PAGINATION.defaultPage).toBe(1);
    expect(PAGINATION.defaultPageSize).toBeLessThanOrEqual(PAGINATION.maxPageSize);
    expect(PAGINATION.maxPageSize).toBe(100);
  });

  it('用量场景覆盖测通与冒烟任务', () => {
    expect(USAGE_SCENES.connectivityTest).toBe('connectivity-test');
    expect(USAGE_SCENES.smokeJob).toBe('smoke-job');
  });

  it('SSE 帧名可供前端 EventSource 复用', () => {
    expect(SSE_EVENT_NAMES.jobEvent).toBe('job-event');
  });
});
