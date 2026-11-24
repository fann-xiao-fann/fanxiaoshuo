import type { ApiErrorCode, JobEvent, SmokeJobResult, SmokeJobStatus } from '@fanxiaoshuo/shared';

/**
 * 队列与事件总线抽象。
 * 路由只依赖这些接口，生产环境由 BullMQ / Redis 实现，测试环境用内存假实现。
 */

/** `runtime-smoke` 队列负载（Worker 消费端按此结构解析）。 */
export interface SmokeJobData {
  readonly invokeModel: boolean;
  readonly note?: string | undefined;
}

export interface EnqueueSmokeJobInput {
  readonly invokeModel: boolean;
  readonly note?: string | undefined;
}

/** 队列任务当前快照（由 BullMQ Job 投影而来）。 */
export interface SmokeQueueSnapshot {
  readonly jobId: string;
  readonly status: SmokeJobStatus;
  readonly invokeModel: boolean;
  readonly note: string | null;
  readonly attemptsMade: number;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly result: SmokeJobResult | null;
  readonly errorCode: ApiErrorCode | null;
  readonly errorMessage: string | null;
}

export interface SmokeQueue {
  enqueue(input: EnqueueSmokeJobInput): Promise<{ jobId: string; createdAt: Date }>;
  get(jobId: string): Promise<SmokeQueueSnapshot | null>;
  close?(): Promise<void>;
}

export type Unsubscribe = () => Promise<void>;

/** Redis Pub/Sub 任务事件总线（SSE 订阅方）。 */
export interface JobEventBus {
  publish(event: JobEvent): Promise<void>;
  subscribe(handler: (event: JobEvent) => void): Promise<Unsubscribe>;
  close?(): Promise<void>;
}
