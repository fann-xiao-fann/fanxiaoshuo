import { describe, expect, it } from 'vitest';
import {
  JOB_EVENT_TYPES,
  JOB_STATUS_TO_EVENT_TYPE,
  SSE_EVENT_NAMES,
  createSmokeJobSchema,
  jobEventSchema,
  jobEventTypeSchema,
  smokeJobDtoSchema,
  smokeJobStatusSchema,
} from '../schemas/runtime-job.js';

const TS = '2025-06-07T08:09:10.000Z';

const result = {
  engineOk: true,
  modelTested: true,
  replyPreview: '冒烟任务回复预览',
  latencyMs: 512,
  inputTokens: 12,
  outputTokens: 8,
  estimatedCostUsd: 0.000002,
};

describe('createSmokeJobSchema', () => {
  it('默认不真实调用模型', () => {
    const parsed = createSmokeJobSchema.parse({});
    expect(parsed.invokeModel).toBe(false);
    expect(parsed.note).toBeUndefined();
  });

  it('接受 invokeModel=true 与备注', () => {
    const parsed = createSmokeJobSchema.parse({ invokeModel: true, note: ' 首次冒烟 ' });
    expect(parsed.invokeModel).toBe(true);
    expect(parsed.note).toBe('首次冒烟');
  });

  it('拒绝非法类型与超长备注', () => {
    expect(createSmokeJobSchema.safeParse({ invokeModel: 'yes' }).success).toBe(false);
    expect(createSmokeJobSchema.safeParse({ note: 'x'.repeat(201) }).success).toBe(false);
    expect(createSmokeJobSchema.safeParse({ note: '  ' }).success).toBe(false);
    expect(createSmokeJobSchema.safeParse({ jobId: 'x' }).success).toBe(false);
  });
});

describe('smokeJobStatusSchema / jobEventTypeSchema', () => {
  it('覆盖 queued → active → completed/failed 四态', () => {
    for (const status of ['queued', 'active', 'completed', 'failed']) {
      expect(smokeJobStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(smokeJobStatusSchema.safeParse('waiting').success).toBe(false);
  });

  it('事件类型共 4 种且与状态一一映射', () => {
    expect(JOB_EVENT_TYPES).toEqual(['job.queued', 'job.active', 'job.completed', 'job.failed']);
    for (const [status, type] of Object.entries(JOB_STATUS_TO_EVENT_TYPE)) {
      expect(jobEventTypeSchema.safeParse(type).success).toBe(true);
      expect(JOB_EVENT_TYPES).toContain(type);
      expect(smokeJobStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(jobEventTypeSchema.safeParse('job.retry').success).toBe(false);
  });
});

describe('smokeJobDtoSchema', () => {
  const dto = {
    jobId: '1',
    status: 'completed',
    invokeModel: true,
    note: '首次冒烟',
    attemptsMade: 0,
    createdAt: TS,
    startedAt: TS,
    finishedAt: TS,
    durationMs: 812,
    result,
    errorCode: null,
    errorMessage: null,
  };

  it('接受已完成任务 DTO', () => {
    const parsed = smokeJobDtoSchema.parse(dto);
    expect(parsed.result?.engineOk).toBe(true);
  });

  it('接受排队中任务（结果与时间戳为 null）', () => {
    const parsed = smokeJobDtoSchema.parse({
      ...dto,
      status: 'queued',
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      result: null,
    });
    expect(parsed.result).toBeNull();
  });

  it('接受失败任务并保留脱敏错误', () => {
    const parsed = smokeJobDtoSchema.parse({
      ...dto,
      status: 'failed',
      result: null,
      attemptsMade: 3,
      errorCode: 'UPSTREAM_TIMEOUT',
      errorMessage: '上游请求超时',
    });
    expect(parsed.attemptsMade).toBe(3);
  });

  it('拒绝未知状态、负重试次数与缺失 jobId', () => {
    expect(smokeJobDtoSchema.safeParse({ ...dto, status: 'paused' }).success).toBe(false);
    expect(smokeJobDtoSchema.safeParse({ ...dto, attemptsMade: -1 }).success).toBe(false);
    expect(smokeJobDtoSchema.safeParse({ ...dto, jobId: '' }).success).toBe(false);
  });
});

describe('jobEventSchema', () => {
  it('填充默认字段并接受合法事件', () => {
    const event = jobEventSchema.parse({
      type: 'job.queued',
      jobId: '42',
      status: 'queued',
      timestamp: TS,
    });
    expect(event.attemptsMade).toBe(0);
    expect(event.progress).toBeNull();
    expect(event.errorCode).toBeNull();
    expect(event.errorMessage).toBeNull();
  });

  it('接受带进度与数据负载的运行中事件', () => {
    const event = jobEventSchema.parse({
      type: 'job.active',
      jobId: '42',
      status: 'active',
      timestamp: TS,
      attemptsMade: 1,
      progress: 40,
      data: { stage: 'mastra-init' },
    });
    expect(event.progress).toBe(40);
    expect(event.data).toEqual({ stage: 'mastra-init' });
  });

  it('拒绝事件类型与任务状态不一致', () => {
    const result = jobEventSchema.safeParse({
      type: 'job.completed',
      jobId: '42',
      status: 'failed',
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('拒绝越界进度与未知错误码', () => {
    expect(
      jobEventSchema.safeParse({
        type: 'job.active',
        jobId: '42',
        status: 'active',
        timestamp: TS,
        progress: 140,
      }).success,
    ).toBe(false);
    expect(
      jobEventSchema.safeParse({
        type: 'job.failed',
        jobId: '42',
        status: 'failed',
        timestamp: TS,
        errorCode: 'BOOM',
      }).success,
    ).toBe(false);
  });

  it('SSE 帧名与契约常量稳定', () => {
    expect(SSE_EVENT_NAMES).toEqual({ jobEvent: 'job-event', ready: 'ready', ping: 'ping' });
  });

  it('失败事件必须能携带脱敏错误摘要', () => {
    const event = jobEventSchema.parse({
      type: 'job.failed',
      jobId: '42',
      status: 'failed',
      timestamp: TS,
      errorCode: 'QUEUE_UNAVAILABLE',
      errorMessage: 'Redis 连接中断',
    });
    expect(event.errorCode).toBe('QUEUE_UNAVAILABLE');
  });
});
