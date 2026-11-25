import { and, asc, desc, eq, ilike, max, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { knowledgeCards } from '../../db/schema.js';
import { mapKnowledgeCardRow } from '../../mapping/rows.js';
import type {
  CreateKnowledgeCardRecordInput,
  KnowledgeCardListFilter,
  KnowledgeCardRepository,
  UpdateKnowledgeCardRecordPatch,
} from '../types.js';

/**
 * LIKE 通配符转义（PostgreSQL `LIKE` / `ILIKE` 默认以反斜杠为转义符）。
 * 防止用户输入的 `%` / `_` 被当作通配符而扩大匹配范围。
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Drizzle 实现的结构化设定卡仓储（分类 / 关键字 / 常驻筛选）。 */
export function createDrizzleKnowledgeCardRepository(db: Database): KnowledgeCardRepository {
  /** 本书下一个 `sortOrder`（追加到末尾）。 */
  async function nextSortOrder(bookId: string): Promise<number> {
    const [row] = await db
      .select({ value: max(knowledgeCards.sortOrder) })
      .from(knowledgeCards)
      .where(eq(knowledgeCards.bookId, bookId));
    return (row?.value ?? -1) + 1;
  }

  return {
    async listByBook(bookId: string, filter: KnowledgeCardListFilter = {}) {
      const conditions: SQL[] = [eq(knowledgeCards.bookId, bookId)];

      if (filter.category !== undefined) {
        conditions.push(eq(knowledgeCards.category, filter.category));
      }
      if (filter.pinned !== undefined) {
        conditions.push(eq(knowledgeCards.pinned, filter.pinned));
      }

      const keyword = filter.q?.trim() ?? '';
      if (keyword.length > 0) {
        const pattern = `%${escapeLikePattern(keyword)}%`;
        const match = or(
          ilike(knowledgeCards.title, pattern),
          ilike(knowledgeCards.summary, pattern),
          ilike(knowledgeCards.content, pattern),
          // jsonb 文本投影后模糊匹配别名（`["别名A","别名B"]`）
          sql`${knowledgeCards.aliases}::text ILIKE ${pattern}`,
        );
        if (match) {
          conditions.push(match);
        }
      }

      const rows = await db
        .select()
        .from(knowledgeCards)
        .where(and(...conditions))
        .orderBy(
          desc(knowledgeCards.pinned),
          asc(knowledgeCards.sortOrder),
          asc(knowledgeCards.createdAt),
        );

      return rows.map(mapKnowledgeCardRow);
    },

    async findById(id) {
      const [row] = await db
        .select()
        .from(knowledgeCards)
        .where(eq(knowledgeCards.id, id))
        .limit(1);
      return row ? mapKnowledgeCardRow(row) : null;
    },

    async create(input: CreateKnowledgeCardRecordInput) {
      const sortOrder = input.sortOrder ?? (await nextSortOrder(input.bookId));
      const now = new Date();
      const [row] = await db
        .insert(knowledgeCards)
        .values({
          bookId: input.bookId,
          category: input.category,
          title: input.title,
          summary: input.summary,
          content: input.content,
          aliases: input.aliases,
          tags: input.tags,
          pinned: input.pinned,
          sortOrder,
          embedding: input.embedding ?? null,
          embeddingModelRef: input.embeddingModelRef ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (!row) {
        throw new Error('设定卡创建失败：数据库未返回记录。');
      }
      return mapKnowledgeCardRow(row);
    },

    async update(id: string, patch: UpdateKnowledgeCardRecordPatch) {
      const [row] = await db
        .update(knowledgeCards)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(knowledgeCards.id, id))
        .returning();
      return row ? mapKnowledgeCardRow(row) : null;
    },

    async delete(id) {
      const rows = await db
        .delete(knowledgeCards)
        .where(eq(knowledgeCards.id, id))
        .returning({ id: knowledgeCards.id });
      return rows.length > 0;
    },
  };
}
