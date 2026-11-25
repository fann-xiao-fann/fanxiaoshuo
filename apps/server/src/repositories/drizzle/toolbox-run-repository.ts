import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { toolboxRuns } from '../../db/schema.js';
import { mapToolboxRunRow } from '../../mapping/rows.js';
import type {
  CreateToolboxRunInput,
  ToolboxRunListFilter,
  ToolboxRunPage,
  ToolboxRunRecord,
  ToolboxRunRepository,
} from '../types.js';

/**
 * Drizzle 实现的创作工具盒运行历史仓储（`toolbox_runs`）。
 *
 * 语义约定（与内存测试实现逐条对齐）：
 * - 历史为 append-only：只有 `create` / `delete`，不存在更新路径；
 * - 列表按 `createdAt DESC, id DESC` 分页（同一毫秒内也能稳定排序）；
 * - 删除历史不触碰 `knowledge_cards` / `book_outlines`（回写成果与执行历史解耦）。
 */

/** `numeric(12,6)` 统一以 6 位小数字符串写入，避免 JS 浮点写出超长尾数。 */
function toNumericValue(value: number): string {
  return value.toFixed(6);
}

export function createDrizzleToolboxRunRepository(db: Database): ToolboxRunRepository {
  return {
    async create(input: CreateToolboxRunInput): Promise<ToolboxRunRecord> {
      const [row] = await db
        .insert(toolboxRuns)
        .values({
          toolId: input.toolId,
          bookId: input.bookId,
          role: input.role,
          status: input.status,
          inputsJson: { ...input.inputs },
          outputJson: input.output,
          modelRef: input.modelRef,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          estimatedCostUsd: toNumericValue(input.estimatedCostUsd),
          latencyMs: input.latencyMs,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
        })
        .returning();

      if (!row) {
        throw new Error('创作工具盒运行记录写入失败：数据库未返回记录。');
      }
      return mapToolboxRunRow(row);
    },

    async findById(runId: string): Promise<ToolboxRunRecord | null> {
      const [row] = await db
        .select()
        .from(toolboxRuns)
        .where(eq(toolboxRuns.id, runId))
        .limit(1);
      return row ? mapToolboxRunRow(row) : null;
    },

    async list(filter: ToolboxRunListFilter): Promise<ToolboxRunPage> {
      const conditions: SQL[] = [
        ...(filter.toolId === undefined ? [] : [eq(toolboxRuns.toolId, filter.toolId)]),
        ...(filter.bookId === undefined ? [] : [eq(toolboxRuns.bookId, filter.bookId)]),
        ...(filter.status === undefined ? [] : [eq(toolboxRuns.status, filter.status)]),
      ];
      const where = conditions.length === 0 ? undefined : and(...conditions);

      const [totalRow] = await db.select({ value: count() }).from(toolboxRuns).where(where);

      const rows = await db
        .select()
        .from(toolboxRuns)
        .where(where)
        .orderBy(desc(toolboxRuns.createdAt), desc(toolboxRuns.id))
        .limit(filter.pageSize)
        .offset((filter.page - 1) * filter.pageSize);

      return {
        items: rows.map(mapToolboxRunRow),
        total: Number(totalRow?.value ?? 0),
      };
    },

    async delete(runId: string): Promise<boolean> {
      const rows = await db
        .delete(toolboxRuns)
        .where(eq(toolboxRuns.id, runId))
        .returning({ id: toolboxRuns.id });
      return rows.length > 0;
    },
  };
}
