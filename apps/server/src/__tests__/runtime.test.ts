import type { ApiError, JobEvent, SmokeJobDto } from '@fanxiaoshuo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServerContext } from './helpers/in-memory.js';

describe('/api/v1/runtime/smoke-jobs', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('入队返回 202 + jobId + queued 初始状态，并广播 job.queued 事件', async () => {
    context = await createTestServer();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/runtime/smoke-jobs',
      payload: { invokeModel: true, note: '全链路冒烟' },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json<SmokeJobDto>();
    expect(body.jobId).toBe('job-1');
    expect(body.status).toBe('queued');
    expect(body.invokeModel).toBe(true);
    expect(body.note).toBe('全链路冒烟');
    expect(body.attemptsMade).toBe(0);
    expect(body.startedAt).toBeNull();
    expect(body.finishedAt).toBeNull();
    expect(body.durationMs).toBeNull();
    expect(body.result).toBeNull();
    expect(body.errorCode).toBeNull();

    expect(context.eventBus.published).toHaveLength(1);
    const event = context.eventBus.published[0] as JobEvent;
    expect(event.type).toBe('job.queued');
    expect(event.status).toBe('queued');
    expect(event.jobId).toBe('job-1');
    expect(event.data).toMatchObject({ invokeModel: true, note: '全链路冒烟' });
  });

  it('默认 invokeModel=false，note 可为空', async () => {
    context = await createTestServer();
    const body = (
      await context.app.inject({
        method: 'POST',
        url: '/api/v1/runtime/smoke-jobs',
        payload: {},
      })
    ).json<SmokeJobDto>();
    expect(body.invokeModel).toBe(false);
    expect(body.note).toBeNull();
  });

  it('非法请求体返回 400', async () => {
    context = await createTestServer();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/runtime/smoke-jobs',
      payload: { invokeModel: 'yes', note: 'x'.repeat(300) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ApiError>().code).toBe('VALIDATION_ERROR');
  });

  it('查询任务状态：queued → active → completed，并计算耗时', async () => {
    context = await createTestServer();
    const created = (
      await context.app.inject({
        method: 'POST',
        url: '/api/v1/runtime/smoke-jobs',
        payload: { invokeModel: true },
      })
    ).json<SmokeJobDto>();

    const queued = (
      await context.app.inject({
        method: 'GET',
        url: `/api/v1/runtime/smoke-jobs/${created.jobId}`,
      })
    ).json<SmokeJobDto>();
    expect(queued.status).toBe('queued');

    const startedAt = new Date('2025-01-01T00:00:10.000Z');
    const finishedAt = new Date('2025-01-01T00:00:11.500Z');
    context.smokeQueue.setSnapshot({
      jobId: created.jobId,
      status: 'active',
      invokeModel: true,
      note: null,
      attemptsMade: 1,
      createdAt: new Date(created.createdAt),
      startedAt,
      finishedAt: null,
      result: null,
      errorCode: null,
      errorMessage: null,
    });
    const active = (
      await context.app.inject({
        method: 'GET',
        url: `/api/v1/runtime/smoke-jobs/${created.jobId}`,
      })
    ).json<SmokeJobDto>();
    expect(active.status).toBe('active');
    expect(active.attemptsMade).toBe(1);
    expect(active.startedAt).toBe(startedAt.toISOString());
    expect(active.durationMs).toBeNull();

    context.smokeQueue.setSnapshot({
      jobId: created.jobId,
      status: 'completed',
      invokeModel: true,
      note: null,
      attemptsMade: 1,
      createdAt: new Date(created.createdAt),
      startedAt,
      finishedAt,
      result: {
        engineOk: true,
        modelTested: true,
        replyPreview: 'OK',
        latencyMs: 1200,
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostUsd: 0.002,
      },
      errorCode: null,
      errorMessage: null,
    });
    const completed = (
      await context.app.inject({
        method: 'GET',
        url: `/api/v1/runtime/smoke-jobs/${created.jobId}`,
      })
    ).json<SmokeJobDto>();
    expect(completed.status).toBe('completed');
    expect(completed.durationMs).toBe(1500);
    expect(completed.result?.modelTested).toBe(true);
    expect(completed.result?.replyPreview).toBe('OK');
    expect(completed.finishedAt).toBe(finishedAt.toISOString());
  });

  it('失败任务回传错误码 / 脱敏错误信息', async () => {
    context = await createTestServer();
    context.smokeQueue.setSnapshot({
      jobId: 'job-failed',
      status: 'failed',
      invokeModel: true,
      note: '失败用例',
      attemptsMade: 3,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      startedAt: new Date('2025-01-01T00:00:01.000Z'),
      finishedAt: new Date('2025-01-01T00:00:03.000Z'),
      result: null,
      errorCode: 'UPSTREAM_TIMEOUT',
      errorMessage: '上游请求超时，已终止本次调用。',
    });

    const body = (
      await context.app.inject({
        method: 'GET',
        url: '/api/v1/runtime/smoke-jobs/job-failed',
      })
    ).json<SmokeJobDto>();
    expect(body.status).toBe('failed');
    expect(body.attemptsMade).toBe(3);
    expect(body.errorCode).toBe('UPSTREAM_TIMEOUT');
    expect(body.errorMessage).toContain('超时');
  });

  it('任务不存在返回 404 JOB_NOT_FOUND', async () => {
    context = await createTestServer();
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/runtime/smoke-jobs/does-not-exist',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<ApiError>().code).toBe('JOB_NOT_FOUND');
  });
});
