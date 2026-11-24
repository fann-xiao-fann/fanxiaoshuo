import {
  API_ERROR_CODES,
  JOB_RETRY_POLICY,
  USAGE_SCENES,
  agentRoleSchema,
  smokeJobResultSchema,
  type AgentRole,
  type ApiErrorCode,
  type JobEventPayload,
  type SmokeJobResult,
} from '@fanxiaoshuo/shared';
import {
  sanitizeErrorMessage,
  toSanitizedGatewayError,
  type FanXiaoshuoRuntime,
  type ResolvedModelConfig,
  type SmokeWorkflowInput,
  type SmokeWorkflowResult,
} from '@fanxiaoshuo/agents';
import type { Job } from 'bullmq';
import { z } from 'zod';
import { WorkerJobError, isWorkerJobError } from '../errors.js';
import type { JobEventPublisher } from '../events/job-events.js';
import type { WorkerLogger } from '../logger.js';
import type { ModelSelector } from '../db/model-repository.js';

/** 冒烟任务执行模式。 */
export const smokeJobModeSchema = z.enum(['echo', 'live']);

export type SmokeJobMode = z.infer<typeof smokeJobModeSchema>;

/**
 * `runtime-smoke` 队列的任务负载契约（Worker 消费侧）。
 *
 * 同时兼容两种入队风格：
 * - 服务端直接沿用共享 `CreateSmokeJobInput`（`invokeModel` + `note`）；
 * - 后续 / 测试使用显式 `mode`、`modelId`、`role`、`message`。
 *
 * 说明：使用非 strict object，未知字段会被剥离而非报错，
 * 以免服务端追加审计字段时导致 Worker 拒绝任务。
 */
export const smokeJobPayloadSchema = z
  .object({
    /** 显式模式，优先级高于 `invokeModel` */
    mode: smokeJobModeSchema.optional(),
    /** 共享契约字段：true = 真实调用一次绑定模型 */
    invokeModel: z.boolean().optional(),
    /** 与 API 任务 ID 对齐（缺省时使用 BullMQ job.id） */
    jobId: z.string().min(1).max(128).optional(),
    note: z.string().trim().max(200).nullable().optional(),
    /** 自定义冒烟提示词 */
    message: z.string().trim().min(1).max(2000).optional(),
    /** `llm_models.id`（uuid）或上游 `model_id` */
    modelId: z.string().trim().min(1).max(128).optional(),
    /** 角色绑定选择器 */
    role: agentRoleSchema.optional(),
    /** 仅测试用：前 N 次尝试抛出瞬时错误，用于验证指数退避重试上限 */
    simulateFailTimes: z.number().int().min(0).max(10).optional(),
  })
  .describe('runtime-smoke 队列负载');

export type SmokeJobPayload = z.infer<typeof smokeJobPayloadSchema>;

/** 归一化后的任务负载（模式已解析）。 */
export interface NormalizedSmokeJobPayload {
  readonly mode: SmokeJobMode;
  readonly jobId: string | null;
  readonly note: string | null;
  readonly message: string | null;
  readonly modelId: string | null;
  readonly role: AgentRole | null;
  readonly simulateFailTimes: number;
}

/**
 * 解析并归一化任务负载。
 * `mode` 缺省时由 `invokeModel` 推导（默认 `echo`，即不产生费用）。
 */
export function normalizeSmokeJobPayload(
  raw: unknown,
  options: { jobId?: string } = {},
): NormalizedSmokeJobPayload {
  const parsed = smokeJobPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? '(root)';
    throw new WorkerJobError(
      `冒烟任务负载非法：字段 ${field} 未通过校验。`,
      API_ERROR_CODES.VALIDATION_ERROR,
    );
  }
  const payload = parsed.data;
  return {
    mode: payload.mode ?? (payload.invokeModel === true ? 'live' : 'echo'),
    jobId: payload.jobId ?? options.jobId ?? null,
    note: payload.note ?? null,
    message: payload.message ?? null,
    modelId: payload.modelId ?? null,
    role: payload.role ?? null,
    simulateFailTimes: payload.simulateFailTimes ?? 0,
  };
}

