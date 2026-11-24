import { describe, expect, it } from 'vitest';
import {
  usageLogDtoSchema,
  usageLogsQuerySchema,
  usageLogsResponseSchema,
  usageLogStatusSchema,
  usageSummarySchema,
} from '../schemas/usage-log.js';

const UUID = '55555555-5555-4555-8555-555555555555';
const TS = '2025-04-05T06:07:08.000Z';

const logDto = {
  id: UUID,
  role: 'writer',
  providerId: UUID,
  modelRef: 'relay/deepseek-chat',
  scene: 'connectivity-test',
  inputTokens: 128,
  outputTokens: 256,
  estimatedCostUsd: 0.000321,
  latencyMs: 940,
  status: 'success',
  errorCode: null,
  errorMessage: null,
  createdAt: TS,
};

describe('usageLogStatusSchema', () => {
  it('只允许 success / error', () => {
    expect(usageLogStatusSchema.safeParse('success').success).toBe(true);
    expect(usageLogStatusSchema.safeParse('error').success).toBe(true);
    expect(usageLogStatusSchema.safeParse('pending').success).toBe(false);
  });
});

describe('usageLogDtoSchema', () => {
  it('接受成功日志（role/provider 可为 null）', () => {
    expect(usageLogDtoSchema.parse(logDto).modelRef).toBe('relay/deepseek-chat');
    expect(
      usageLogDtoSchema.safeParse({
        ...logDto,
        role: null,
        providerId: null,
        modelRef: null,
        latencyMs: null,
        status: 'error',
        errorCode: 'UPSTREAM_AUTH_ERROR',
        errorMessage: '上游鉴权失败（已脱敏）',
      }).success,
    ).toBe(true);
  });

  it('拒绝负 Token / 未知状态 / 未知错误码', () => {
    expect(usageLogDtoSchema.safeParse({ ...logDto, inputTokens: -1 }).success).toBe(false);
    expect(usageLogDtoSchema.safeParse({ ...logDto, status: 'retry' }).success).toBe(false);
    expect(usageLogDtoSchema.safeParse({ ...logDto, errorCode: 'NOPE' }).success).toBe(false);
  });

  it('拒绝携带明文密钥字段的日志对象', () => {
    expect(usageLogDtoSchema.safeParse({ ...logDto, apiKey: 'sk-leak' }).success).toBe(false);
  });
});

describe('usageLogsQuerySchema', () => {
  it('空查询串填充默认分页', () => {
    const parsed = usageLogsQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(20);
    expect(parsed.status).toBeUndefined();
  });

  it('接受字符串形式数值并强制转换', () => {
    const parsed = usageLogsQuerySchema.parse({ page: '3', pageSize: '50' });
    expect(parsed.page).toBe(3);
    expect(parsed.pageSize).toBe(50);
  });

  it('空字符串参数视为未传（回落到默认值）', () => {
    const parsed = usageLogsQuerySchema.parse({ page: '', pageSize: '', role: undefined });
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(20);
  });

  it('支持状态 / 角色 / 场景 / 时间范围筛选', () => {
    const parsed = usageLogsQuerySchema.parse({
      status: 'error',
      role: 'critic',
      scene: 'smoke-job',
      from: '2025-01-01T00:00:00.000Z',
      to: '2025-01-31T23:59:59.000Z',
    });
    expect(parsed.status).toBe('error');
    expect(parsed.role).toBe('critic');
    expect(parsed.scene).toBe('smoke-job');
  });

  it('拒绝 page=0、pageSize 超上限与非法状态', () => {
    expect(usageLogsQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(usageLogsQuerySchema.safeParse({ page: -1 }).success).toBe(false);
    expect(usageLogsQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(usageLogsQuerySchema.safeParse({ status: 'ok' }).success).toBe(false);
    expect(usageLogsQuerySchema.safeParse({ role: 'nobody' }).success).toBe(false);
  });

  it('拒绝 from 晚于 to 的时间区间', () => {
    const result = usageLogsQuerySchema.safeParse({
      from: '2025-02-01T00:00:00.000Z',
      to: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('拒绝非法时间格式', () => {
    expect(usageLogsQuerySchema.safeParse({ from: '2025-01-01' }).success).toBe(false);
  });
});

describe('usageSummarySchema / usageLogsResponseSchema', () => {
  const summary = {
    totalRequests: 10,
    successRequests: 8,
    errorRequests: 2,
    totalInputTokens: 1200,
    totalOutputTokens: 3400,
    totalCostUsd: 0.0123,
  };

  it('汇总字段全部为非负数', () => {
    expect(usageSummarySchema.parse(summary).totalRequests).toBe(10);
    expect(usageSummarySchema.safeParse({ ...summary, errorRequests: -1 }).success).toBe(false);
  });

  it('分页响应包含明细、分页信息与汇总', () => {
    const response = usageLogsResponseSchema.parse({
      items: [logDto],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
      summary,
      from: null,
      to: null,
    });
    expect(response.items[0]?.scene).toBe('connectivity-test');
    expect(response.summary.totalCostUsd).toBeCloseTo(0.0123);
  });

  it('拒绝缺失 summary 或非法分页的响应', () => {
    expect(
      usageLogsResponseSchema.safeParse({
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 0,
        from: null,
        to: null,
      }).success,
    ).toBe(false);
    expect(
      usageLogsResponseSchema.safeParse({
        items: [],
        page: 0,
        pageSize: 20,
        total: 0,
        totalPages: 0,
        summary,
        from: null,
        to: null,
      }).success,
    ).toBe(false);
  });
});
