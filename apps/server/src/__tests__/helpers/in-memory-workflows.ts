import { randomUUID } from 'node:crypto';
import type { WorkflowEvent } from '@fanxiaoshuo/shared';
import type { Unsubscribe, WorkflowEventBus, WorkflowQueue, WorkflowQueueEnqueueResult } from '../../queue/types.js';
import type {
  CreateWorkflowRunRecordInput,
  ResumeWorkflowRunRecordInput,
  WorkflowRunDetailRecord,
  WorkflowRunListFilter,
  WorkflowRunPage,
  WorkflowRunRecord,
  WorkflowRunRepository,
  WorkflowStepRecord,
} from '../../repositories/types.js';

/**
 * 批量流水线仓储的内存实现（测试专用，与 Drizzle 实现逐条语义对齐）。
 *
 * 语义约定（与生产实现一致）：
 * - 列表按 `createdAt DESC` 分页，并冗余取书籍标题；
 * - 详情步骤按 `stepIndex` 升序；
 * - `requestPause`：`queued` 直接收敛为 `paused(USER_PAUSED)`，`running` 仅置标记；
 * - `resume`：仅重置 `failed` / `skipped` 步骤，**completed 步骤原样保留**；
 * - `cancel`：`queued` / `paused` 立即收敛为 `cancelled` 并把未完成步骤置 `skipped`，
 *   `running` 仅置 `cancelRequested`；
 * - `retryStep`：仅重置指定 `failed` 步骤并递减 `failedSteps`。
 */

export interface InMemoryWorkflowState {
  readonly runs: Map<string, WorkflowRunRecord>;
  /** `runId` → 按 `stepIndex` 升序的步骤列表 */
  readonly steps: Map<string, WorkflowStepRecord[]>;
}

export interface InMemoryWorkflowRepositories {
  readonly workflowRuns: WorkflowRunRepository;
  readonly state: InMemoryWorkflowState;
}

export function createInMemoryWorkflowRepositories(options: {
  now: () => Date;
  /** 书籍标题解析（不存在返回 null；内存仓储直接读取书库状态） */
  resolveBookTitle: (bookId: string) => string | null;
}): InMemoryWorkflowRepositories {
  const now = options.now;
  const runMap = new Map<string, WorkflowRunRecord>();
  const stepMap = new Map<string, WorkflowStepRecord[]>();

  function detailOf(runId: string): WorkflowRunDetailRecord | null {
    const run = runMap.get(runId);
    if (!run) {
      return null;
    }
    const steps = [...(stepMap.get(runId) ?? [])].sort((a, b) => a.stepIndex - b.stepIndex);
    return { ...run, steps };
  }

  function updateRun(runId: string, patch: Partial<WorkflowRunRecord>): WorkflowRunRecord | null {
    const current = runMap.get(runId);
    if (!current) {
      return null;
    }
    const next: WorkflowRunRecord = { ...current, ...patch, updatedAt: now() };
    runMap.set(runId, next);
    return next;
  }

  function updateSteps(
    runId: string,
    predicate: (step: WorkflowStepRecord) => boolean,
    patch: Partial<WorkflowStepRecord>,
  ): void {
    const steps = stepMap.get(runId);
    if (!steps) {
      return;
    }
    const at = now();
    stepMap.set(
      runId,
      steps.map((step) => (predicate(step) ? { ...step, ...patch, updatedAt: at } : step)),
    );
  }

  const workflowRuns: WorkflowRunRepository = {
    async list(filter: WorkflowRunListFilter): Promise<WorkflowRunPage> {
      const filtered = [...runMap.values()]
        .filter((run) => (filter.bookId === undefined ? true : run.bookId === filter.bookId))
        .filter((run) => (filter.status === undefined ? true : run.status === filter.status))
        .sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
        );
      const start = (filter.page - 1) * filter.pageSize;
      return {
        items: filtered.slice(start, start + filter.pageSize),
        total: filtered.length,
      };
    },

    async findDetailById(runId) {
      return detailOf(runId);
    },

    async createWithSteps(input: CreateWorkflowRunRecordInput) {
      const at = now();
      const runId = randomUUID();
      const bookTitle = options.resolveBookTitle(input.bookId);
      if (bookTitle === null) {
        throw new Error('批量流水线批次创建失败：书籍不存在。');
      }

      const run: WorkflowRunRecord = {
        id: runId,
        bookId: input.bookId,
        bookTitle,
        mode: input.mode,
        status: 'queued',
        config: input.config,
        totalSteps: input.steps.length,
        completedSteps: 0,
        failedSteps: 0,
        maxCostUsd: input.maxCostUsd,
        spentCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        pauseRequested: false,
        cancelRequested: false,
        pauseReason: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      runMap.set(runId, run);

      const steps: WorkflowStepRecord[] = input.steps.map((step, index) => ({
        id: randomUUID(),
        runId,
        chapterId: step.chapterId,
        stepIndex: index,
        chapterTitleSnapshot: step.chapterTitleSnapshot,
        status: 'pending',
        stage: 'idle',
        reworkCount: 0,
        criticScore: null,
        criticPassed: null,
        criticSummary: null,
        criticIssues: [],
        outputWordCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        backupRevisionId: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdAt: at,
        updatedAt: at,
      }));
      stepMap.set(runId, steps);

      const detail = detailOf(runId);
      if (!detail) {
        throw new Error('批量流水线批次创建失败：写入后无法读取详情。');
      }
      return detail;
    },

    async requestPause(runId) {
      const current = runMap.get(runId);
      if (!current) {
        return null;
      }
      if (current.status === 'queued') {
        updateRun(runId, {
          status: 'paused',
          pauseReason: 'USER_PAUSED',
          pauseRequested: false,
        });
      } else if (current.status === 'running') {
        updateRun(runId, { pauseRequested: true });
      }
      return detailOf(runId);
    },

    async resume(runId, input: ResumeWorkflowRunRecordInput = {}) {
      const current = runMap.get(runId);
      if (!current) {
        return null;
      }
      updateSteps(
        runId,
        (step) => step.status === 'failed' || step.status === 'skipped',
        {
          status: 'pending',
          stage: 'idle',
          errorCode: null,
          errorMessage: null,
          finishedAt: null,
        },
      );
      updateRun(runId, {
        status: 'queued',
        pauseRequested: false,
        cancelRequested: false,
        pauseReason: null,
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        failedSteps: 0,
        ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
      });
      return detailOf(runId);
    },

    async cancel(runId) {
      const current = runMap.get(runId);
      if (!current) {
        return null;
      }
      if (current.status === 'queued' || current.status === 'paused') {
        updateSteps(
          runId,
          (step) => step.status === 'pending' || step.status === 'failed',
          { status: 'skipped' },
        );
        updateRun(runId, {
          status: 'cancelled',
          cancelRequested: true,
          finishedAt: now(),
        });
      } else {
        updateRun(runId, { cancelRequested: true });
      }
      return detailOf(runId);
    },

    async retryStep(runId, stepId) {
      const current = runMap.get(runId);
      if (!current) {
        return null;
      }
      const target = (stepMap.get(runId) ?? []).find((step) => step.id === stepId);
      if (!target || target.status !== 'failed') {
        return null;
      }
      updateSteps(
        runId,
        (step) => step.id === stepId,
        {
          status: 'pending',
          stage: 'idle',
          errorCode: null,
          errorMessage: null,
          finishedAt: null,
        },
      );
      updateRun(runId, {
        status: 'queued',
        pauseRequested: false,
        cancelRequested: false,
        pauseReason: null,
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        failedSteps: Math.max(0, current.failedSteps - 1),
      });
      return detailOf(runId);
    },

    async delete(runId) {
      if (!runMap.has(runId)) {
        return false;
      }
      runMap.delete(runId);
      stepMap.delete(runId);
      return true;
    },
  };

  return {
    workflowRuns,
    state: { runs: runMap, steps: stepMap },
  };
}

