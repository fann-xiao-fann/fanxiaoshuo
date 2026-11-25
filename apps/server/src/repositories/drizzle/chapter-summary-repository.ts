import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { chapterSummaries } from '../../db/schema.js';
import { mapChapterSummaryRow } from '../../mapping/rows.js';
import type {
  ChapterSummaryRepository,
  UpsertChapterSummaryRecordInput,
} from '../types.js';

/** Drizzle 实现的章节细纲 / 剧情摘要仓储（1:1 绑定章节，整条覆盖写入）。 */
export function createDrizzleChapterSummaryRepository(db: Database): ChapterSummaryRepository {
  return {
    async findByChapterId(chapterId) {
      const [row] = await db
        .select()
        .from(chapterSummaries)
        .where(eq(chapterSummaries.chapterId, chapterId))
        .limit(1);
      return row ? mapChapterSummaryRow(row) : null;
    },

    async listByBook(bookId) {
      const rows = await db
        .select()
        .from(chapterSummaries)
        .where(eq(chapterSummaries.bookId, bookId))
        .orderBy(asc(chapterSummaries.updatedAt));
      return rows.map(mapChapterSummaryRow);
    },

    async upsert(input: UpsertChapterSummaryRecordInput) {
      const updatedAt = new Date();
      const [row] = await db
        .insert(chapterSummaries)
        .values({
          chapterId: input.chapterId,
          bookId: input.bookId,
          outline: input.outline,
          summary: input.summary,
          keyEvents: input.keyEvents,
          charactersPresent: input.charactersPresent,
          source: input.source,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: chapterSummaries.chapterId,
          set: {
            bookId: input.bookId,
            outline: input.outline,
            summary: input.summary,
            keyEvents: input.keyEvents,
            charactersPresent: input.charactersPresent,
            source: input.source,
            updatedAt,
          },
        })
        .returning();

      if (!row) {
        throw new Error('章节摘要保存失败：数据库未返回记录。');
      }
      return mapChapterSummaryRow(row);
    },
  };
}
