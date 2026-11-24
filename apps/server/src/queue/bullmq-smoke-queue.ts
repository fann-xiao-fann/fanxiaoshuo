import {
  API_ERROR_CODES,
  JOB_RETRY_POLICY,
  QUEUE_NAMES,
  apiErrorCodeSchema,
  smokeJobResultSchema,
  type ApiErrorCode,
  type SmokeJobResult,
  type SmokeJobStatus,
} from '@fanxiaoshuo/shared';
import { Queue, type Job } from 'bullmq';
import type { SmokeJobData, SmokeQueue, SmokeQueueSnapshot } from './types.js';

/** BullMQ 队列任务名（同一队列未来可扩展多种任务类型）。 */
export const SMOKE_JOB_NAME = 'runtime-smoke';

/**
 * `POST /api/v1/runtime/smoke-jobs` 使用的生产队列实现。
 * 重试策略与共享契约 `JOB_RETRY_POLICY` 严格一致（3 次，指数退避 2s）。
 */
export function createBullMqSmokeQueue(options: {
  redisUrl: string;
  queueName?: string;
}): SmokeQueue {
  const queue = new Queue<SmokeJobData, unknown, string>(
    options.queueName ?? QUEUE_NAMES.runtimeSmoke,
    {
      connection: { url: options.redisUrl, maxRetriesPerRequest: null },
      defaultJobOptions: {
        attempts: JOB_RETRY_POLICY.attempts,
        backoff: {
          type: JOB_RETRY_POLICY.backoff.type,
          delay: JOB_RETRY_POLICY.backoff.delay,
        },
        removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
      },
    },
  );

  return {
    async enqueue(input) {
      const job = await queue.add(SMOKE_JOB_NAME, {
        invokeModel: input.invokeModel,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      return {
        jobId: String(job.id),
        createdAt: new Date(job.timestamp),
      };
    },

    async get(jobId): Promise<SmokeQueueSnapshot | null> {
      const job = await queue.getJob(jobId);
      if (!job) {
        return null;
      }
      return toSnapshot(job);
    },

    async close() {
      await queue.close();
    },
  };
}

/** BullMQ Job → 对外快照（含结果 / 错误 / 时间戳，不含任何明文密钥）。 */
async function toSnapshot(job: Job<SmokeJobData>): Promise<SmokeQueueSnapshot> {
  const state = await job.getState();
  const status = mapBullMqState(state);
  const result = parseJobResult(job.returnvalue);
  const errorMessage = job.failedReason ?? null;
  const errorCode = status === 'failed' ? resolveErrorCode(job, errorMessage) : null;

  return {
    jobId: String(job.id),
    status,
    invokeModel: job.data.invokeModel === true,
    note: typeof job.data.note === 'string' && job.data.note.length > 0 ? job.data.note : null,
    attemptsMade: job.attemptsMade,
    createdAt: new Date(job.timestamp),
    startedAt: numberToDate(job.processedOn),
    finishedAt: numberToDate(job.finishedOn),
    result,
    errorCode,
    errorMessage,
  };
}

/** BullMQ 状态 → 共享契约的 4 态（排队 / 运行 / 完成 / 失败）。 */
export function mapBullMqState(state: string): SmokeJobStatus {
  switch (state) {
    case 'active':
      return 'active';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'waiting':
    case 'delayed':
    case 'waiting-children':
    case 'prioritized':
    default:
      return 'queued';
  }
}

function numberToDate(value: number | undefined | null): Date | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value) : null;
}

function parseJobResult(raw: unknown): SmokeJobResult | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = smokeJobResultSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * 失败任务错误码解析：
 * 优先读取任务数据中的显式 `errorCode`（Worker 可写入），其次从 failedReason 中识别错误码字面量。
 */
function resolveErrorCode(job: Job<SmokeJobData>, failedReason: string | null): ApiErrorCode {
  const rawData = job.data as unknown as Record<string, unknown> | undefined;
  const explicit = rawData?.['errorCode'];
  if (typeof explicit === 'string') {
    const parsed = apiErrorCodeSchema.safeParse(explicit);
    if (parsed.success) {
      return parsed.data;
    }
  }

  if (failedReason) {
    for (const code of Object.keys(API_ERROR_CODES) as ApiErrorCode[]) {
      if (failedReason.includes(code)) {
        return code;
      }
    }
  }

  return API_ERROR_CODES.UPSTREAM_ERROR;
}