/* -------------------------------------------------------------------------- */
/*                              假队列与假事件总线                              */
/* -------------------------------------------------------------------------- */

/** 可控的假 `novel-workflows` 队列（记录每次入队的 `runId`）。 */
export interface FakeWorkflowQueue extends WorkflowQueue {
  readonly enqueued: string[];
  /** 下一次 `enqueue` 抛错（用于覆盖入队失败分支） */
  failNext?: Error | undefined;
}

export function createFakeWorkflowQueue(): FakeWorkflowQueue {
  const enqueued: string[] = [];
  let counter = 0;

  const queue: FakeWorkflowQueue = {
    enqueued,
    failNext: undefined,
    async enqueue(runId: string): Promise<WorkflowQueueEnqueueResult> {
      if (queue.failNext) {
        const error = queue.failNext;
        queue.failNext = undefined;
        throw error;
      }
      counter += 1;
      enqueued.push(runId);
      return { jobId: `workflow-job-${counter}`, createdAt: new Date() };
    },
  };
  return queue;
}

/** 可控的假批量流水线事件总线（记录发布事件并支持向 SSE 订阅者注入事件）。 */
export interface FakeWorkflowEventBus extends WorkflowEventBus {
  readonly published: WorkflowEvent[];
  readonly handlers: Set<(event: WorkflowEvent) => void>;
  unsubscribeCount: number;
  emit(event: WorkflowEvent): void;
}

export function createFakeWorkflowEventBus(): FakeWorkflowEventBus {
  const published: WorkflowEvent[] = [];
  const handlers = new Set<(event: WorkflowEvent) => void>();
  const bus: FakeWorkflowEventBus = {
    published,
    handlers,
    unsubscribeCount: 0,
    async publish(event) {
      published.push(event);
      bus.emit(event);
    },
    async subscribe(handler): Promise<Unsubscribe> {
      handlers.add(handler);
      return async () => {
        if (handlers.delete(handler)) {
          bus.unsubscribeCount += 1;
        }
      };
    },
    emit(event) {
      for (const handler of handlers) {
        handler(event);
      }
    },
  };
  return bus;
}
