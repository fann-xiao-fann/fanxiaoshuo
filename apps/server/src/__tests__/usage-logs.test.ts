import type { ApiError, UsageLogsResponse } from '@fanxiaoshuo/shared';
import type { UsageLogRecordInput } from '@fanxiaoshuo/agents';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServerContext } from './helpers/in-memory.js';

type SeedOverrides = Partial<UsageLogRecordInput>;

async function seedLog(
  context: TestServerContext,
  overrides: SeedOverrides = {},
): Promise<string> {
  const record: UsageLogRecordInput = {
    role: 'writer',
    providerId: null,
    modelRef: 'Test Provider/mock-model',
    scene: 'chapter-write',
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0.001,
    latencyMs: 120,
    status: 'success',
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
  const inserted = await context.store.usageLogs.insert(record);
  return inserted.id;
}

describe('GET /api/v1/usage-logs', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('返回时间倒序明细、分页信息与区间汇总', async () => {
    context = await createTestServer();
    await seedLog(context);
    await seedLog(context, {
      role: 'critic',
      scene: 'chapter-review',
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      status: 'error',
      errorCode: 'UPSTREAM_TIMEOUT',
      errorMessage: '上游超时（已脱敏）',
      latencyMs: 20_000,
    });
    await seedLog(context, { inputTokens: 200, outputTokens: 100, estimatedCostUsd: 0.002 });
    const lastId = await seedLog(context, {
      role: 'lorekeeper',
      scene: 'lore-extract',
      inputTokens: 300,
      outputTokens: 150,
      estimatedCostUsd: 0.003,
    });

    const response = await context.app.inject({ method: 'GET', url: '/api/v1/usage-logs' });
    expect(response.statusCode).toBe(200);
    const body = response.json<UsageLogsResponse>();

    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    expect(body.total).toBe(4);
    expect(body.totalPages).toBe(1);
    expect(body.from).toBeNull();
    expect(body.to).toBeNull();
    expect(body.items).toHaveLength(4);
    expect(body.items[0]?.id).toBe(lastId);
    expect(body.summary).toEqual({
      totalRequests: 4,
      successRequests: 3,
      errorRequests: 1,
      totalInputTokens: 600,
      totalOutputTokens: 300,
      totalCostUsd: 0.006,
    });
  });

  it('支持 page / pageSize 分页', async () => {
    context = await createTestServer();
    for (let index = 0; index < 5; index += 1) {
      await seedLog(context, { inputTokens: index * 10 });
    }

    const page2 = await context.app.inject({
      method: 'GET',
      url: '/api/v1/usage-logs?page=2&pageSize=2',
    });
    const body = page2.json<UsageLogsResponse>();
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(2);
    expect(body.total).toBe(5);
    expect(body.totalPages).toBe(3);
    expect(body.items).toHaveLength(2);
    // 倒序：第 2 页对应第 3、2 条（inputTokens 20、10）
    expect(body.items.map((item) => item.inputTokens)).toEqual([20, 10]);
  });

  it('支持 status / role / scene / from / to 筛选并汇总筛选区间', async () => {
    context = await createTestServer();
    await seedLog(context);
    await seedLog(context, {
      role: 'critic',
      scene: 'chapter-review',
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      status: 'error',
      errorCode: 'UPSTREAM_TIMEOUT',
    });
    await seedLog(context, { inputTokens: 200, outputTokens: 100, estimatedCostUsd: 0.002 });
    await seedLog(context, {
      role: 'lorekeeper',
      scene: 'lore-extract',
      inputTokens: 300,
      outputTokens: 150,
      estimatedCostUsd: 0.003,
    });

    const errors = (
      await context.app.inject({ method: 'GET', url: '/api/v1/usage-logs?status=error' })
    ).json<UsageLogsResponse>();
    expect(errors.total).toBe(1);
    expect(errors.summary.errorRequests).toBe(1);
    expect(errors.items[0]?.errorCode).toBe('UPSTREAM_TIMEOUT');

    const writers = (
      await context.app.inject({ method: 'GET', url: '/api/v1/usage-logs?role=writer' })
    ).json<UsageLogsResponse>();
    expect(writers.total).toBe(2);
    expect(writers.summary.totalInputTokens).toBe(300);
    expect(writers.summary.totalCostUsd).toBe(0.003);

    const lore = (
      await context.app.inject({ method: 'GET', url: '/api/v1/usage-logs?scene=lore-extract' })
    ).json<UsageLogsResponse>();
    expect(lore.total).toBe(1);
    expect(lore.items[0]?.role).toBe('lorekeeper');

    const logs = context.store.state.logs;
    const third = logs[2];
    const from = third?.createdAt.toISOString() ?? '';
    const fromFiltered = (
      await context.app.inject({
        method: 'GET',
        url: `/api/v1/usage-logs?from=${encodeURIComponent(from)}`,
      })
    ).json<UsageLogsResponse>();
    expect(fromFiltered.total).toBe(2);
    expect(fromFiltered.from).toBe(from);

    const to = logs[1]?.createdAt.toISOString() ?? '';
    const toFiltered = (
      await context.app.inject({
        method: 'GET',
        url: `/api/v1/usage-logs?to=${encodeURIComponent(to)}`,
      })
    ).json<UsageLogsResponse>();
    expect(toFiltered.total).toBe(2);
    expect(toFiltered.to).toBe(to);
  });

  it('非法查询参数返回结构化 400', async () => {
    context = await createTestServer();

    const inverted = await context.app.inject({
      method: 'GET',
      url: `/api/v1/usage-logs?from=${encodeURIComponent('2025-01-02T00:00:00.000Z')}&to=${encodeURIComponent('2025-01-01T00:00:00.000Z')}`,
    });
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json<ApiError>().code).toBe('VALIDATION_ERROR');

    const tooLarge = await context.app.inject({
      method: 'GET',
      url: '/api/v1/usage-logs?pageSize=500',
    });
    expect(tooLarge.statusCode).toBe(400);

    const badRole = await context.app.inject({
      method: 'GET',
      url: '/api/v1/usage-logs?role=unknown-role',
    });
    expect(badRole.statusCode).toBe(400);
  });
});
