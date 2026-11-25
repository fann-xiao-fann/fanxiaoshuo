import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { chapterRevisions, chapters } from '../../db/schema.js';
import { mapChapterRow, mapRevisionRow } from '../../mapping/rows.js';
import type {
  ChapterRevisionRepository,
  CreateChapterRevisionRecordInput,
  RestoreChapterRevisionRecordInput,
  RestoreChapterRevisionResult,
} from '../types.js';

/** Drizzle 实现的章节历史快照仓储（append-only）。 */
export function createDrizzleChapterRevisionRepository(db: Database): ChapterRevisionRepository {
  return {
    async listByChapter(chapterId) {
      const rows = await db
        .select()
        .from(chapterRevisions)
        .where(eq(chapterRevisions.chapterId, chapterId))
        .orderBy(desc(chapterRevisions.createdAt), desc(chapterRevisions.version));
      return rows.map(mapRevisionRow);
    },

    async findById(revisionId) {
      const [row] = await db
        .select()
        .from(chapterRevisions)
        .where(eq(chapterRevisions.id, revisionId))
        .limit(1);
      return row ? mapRevisionRow(row) : null;
    },

    async findLatestByChapter(chapterId) {
      const [row] = await db
        .select()
        .from(chapterRevisions)
        .where(eq(chapterRevisions.chapterId, chapterId))
        .orderBy(desc(chapterRevisions.createdAt), desc(chapterRevisions.version))
        .limit(1);
      return row ? mapRevisionRow(row) : null;
    },

    async findLatestBySource(chapterId, source) {
      const [row] = await db
        .select()
        .from(chapterRevisions)
        .where(
          and(eq(chapterRevisions.chapterId, chapterId), eq(chapterRevisions.source, source)),
        )
        .orderBy(desc(chapterRevisions.createdAt), desc(chapterRevisions.version))
        .limit(1);
      return row ? mapRevisionRow(row) : null;
    },

    async create(input: CreateChapterRevisionRecordInput) {
      const [row] = await db
        .insert(chapterRevisions)
        .values({
          chapterId: input.chapterId,
          version: input.version,
          source: input.source,
          note: input.note,
          titleSnapshot: input.titleSnapshot,
          contentText: input.contentText,
          contentJson: input.contentJson,
          wordCount: input.wordCount,
        })
        .returning();
      if (!row) {
        throw new Error('章节快照创建失败：数据库未返回记录。');
      }
      return mapRevisionRow(row);
    },

    async restore(
      input: RestoreChapterRevisionRecordInput,
    ): Promise<RestoreChapterRevisionResult | null> {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: chapters.id })
          .from(chapters)
          .where(and(eq(chapters.id, input.chapterId), isNull(chapters.deletedAt)))
          .limit(1);

        if (!current) {
          return null;
        }

        // ① 先把回滚前的当前正文留底，任何误回滚都可二次恢复。
        const [backup] = await tx
          .insert(chapterRevisions)
          .values({
            chapterId: input.backup.chapterId,
            version: input.backup.version,
            source: input.backup.source,
            note: input.backup.note,
            titleSnapshot: input.backup.titleSnapshot,
            contentText: input.backup.contentText,
            contentJson: input.backup.contentJson,
            wordCount: input.backup.wordCount,
          })
          .returning();

        if (!backup) {
          throw new Error('回滚备份快照写入失败：数据库未返回记录。');
        }

        // ② 再把章节正文回滚到目标快照内容并递增版本号。
        const [row] = await tx
          .update(chapters)
          .set({
            title: input.restore.title,
            contentText: input.restore.contentText,
            contentJson: input.restore.contentJson,
            wordCount: input.restore.wordCount,
            version: sql`${chapters.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(chapters.id, input.chapterId), isNull(chapters.deletedAt)))
          .returning();

        if (!row) {
          throw new Error('回滚失败：章节在事务期间被删除。');
        }

        return { chapter: mapChapterRow(row), backupRevision: mapRevisionRow(backup) };
      });
    },
  };
}
