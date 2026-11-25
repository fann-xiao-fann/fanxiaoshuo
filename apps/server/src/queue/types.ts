import type {
  ApiErrorCode,
  JobEvent,
  SmokeJobResult,
  SmokeJobStatus,
  WorkflowEvent,
} from '@fanxiaoshuo/shared';

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

/* -------------------------------------------------------------------------- */
/*                  Change 4：批量流水线队列与事件总线抽象                  */
/* -------------------------------------------------------------------------- */

/**
 * `novel-workflows` 队列入队结果。
 * BullMQ 任务 ID 由 BullMQ 自动生成（或带随机后缀），**不得固定为 `runId`**：
 * 固定 `jobId` 会因已完成 / 已失败的同名 job 仍在保留窗口内而被 BullMQ 静默忽略，
 * 导致「断点续跑」与「单步重试」永远无法真正重新执行。
 */
export interface WorkflowQueueEnqueueResult {
  readonly jobId: string;
  readonly createdAt: Date;
}

/** 批量流水线队列 Producer（路由仅依赖此接口，测试注入内存假实现）。 */
export interface WorkflowQueue {
  /** 入队一个批次（载荷仅 `{ runId }`，配置与进度以 PostgreSQL 为唯一真相）。 */
  enqueue(runId: string): Promise<WorkflowQueueEnqueueResult>;
  close?(): Promise<void>;
}

/** 批量流水线实时进度事件总线（Redis Pub/Sub → SSE）。 */
export interface WorkflowEventBus {
  publish(event: WorkflowEvent): Promise<void>;
  subscribe(handler: (event: WorkflowEvent) => void): Promise<Unsubscribe>;
  close?(): Promise<void>;
}
