import { z } from 'zod';
import { apiErrorCodeSchema } from '../errors.js';
import {
  isoDateTimeSchema,
  nonNegativeIntSchema,
  tokenCountSchema,
  trimmedText,
  usdAmountSchema,
} from './primitives.js';

/** 冒烟任务状态流转：queued → active → completed | failed。 */
export const smokeJobStatusSchema = z.enum(['queued', 'active', 'completed', 'failed']);

export type SmokeJobStatus = z.infer<typeof smokeJobStatusSchema>;

/** BullMQ 队列事件类型（Redis Pub/Sub 与 SSE 复用同一套字面量）。 */
export const JOB_EVENT_TYPES = ['job.queued', 'job.active', 'job.completed', 'job.failed'] as const;

export const jobEventTypeSchema = z.enum(JOB_EVENT_TYPES);

export type JobEventType = z.infer<typeof jobEventTypeSchema>;

/** 状态 → 事件类型映射，Worker 发布事件时统一由此推导。 */
export const JOB_STATUS_TO_EVENT_TYPE: Record<SmokeJobStatus, JobEventType> = {
  queued: 'job.queued',
  active: 'job.active',
  completed: 'job.completed',
  failed: 'job.failed',
};

/** `POST /api/v1/runtime/smoke-jobs` 请求体。 */
export const createSmokeJobSchema = z
  .strictObject({
    /** true = 额外真实调用一次角色绑定模型，验证网关 + 计量全链路 */
    invokeModel: z.boolean().default(false),
    /** 备注，便于在队列日志中识别本次冒烟目的 */
    note: trimmedText(200).optional(),
  })
  .describe('触发 Mastra + BullMQ 全链路冒烟任务');

export type CreateSmokeJobInput = z.infer<typeof createSmokeJobSchema>;
export type CreateSmokeJobInputPayload = z.input<typeof createSmokeJobSchema>;

/** 任务执行结果明细。 */
export const smokeJobResultSchema = z.strictObject({
  /** Mastra 运行时是否成功初始化并执行诊断 Workflow */
  engineOk: z.boolean(),
  /** 是否真实调用了模型 */
  modelTested: z.boolean(),
  replyPreview: z.string().max(2000).nullable(),
  latencyMs: nonNegativeIntSchema.nullable(),
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  estimatedCostUsd: usdAmountSchema,
});

export type SmokeJobResult = z.infer<typeof smokeJobResultSchema>;

/** `GET /api/v1/runtime/smoke-jobs/:jobId` 响应。 */
export const smokeJobDtoSchema = z.strictObject({
  jobId: z.string().min(1).max(128),
  status: smokeJobStatusSchema,
  invokeModel: z.boolean(),
  note: z.string().max(200).nullable(),
  /** 已重试次数（BullMQ attemptsMade） */
  attemptsMade: nonNegativeIntSchema,
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  durationMs: nonNegativeIntSchema.nullable(),
  result: smokeJobResultSchema.nullable(),
  errorCode: apiErrorCodeSchema.nullable(),
  errorMessage: z.string().max(2000).nullable(),
});

export type SmokeJobDto = z.infer<typeof smokeJobDtoSchema>;

/**
 * 任务事件（Worker 发布到 Redis Pub/Sub → Fastify SSE 转发给前端）。
 * `type` 与 `status` 必须自洽，由 `JOB_STATUS_TO_EVENT_TYPE` 保证。
 */
export const jobEventSchema = z
  .strictObject({
    type: jobEventTypeSchema,
    jobId: z.string().min(1).max(128),
    status: smokeJobStatusSchema,
    timestamp: isoDateTimeSchema,
    attemptsMade: nonNegativeIntSchema.default(0),
    /** 进度百分比 0–100，未知为 null */
    progress: z.number().min(0).max(100).nullable().default(null),
    errorCode: apiErrorCodeSchema.nullable().default(null),
    errorMessage: z.string().max(2000).nullable().default(null),
    /** 附加负载（如结果摘要），保持可扩展 */
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => JOB_STATUS_TO_EVENT_TYPE[value.status] === value.type, {
    message: '事件类型与任务状态不匹配',
    path: ['type'],
  })
  .describe('队列任务事件（Redis Pub/Sub + SSE）');

export type JobEvent = z.infer<typeof jobEventSchema>;
export type JobEventPayload = z.input<typeof jobEventSchema>;

/** SSE 推送帧名（EventSource `event:` 字段）。 */
export const SSE_EVENT_NAMES = {
  jobEvent: 'job-event',
  /** 连接建立后的握手帧，前端据此确认订阅成功 */
  ready: 'ready',
  ping: 'ping',
} as const;

export type SseEventName = (typeof SSE_EVENT_NAMES)[keyof typeof SSE_EVENT_NAMES];
