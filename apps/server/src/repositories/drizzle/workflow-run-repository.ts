import { and, asc, count, desc, eq, getTableColumns, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { books, workflowRuns, workflowSteps } from '../../db/schema.js';
import { mapWorkflowRunRow, mapWorkflowStepRow } from '../../mapping/rows.js';
import type {
  CreateWorkflowRunRecordInput,
  ResumeWorkflowRunRecordInput,
  WorkflowRunDetailRecord,
  WorkflowRunListFilter,
  WorkflowRunPage,
  WorkflowRunRepository,
  WorkflowRunRecord,
} from '../types.js';

/**
 * Drizzle 实现的批量流水线仓储（`workflow_runs` + `workflow_steps`）。
 *
 * 约定的关键语义：
 * - 列表 / 详情一律 `INNER JOIN books` 取 `books.title` 作为 `bookTitle`；
 * - 详情步骤按 `step_index ASC` 返回，与 Worker 串行执行顺序一致；
 * - 暂停 / 续跑 / 取消 / 单步重试全部在**单事务**内更新批次与步骤，
 *   保证批次汇总字段（`failedSteps` / `status`）与步骤真实状态永不脱节。
 */

/**
 * numeric 统一以字符串写入（`numeric(12,6)` 精度由数据库保证）。
 * 固定 6 位小数，避免 JS 浮点在 `0.1 + 0.2` 场景下写出超长尾数。
 */
function toNumericValue(value: number): string {
  return value.toFixed(6);
}

function toNullableNumericValue(value: number | null): string | null {
  return value === null ? null : toNumericValue(value);
}

/** 批次主表列 + 关联书籍标题（列表与详情共用同一投影）。 */
const runColumns = {
  ...getTableColumns(workflowRuns),
  bookTitle: books.title,
} as const;

export function createDrizzleWorkflowRunRepository(db: Database): WorkflowRunRepository {
  /** 读取批次详情（批次 + 有序步骤）；不存在返回 null。 */
  async function loadDetail(runId: string): Promise<WorkflowRunDetailRecord | null> {
    const [runRow] = await db
      .select(runColumns)
      .from(workflowRuns)
      .innerJoin(books, eq(books.id, workflowRuns.bookId))
      .where(eq(workflowRuns.id, runId))
      .limit(1);

    if (!runRow) {
      return null;
    }

    const stepRows = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.runId, runId))
      .orderBy(asc(workflowSteps.stepIndex));

    return {
      ...mapWorkflowRunRow(runRow),
      steps: stepRows.map(mapWorkflowStepRow),
    };
  }

  /** 读取批次主表行（仅状态机判定所需的轻量列）。 */
  async function loadRunSummary(runId: string): Promise<WorkflowRunRecord | null> {
    const [row] = await db
      .select(runColumns)
      .from(workflowRuns)
      .innerJoin(books, eq(books.id, workflowRuns.bookId))
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    return row ? mapWorkflowRunRow(row) : null;
  }

  return {
    async list(filter: WorkflowRunListFilter): Promise<WorkflowRunPage> {
      const conditions = [
        ...(filter.bookId === undefined ? [] : [eq(workflowRuns.bookId, filter.bookId)]),
        ...(filter.status === undefined ? [] : [eq(workflowRuns.status, filter.status)]),
      ];
      const where = conditions.length === 0 ? undefined : and(...conditions);

      const [totalRow] = await db
        .select({ value: count() })
        .from(workflowRuns)
        .where(where);

      const rows = await db
        .select(runColumns)
        .from(workflowRuns)
        .innerJoin(books, eq(books.id, workflowRuns.bookId))
        .where(where)
        .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
        .limit(filter.pageSize)
        .offset((filter.page - 1) * filter.pageSize);

      return {
        items: rows.map(mapWorkflowRunRow),
        total: Number(totalRow?.value ?? 0),
      };
    },

    async findDetailById(runId) {
      return loadDetail(runId);
    },

    async createWithSteps(input: CreateWorkflowRunRecordInput) {
      const runId = await db.transaction(async (tx) => {
        const [runRow] = await tx
          .insert(workflowRuns)
          .values({
            bookId: input.bookId,
            mode: input.mode,
            status: 'queued',
            configJson: input.config,
            totalSteps: input.steps.length,
            completedSteps: 0,
            failedSteps: 0,
            maxCostUsd: toNullableNumericValue(input.maxCostUsd),
            spentCostUsd: toNumericValue(0),
            totalInputTokens: 0,
            totalOutputTokens: 0,
            pauseRequested: false,
            cancelRequested: false,
          })
          .returning({ id: workflowRuns.id });

        if (!runRow) {
          throw new Error('批量流水线批次创建失败：数据库未返回记录。');
        }

        if (input.steps.length > 0) {
          await tx.insert(workflowSteps).values(
            input.steps.map((step, index) => ({
              runId: runRow.id,
              chapterId: step.chapterId,
              stepIndex: index,
              chapterTitleSnapshot: step.chapterTitleSnapshot,
              status: 'pending',
              stage: 'idle',
              reworkCount: 0,
              criticIssuesJson: [] as string[],
              outputWordCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostUsd: toNumericValue(0),
            })),
          );
        }

        return runRow.id;
      });

      const detail = await loadDetail(runId);
      if (!detail) {
        throw new Error('批量流水线批次创建失败：写入后无法读取详情。');
      }
      return detail;
    },

    async requestPause(runId) {
      const current = await loadRunSummary(runId);
      if (!current) {
        return null;
      }

      if (current.status === 'queued') {
        // 尚未开始执行：直接收敛为手动暂停，无需 Worker 介入。
        await db
          .update(workflowRuns)
          .set({
            status: 'paused',
            pauseReason: 'USER_PAUSED',
            pauseRequested: false,
            updatedAt: new Date(),
          })
          .where(eq(workflowRuns.id, runId));
      } else if (current.status === 'running') {
        // 运行中：交由 Worker 在章节 / 返工轮次安全断点处落盘暂停。
        await db
          .update(workflowRuns)
          .set({ pauseRequested: true, updatedAt: new Date() })
          .where(eq(workflowRuns.id, runId));
      }

      return loadDetail(runId);
    },

    async resume(runId, input: ResumeWorkflowRunRecordInput = {}) {
      const current = await loadRunSummary(runId);
      if (!current) {
        return null;
      }

      const now = new Date();
      const maxCostUsdPatch =
        input.maxCostUsd === undefined
          ? {}
          : { maxCostUsd: toNullableNumericValue(input.maxCostUsd ?? null) };

      await db.transaction(async (tx) => {
        // 仅重置未完成的失败 / 跳过步骤，**全部 completed 步骤原样保留**（断点续跑核心）。
        await tx
          .update(workflowSteps)
          .set({
            status: 'pending',
            stage: 'idle',
            errorCode: null,
            errorMessage: null,
            finishedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(workflowSteps.runId, runId),
              inArray(workflowSteps.status, ['failed', 'skipped']),
            ),
          );

        await tx
          .update(workflowRuns)
          .set({
            status: 'queued',
            pauseRequested: false,
            cancelRequested: false,
            pauseReason: null,
            errorCode: null,
            errorMessage: null,
            finishedAt: null,
            failedSteps: 0,
            updatedAt: now,
            ...maxCostUsdPatch,
          })
          .where(eq(workflowRuns.id, runId));
      });

      return loadDetail(runId);
    },

    async cancel(runId) {
      const current = await loadRunSummary(runId);
      if (!current) {
        return null;
      }

      const now = new Date();

      if (current.status === 'queued' || current.status === 'paused') {
        await db.transaction(async (tx) => {
          // 未执行 / 失败的步骤统一标记为跳过，已完成章节成果完整保留。
          await tx
            .update(workflowSteps)
            .set({ status: 'skipped', updatedAt: now })
            .where(
              and(
                eq(workflowSteps.runId, runId),
                inArray(workflowSteps.status, ['pending', 'failed']),
              ),
            );

          await tx
            .update(workflowRuns)
            .set({
              status: 'cancelled',
              cancelRequested: true,
              updatedAt: now,
              finishedAt: now,
            })
            .where(eq(workflowRuns.id, runId));
        });
      } else {
        // 运行中：由 Worker 在安全断点收敛取消并置 skipped 剩余步骤。
        await db
          .update(workflowRuns)
          .set({ cancelRequested: true, updatedAt: now })
          .where(eq(workflowRuns.id, runId));
      }

      return loadDetail(runId);
    },

    async retryStep(runId, stepId) {
      const current = await loadRunSummary(runId);
      if (!current) {
        return null;
      }

      const now = new Date();
      const retried = await db.transaction(async (tx) => {
        const rows = await tx
          .update(workflowSteps)
          .set({
            status: 'pending',
            stage: 'idle',
            errorCode: null,
            errorMessage: null,
            finishedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(workflowSteps.id, stepId),
              eq(workflowSteps.runId, runId),
              eq(workflowSteps.status, 'failed'),
            ),
          )
          .returning({ id: workflowSteps.id });

        if (rows.length === 0) {
          return false;
        }

        await tx
          .update(workflowRuns)
          .set({
            status: 'queued',
            pauseRequested: false,
            cancelRequested: false,
            pauseReason: null,
            errorCode: null,
            errorMessage: null,
            finishedAt: null,
            failedSteps: Math.max(0, current.failedSteps - 1),
            updatedAt: now,
          })
          .where(eq(workflowRuns.id, runId));

        return true;
      });

      if (!retried) {
        return null;
      }
      return loadDetail(runId);
    },

    async delete(runId) {
      // `workflow_steps` 通过 ON DELETE CASCADE 自动清理。
      const rows = await db
        .delete(workflowRuns)
        .where(eq(workflowRuns.id, runId))
        .returning({ id: workflowRuns.id });
      return rows.length > 0;
    },
  };
}
