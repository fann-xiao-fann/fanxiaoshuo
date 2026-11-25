import {
  REDIS_CHANNELS,
  WORKFLOW_STATUS_TO_EVENT_TYPE,
  workflowEventSchema,
  type ApiErrorCode,
  type WorkflowEvent,
  type WorkflowEventPayload,
  type WorkflowEventType,
  type WorkflowPauseReason,
  type WorkflowRunStatus,
  type WorkflowStepStage,
  type WorkflowStepStatus,
} from '@fanxiaoshuo/shared';

/** 最小化 Redis Pub/Sub 发布接口（`ioredis` 客户端可直接满足）。 */
export interface WorkflowEventRedis {
  publish(channel: string, message: string): Promise<unknown>;
}

/** 批次事件发布函数：入参为宽松负载，返回经契约校验后的标准事件。 */
export type WorkflowEventPublisher = (
  event: WorkflowEventPayload,
) => Promise<WorkflowEvent>;

/** 批次进度公共字段（批次 / 步骤事件共用）。 */
export interface WorkflowEventRunProgress {
  readonly status: WorkflowRunStatus;
  readonly totalSteps: number;
  readonly completedSteps: number;
  readonly failedSteps: number;
  readonly spentCostUsd: number;
  readonly maxCostUsd: number | null;
}

/** 构造批次事件的入参（`type` 默认由 `status` 推导，避免两者漂移）。 */
export interface WorkflowEventInput extends WorkflowEventRunProgress {
  readonly runId: string;
  readonly bookId: string;
  /** 显式事件类型；省略时由 `status` 推导 */
  readonly type?: WorkflowEventType;
  readonly pauseReason?: WorkflowPauseReason | null;
  readonly stepId?: string | null;
  readonly chapterId?: string | null;
  readonly stepIndex?: number | null;
  readonly stepStatus?: WorkflowStepStatus | null;
  readonly stepStage?: WorkflowStepStage | null;
  readonly criticScore?: number | null;
  readonly errorCode?: ApiErrorCode | null;
  readonly errorMessage?: string | null;
  /** 默认当前时间 */
  readonly timestamp?: Date;
}

/**
 * 由批次状态推导事件类型并补齐默认字段。
 * 若显式传入的 `type` 与 `status` 不自洽，`workflowEventSchema` 不会拦截（两者独立校验），
 * 因此默认路径一律走 `WORKFLOW_STATUS_TO_EVENT_TYPE`，仅「步骤阶段流转」等
 * 复用 `running` 状态的事件才显式指定 `type: 'workflow.step_updated'`。
 */
export function createWorkflowEvent(input: WorkflowEventInput): WorkflowEvent {
  return workflowEventSchema.parse({
    type: input.type ?? WORKFLOW_STATUS_TO_EVENT_TYPE[input.status],
    runId: input.runId,
    bookId: input.bookId,
    status: input.status,
    timestamp: (input.timestamp ?? new Date()).toISOString(),
    totalSteps: input.totalSteps,
    completedSteps: input.completedSteps,
    failedSteps: input.failedSteps,
    spentCostUsd: input.spentCostUsd,
    maxCostUsd: input.maxCostUsd,
    pauseReason: input.pauseReason ?? null,
    stepId: input.stepId ?? null,
    chapterId: input.chapterId ?? null,
    stepIndex: input.stepIndex ?? null,
    stepStatus: input.stepStatus ?? null,
    stepStage: input.stepStage ?? null,
    criticScore: input.criticScore ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
  });
}

/**
 * 构造发布到 `fanxiaoshuo:events:workflows` 的批次事件发布器。
 *
 * 发布前强制走 `workflowEventSchema.parse`，确保 SSE 消费端永远拿到合法事件；
 * 发布失败直接抛出，由调用方决定是否影响批次推进（Worker 侧一律降级为告警，不阻断写作）。
 */
export function createWorkflowEventPublisher(
  redis: WorkflowEventRedis,
  channel: string = REDIS_CHANNELS.workflowEvents,
): WorkflowEventPublisher {
  return async (event: WorkflowEventPayload): Promise<WorkflowEvent> => {
    const parsed = workflowEventSchema.parse(event);
    await redis.publish(channel, JSON.stringify(parsed));
    return parsed;
  };
}