/** 与 BullMQ 解耦的任务上下文（单元测试无需构造真实 `Job`）。 */
export interface SmokeJobContext {
  readonly jobId: string;
  /** BullMQ `job.attemptsMade`：本次执行前已失败的次数（0 表示首次执行） */
  readonly attemptsMade: number;
  /** 最大尝试次数（含首次），来自 `job.opts.attempts` */
  readonly maxAttempts: number;
  readonly data: unknown;
}

/** 可注入的运行时能力（生产为 Mastra 门面，测试为轻量 Fake）。 */
export type SmokeJobRuntime = Pick<FanXiaoshuoRuntime, 'runSmokeWorkflow'>;

/** 处理器依赖（全部可注入，便于无 Redis / 无 PG 的单元测试）。 */
export interface SmokeJobProcessorDeps {
  readonly runtime: SmokeJobRuntime;
  readonly resolveModelConfig: (selector: ModelSelector) => Promise<ResolvedModelConfig>;
  readonly publishEvent: JobEventPublisher;
  /** 毫秒时间源，默认 `Date.now`（测试注入递增时钟） */
  readonly now?: () => number;
  readonly logger?: WorkerLogger;
}

export type SmokeJobProcessor = (context: SmokeJobContext) => Promise<SmokeJobResult>;

/**
 * 构造 `runtime-smoke` 任务处理器。
 *
 * 状态流转：`active` → `completed` | `failed`，事件严格符合共享 `jobEventSchema`：
 * - `active`：任务开始执行
 * - `completed`：成功，携带 `result` 与 `latencyMs`
 * - `failed`：失败，携带脱敏 `errorMessage` 与 `attemptsMade` / `maxAttempts` 信息
 *
 * 失败时重新抛出**已脱敏**的 `WorkerJobError`，让 BullMQ 按指数退避重试，
 * 同时保证 BullMQ 的 `failedReason` 不泄露明文 API Key。
 */
