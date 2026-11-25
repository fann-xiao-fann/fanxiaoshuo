import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { books, chapters, volumes, type BookRow } from '../../db/schema.js';
import { mapBookRow } from '../../mapping/rows.js';
import type {
  BookAggregateRecord,
  BookListFilter,
  BookRepository,
  CreateBookRecordInput,
  UpdateBookRecordPatch,
} from '../types.js';

/** `ILIKE` 通配符转义，避免用户输入的 `%` / `_` 破坏模糊匹配语义。 */
function toLikePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Drizzle 实现的书籍仓储。
 *
 * 聚合策略：书籍列表 / 详情一次性批量读取未软删的卷与章，再在内存中归并，
 * 避免 N+1 查询（书架分页上限 2,000 本仍在同一数量级）。
 */
export function createDrizzleBookRepository(db: Database): BookRepository {
  /** 计算书籍聚合：只统计未软删的卷与章（软删分卷下的章同样不计入）。 */
  async function loadAggregates(
    bookIds: readonly string[],
  ): Promise<Map<string, { volumeCount: number; chapterCount: number; totalWordCount: number }>> {
    const result = new Map<
      string,
      { volumeCount: number; chapterCount: number; totalWordCount: number }
    >();
    for (const bookId of bookIds) {
      result.set(bookId, { volumeCount: 0, chapterCount: 0, totalWordCount: 0 });
    }
    if (bookIds.length === 0) {
      return result;
    }

    const volumeRows = await db
      .select({ id: volumes.id, bookId: volumes.bookId })
      .from(volumes)
      .where(and(inArray(volumes.bookId, [...bookIds]), isNull(volumes.deletedAt)));

    const activeVolumeIds = new Set(volumeRows.map((row) => row.id));

    for (const row of volumeRows) {
      const aggregate = result.get(row.bookId);
      if (aggregate) {
        aggregate.volumeCount += 1;
      }
    }

    const chapterRows = await db
      .select({
        bookId: chapters.bookId,
        volumeId: chapters.volumeId,
        wordCount: chapters.wordCount,
      })
      .from(chapters)
      .where(and(inArray(chapters.bookId, [...bookIds]), isNull(chapters.deletedAt)));

    for (const row of chapterRows) {
      if (row.volumeId !== null && !activeVolumeIds.has(row.volumeId)) {
        // 章所属分卷已软删：与卷章树一致，不计入全书汇总。
        continue;
      }
      const aggregate = result.get(row.bookId);
      if (aggregate) {
        aggregate.chapterCount += 1;
        aggregate.totalWordCount += row.wordCount;
      }
    }

    return result;
  }

  function toAggregate(
    row: BookRow,
    aggregate: { volumeCount: number; chapterCount: number; totalWordCount: number } | undefined,
  ): BookAggregateRecord {
    return {
      book: mapBookRow(row),
      volumeCount: aggregate?.volumeCount ?? 0,
      chapterCount: aggregate?.chapterCount ?? 0,
      totalWordCount: aggregate?.totalWordCount ?? 0,
    };
  }

  return {
    async list(filter: BookListFilter) {
      const conditions: SQL[] = [
        filter.includeDeleted === 'only' ? isNotNull(books.deletedAt) : isNull(books.deletedAt),
      ];
      if (filter.status !== undefined) {
        conditions.push(eq(books.status, filter.status));
      }
      const keyword = filter.q?.trim() ?? '';
      if (keyword.length > 0) {
        const pattern = toLikePattern(keyword);
        const keywordCondition = or(
          ilike(books.title, pattern),
          ilike(books.authorPenName, pattern),
          ilike(books.synopsis, pattern),
          ilike(books.genre, pattern),
        );
        if (keywordCondition) {
          conditions.push(keywordCondition);
        }
      }

      const rows = await db
        .select()
        .from(books)
        .where(and(...conditions))
        .orderBy(desc(books.updatedAt), asc(books.createdAt));

      const aggregates = await loadAggregates(rows.map((row) => row.id));
      return rows.map((row) => toAggregate(row, aggregates.get(row.id)));
    },

    async findById(id) {
      const [row] = await db.select().from(books).where(eq(books.id, id)).limit(1);
      return row ? mapBookRow(row) : null;
    },

    async findAggregateById(id) {
      const [row] = await db.select().from(books).where(eq(books.id, id)).limit(1);
      if (!row) {
        return null;
      }
      const aggregates = await loadAggregates([row.id]);
      return toAggregate(row, aggregates.get(row.id));
    },

    async create(input: CreateBookRecordInput) {
      const [row] = await db.insert(books).values({ ...input }).returning();
      if (!row) {
        throw new Error('书籍创建失败：数据库未返回记录。');
      }
      return mapBookRow(row);
    },

    async update(id, patch: UpdateBookRecordPatch) {
      const [row] = await db
        .update(books)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(books.id, id))
        .returning();
      return row ? mapBookRow(row) : null;
    },

    async softDelete(id) {
      const [row] = await db
        .update(books)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(books.id, id), isNull(books.deletedAt)))
        .returning();
      if (row) {
        return mapBookRow(row);
      }
      const [existing] = await db.select().from(books).where(eq(books.id, id)).limit(1);
      return existing ? mapBookRow(existing) : null;
    },

    async restore(id) {
      const [row] = await db
        .update(books)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(books.id, id))
        .returning();
      return row ? mapBookRow(row) : null;
    },

    async purge(id) {
      const rows = await db.delete(books).where(eq(books.id, id)).returning({ id: books.id });
      return rows.length > 0;
    },
  };
}
