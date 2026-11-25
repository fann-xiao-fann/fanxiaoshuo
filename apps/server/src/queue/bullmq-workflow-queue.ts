import { QUEUE_NAMES, workflowJobPayloadSchema } from '@fanxiaoshuo/shared';
import { Queue } from 'bullmq';
import type { WorkflowQueue, WorkflowQueueEnqueueResult } from './types.js';

/**
 * BullMQ `novel-workflows` 队列任务名。
 *
 * 跨进程契约：`apps/worker` 在 `QUEUE_NAMES.novelWorkflows`（`'novel-workflows'`）上
 * 消费同名任务，任务数据严格为 `workflowJobPayloadSchema`（仅 `{ runId }`）。
 */
export const WORKFLOW_JOB_NAME = 'workflow-run';

/**
 * `POST /api/v1/workflows/runs`（创建 / 续跑 / 单步重试）使用的生产队列实现。
 *
 * 关键设计：
 * - **`attempts: 1`**：禁止 BullMQ 无脑重跑整批（否则会重复扣费与重复写正文），
 *   失败恢复交给步骤级持久化断点续跑；
 * - **不固定 `jobId`**：若固定为 `runId`，BullMQ 会因保留窗口内仍存在同 ID 的
 *   已完成 / 已失败任务而静默丢弃新任务，导致续跑与重试永不生效；
 * - 完成 / 失败任务分别保留 24 小时 / 7 天，各最多 1000 条，避免 Redis 无限膨胀。
 */
export function createBullMqWorkflowQueue(options: {
  redisUrl: string;
  queueName?: string;
}): WorkflowQueue {
  const queue = new Queue<{ runId: string }, unknown, typeof WORKFLOW_JOB_NAME>(
    options.queueName ?? QUEUE_NAMES.novelWorkflows,
    {
      connection: { url: options.redisUrl, maxRetriesPerRequest: null },
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
      },
    },
  );

  return {
    async enqueue(runId: string): Promise<WorkflowQueueEnqueueResult> {
      const payload = workflowJobPayloadSchema.parse({ runId });
      const job = await queue.add(WORKFLOW_JOB_NAME, payload);
      return {
        jobId: String(job.id),
        createdAt: new Date(job.timestamp),
      };
    },

    async close() {
      await queue.close();
    },
  };
}