export function createSmokeJobProcessor(deps: SmokeJobProcessorDeps): SmokeJobProcessor {
  const now = deps.now ?? (() => Date.now());

  const safePublish = async (event: JobEventPayload): Promise<void> => {
    try {
      await deps.publishEvent(event);
    } catch (error) {
      // 事件通道故障不应阻断任务本身；脱敏后记录即可。
      deps.logger?.warn('[worker] 任务事件发布失败', {
        jobId: event.jobId,
        type: event.type,
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  };

  return async (context: SmokeJobContext): Promise<SmokeJobResult> => {
    const attemptNumber = context.attemptsMade + 1;
    const maxAttempts = Math.max(1, context.maxAttempts);
    let jobId = context.jobId;
    let mode: SmokeJobMode | null = null;
    /** live 模式下解析出的明文 Key 仅用于错误脱敏，绝不进入事件 / 日志 */
    const redaction: { apiKey: string | null } = { apiKey: null };

    try {
      const payload = normalizeSmokeJobPayload(context.data, { jobId });
      jobId = payload.jobId ?? jobId;
      mode = payload.mode;

      await safePublish({
        type: 'job.active',
        jobId,
        status: 'active',
        timestamp: new Date(now()).toISOString(),
        attemptsMade: context.attemptsMade,
        progress: 10,
        errorCode: null,
        errorMessage: null,
        data: {
          mode,
          attempt: attemptNumber,
          maxAttempts,
          ...(payload.note === null ? {} : { note: payload.note }),
        },
      });

      // 测试钩子：模拟瞬时故障，用于验证指数退避与重试上限。
      if (payload.simulateFailTimes > 0 && context.attemptsMade < payload.simulateFailTimes) {
        throw new WorkerJobError(
          `模拟瞬时故障（第 ${attemptNumber} 次尝试，计划失败 ${payload.simulateFailTimes} 次）。`,
          API_ERROR_CODES.UPSTREAM_ERROR,
        );
      }

      const startedAt = now();
      const runResult = await executeSmokeWorkflow(payload, deps, (config) => {
        redaction.apiKey = config.apiKey;
      });
      const latencyMs = Math.max(0, Math.trunc(now() - startedAt));

      const result = buildSmokeJobResult(runResult, payload.mode, latencyMs);

      await safePublish({
        type: 'job.completed',
        jobId,
        status: 'completed',
        timestamp: new Date(now()).toISOString(),
        attemptsMade: context.attemptsMade,
        progress: 100,
        errorCode: null,
        errorMessage: null,
        data: {
          result,
          latencyMs,
          mode: payload.mode,
          scene: USAGE_SCENES.smokeJob,
        },
      });

      return result;
    } catch (error) {
      const sanitized = sanitizeJobError(error, redaction.apiKey);
      await safePublish({
        type: 'job.failed',
        jobId,
        status: 'failed',
        timestamp: new Date(now()).toISOString(),
        attemptsMade: attemptNumber,
        progress: null,
        errorCode: sanitized.code,
        errorMessage: sanitized.message,
        data: {
          mode,
          attempt: attemptNumber,
          maxAttempts,
          willRetry: attemptNumber < maxAttempts,
          final: attemptNumber >= maxAttempts,
        },
      });

      // 重抛脱敏错误：BullMQ 只保存该消息作为 failedReason。
      throw new WorkerJobError(sanitized.message, sanitized.code);
    }
  };
}

/** 执行 Mastra 冒烟工作流（echo 不产生费用；live 经模型网关真实调用）。 */
async function executeSmokeWorkflow(
  payload: NormalizedSmokeJobPayload,
  deps: SmokeJobProcessorDeps,
  onModelConfigResolved: (config: ResolvedModelConfig) => void,
): Promise<SmokeWorkflowResult> {
  const input: SmokeWorkflowInput = {
    mode: payload.mode,
    ...(payload.message === null ? {} : { message: payload.message }),
  };

  if (payload.mode === 'echo') {
    return deps.runtime.runSmokeWorkflow(input);
  }

  const selector: ModelSelector = {
    ...(payload.modelId === null ? {} : { modelId: payload.modelId }),
    ...(payload.role === null ? {} : { role: payload.role }),
  };
  const modelConfig = await deps.resolveModelConfig(selector);
  onModelConfigResolved(modelConfig);

  return deps.runtime.runSmokeWorkflow({ ...input, mode: 'live', modelConfig });
}

/** 把 Mastra 结果投影为共享契约 `SmokeJobResult`（经 Zod 校验后返回）。 */
function buildSmokeJobResult(
  runResult: SmokeWorkflowResult,
  mode: SmokeJobMode,
  latencyMs: number,
): SmokeJobResult {
  const replyPreview =
    runResult.replyPreview === null
      ? null
      : runResult.replyPreview.length > 2000
        ? runResult.replyPreview.slice(0, 2000)
        : runResult.replyPreview;

  return smokeJobResultSchema.parse({
    engineOk: true,
    modelTested: mode === 'live',
    replyPreview,
    latencyMs,
    inputTokens: runResult.inputTokens,
    outputTokens: runResult.outputTokens,
    estimatedCostUsd: runResult.estimatedCostUsd,
  });
}

/** 归一化错误：分类 + 脱敏 + 映射共享错误码。 */
function sanitizeJobError(
  error: unknown,
  apiKey: string | null,
): { readonly code: ApiErrorCode; readonly message: string } {
  const secrets = apiKey === null ? [] : [apiKey];
  const message = sanitizeErrorMessage(error, secrets);
  if (isWorkerJobError(error)) {
    return { code: error.code, message };
  }
  return { code: toSanitizedGatewayError(error, secrets).code, message };
}

/**
 * BullMQ 适配器：把真实 `Job` 投影为与队列解耦的 `SmokeJobContext`。
 * 最大尝试次数优先取队列任务自身 `opts.attempts`，缺省回退到共享默认策略。
 */
export function createBullMqSmokeJobHandler(
  processor: SmokeJobProcessor,
): (job: Job<unknown, SmokeJobResult>) => Promise<SmokeJobResult> {
  return async (job) => {
    const jobId = job.id ?? `smoke-${Date.now()}`;
    const maxAttempts = normalizeMaxAttempts(job.opts.attempts);
    return processor({
      jobId,
      attemptsMade: Math.max(0, Math.trunc(job.attemptsMade)),
      maxAttempts,
      data: job.data,
    });
  };
}

/** 任务重试上限归一化（防御非法配置导致无限重试）。 */
export function normalizeMaxAttempts(attempts: number | undefined): number {
  if (typeof attempts !== 'number' || !Number.isFinite(attempts) || attempts <= 0) {
    return JOB_RETRY_POLICY.attempts;
  }
  return Math.min(Math.trunc(attempts), 20);
}
