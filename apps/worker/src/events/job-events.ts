import {
  JOB_STATUS_TO_EVENT_TYPE,
  REDIS_CHANNELS,
  jobEventSchema,
  type ApiErrorCode,
  type JobEvent,
  type JobEventPayload,
  type SmokeJobStatus,
} from '@fanxiaoshuo/shared';

/** 最小化 Redis Pub/Sub 发布接口（`ioredis` 客户端可直接满足）。 */
export interface JobEventRedis {
  publish(channel: string, message: string): Promise<unknown>;
}

/** 事件发布函数：入参为宽松负载，返回经契约校验后的标准事件。 */
export type JobEventPublisher = (event: JobEventPayload) => Promise<JobEvent>;

/** 构造任务事件的入参（`type` 由 `status` 自动推导，避免两者漂移）。 */
export interface JobEventInput {
  readonly jobId: string;
  readonly status: SmokeJobStatus;
  readonly attemptsMade?: number;
  readonly progress?: number | null;
  readonly errorCode?: ApiErrorCode | null;
  readonly errorMessage?: string | null;
  readonly data?: Record<string, unknown>;
  /** 默认当前时间 */
  readonly timestamp?: Date;
}

/**
 * 由状态推导事件类型并补齐默认字段。
 * 若 `type` 与 `status` 不自洽，`jobEventSchema` 会直接抛错（契约红线）。
 */
export function createJobEvent(input: JobEventInput): JobEvent {
  return jobEventSchema.parse({
    type: JOB_STATUS_TO_EVENT_TYPE[input.status],
    jobId: input.jobId,
    status: input.status,
    timestamp: (input.timestamp ?? new Date()).toISOString(),
    attemptsMade: input.attemptsMade ?? 0,
    progress: input.progress ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    ...(input.data === undefined ? {} : { data: input.data }),
  });
}

/**
 * 构造发布到 `fanxiaoshuo:events:jobs` 的发布器。
 *
 * 发布前强制走 `jobEventSchema.parse`，确保 SSE 消费端永远拿到合法事件；
 * 发布失败直接抛出，由调用方决定是否影响任务重试。
 */
export function createJobEventPublisher(
  redis: JobEventRedis,
  channel: string = REDIS_CHANNELS.jobEvents,
): JobEventPublisher {
  return async (event: JobEventPayload): Promise<JobEvent> => {
    const parsed = jobEventSchema.parse(event);
    await redis.publish(channel, JSON.stringify(parsed));
    return parsed;
  };
}
