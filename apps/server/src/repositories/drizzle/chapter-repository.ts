import { and, asc, eq, isNotNull, isNull, max, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { chapterRevisions, chapters } from '../../db/schema.js';
import { FORCE_OVERWRITE_BACKUP_NOTE } from '../../domain/books.js';
import { mapChapterMetaRow, mapChapterRow, mapRevisionRow } from '../../mapping/rows.js';
import type {
  ApplyAiChapterContentOutcome,
  ApplyAiChapterContentRecordInput,
  ChapterMetaRecord,
  ChapterRepository,
  ChapterRevisionRecord,
  ChapterSaveOutcome,
  CreateChapterRecordInput,
  SaveChapterContentRecordInput,
  TrashScope,
  UpdateChapterMetaRecordPatch,
} from '../types.js';

/** 章节元信息查询列（**不选正文**，保证目录树响应轻量）。 */
const chapterMetaColumns = {
  id: chapters.id,
  bookId: chapters.bookId,
  volumeId: chapters.volumeId,
  title: chapters.title,
  sortOrder: chapters.sortOrder,
  status: chapters.status,
  wordCount: chapters.wordCount,
  version: chapters.version,
  deletedAt: chapters.deletedAt,
  createdAt: chapters.createdAt,
  updatedAt: chapters.updatedAt,
} as const;

function compareChapterOrder(a: ChapterMetaRecord, b: ChapterMetaRecord): number {
  return a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime();
}

/** Drizzle 实现的章节仓储（含正文乐观锁保存与单事务重排）。 */
export function createDrizzleChapterRepository(db: Database): ChapterRepository {
  /** 目标卷内下一个 `sortOrder`（`volumeId` 为 null 表示未分卷区）。 */
  async function nextSortOrder(bookId: string, volumeId: string | null): Promise<number> {
    const [row] = await db
      .select({ value: max(chapters.sortOrder) })
      .from(chapters)
      .where(
        and(
          eq(chapters.bookId, bookId),
          volumeId === null ? isNull(chapters.volumeId) : eq(chapters.volumeId, volumeId),
        ),
      );
    return (row?.value ?? -1) + 1;
  }

  return {
    async listByBook(bookId: string, scope: TrashScope) {
      const rows = await db
        .select(chapterMetaColumns)
        .from(chapters)
        .where(
          and(
            eq(chapters.bookId, bookId),
            scope === 'deleted' ? isNotNull(chapters.deletedAt) : isNull(chapters.deletedAt),
          ),
        )
        .orderBy(asc(chapters.sortOrder), asc(chapters.createdAt));

      const records: ChapterMetaRecord[] = rows.map(mapChapterMetaRow);
      records.sort(compareChapterOrder);
      return records;
    },

    async listWithContentByBook(bookId: string) {
      const rows = await db.select().from(chapters).where(eq(chapters.bookId, bookId));
      return rows
        .map(mapChapterRow)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime());
    },

    async findById(id) {
      const [row] = await db.select().from(chapters).where(eq(chapters.id, id)).limit(1);
      return row ? mapChapterRow(row) : null;
    },

    async create(input: CreateChapterRecordInput) {
      const sortOrder =
        input.sortOrder ?? (await nextSortOrder(input.bookId, input.volumeId));
      const [row] = await db
        .insert(chapters)
        .values({
          bookId: input.bookId,
          volumeId: input.volumeId,
          title: input.title,
          status: input.status,
          sortOrder,
        })
        .returning();
      if (!row) {
        throw new Error('章节创建失败：数据库未返回记录。');
      }
      return mapChapterRow(row);
    },

    async updateMeta(id: string, patch: UpdateChapterMetaRecordPatch) {
      const [current] = await db.select().from(chapters).where(eq(chapters.id, id)).limit(1);
      if (!current) {
        return null;
      }
      // 跨卷移动时若未显式指定 sortOrder，则自动追加到目标卷末尾。
      const movingVolume =
        patch.volumeId !== undefined && patch.volumeId !== current.volumeId;
      const sortOrder =
        patch.sortOrder ??
        (movingVolume ? await nextSortOrder(current.bookId, patch.volumeId ?? null) : undefined);

      const [row] = await db
        .update(chapters)
        .set({
          ...patch,
          ...(sortOrder === undefined ? {} : { sortOrder }),
          updatedAt: new Date(),
        })
        .where(eq(chapters.id, id))
        .returning();
      return row ? mapChapterRow(row) : null;
    },

    async softDelete(id) {
      const [row] = await db
        .update(chapters)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(chapters.id, id), isNull(chapters.deletedAt)))
        .returning();
      if (row) {
        return mapChapterRow(row);
      }
      const [existing] = await db.select().from(chapters).where(eq(chapters.id, id)).limit(1);
      return existing ? mapChapterRow(existing) : null;
    },

    async restore(id) {
      const [row] = await db
        .update(chapters)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(chapters.id, id))
        .returning();
      return row ? mapChapterRow(row) : null;
    },

    async purge(id) {
      const rows = await db.delete(chapters).where(eq(chapters.id, id)).returning({ id: chapters.id });
      return rows.length > 0;
    },

    async saveContent(input: SaveChapterContentRecordInput): Promise<ChapterSaveOutcome> {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(chapters)
          .where(and(eq(chapters.id, input.chapterId), isNull(chapters.deletedAt)))
          .limit(1);

        if (!current) {
          return { status: 'not_found' };
        }

        if (!input.forceOverwrite && current.version !== input.expectedVersion) {
          return { status: 'conflict', chapter: mapChapterRow(current) };
        }

        let backupRevision: ChapterRevisionRecord | null = null;
        if (input.forceOverwrite) {
          // 强制覆盖前先为数据库当前现状留底，误覆盖可二次恢复。
          const [revision] = await tx
            .insert(chapterRevisions)
            .values({
              chapterId: current.id,
              version: current.version,
              source: 'restore',
              note: FORCE_OVERWRITE_BACKUP_NOTE,
              titleSnapshot: current.title,
              contentText: current.contentText,
              contentJson: current.contentJson,
              wordCount: current.wordCount,
            })
            .returning();
          if (revision) {
            backupRevision = mapRevisionRow(revision);
          }
        }

        const [row] = await tx
          .update(chapters)
          .set({
            ...(input.title === undefined ? {} : { title: input.title }),
            contentText: input.contentText,
            ...(input.contentJson === undefined ? {} : { contentJson: input.contentJson }),
            wordCount: input.wordCount,
            version: sql`${chapters.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chapters.id, input.chapterId),
              isNull(chapters.deletedAt),
              input.forceOverwrite ? undefined : eq(chapters.version, input.expectedVersion),
            ),
          )
          .returning();

        if (row) {
          return { status: 'saved', chapter: mapChapterRow(row), backupRevision };
        }

        const [latest] = await tx
          .select()
          .from(chapters)
          .where(and(eq(chapters.id, input.chapterId), isNull(chapters.deletedAt)))
          .limit(1);
        return latest
          ? { status: 'conflict', chapter: mapChapterRow(latest) }
          : { status: 'not_found' };
      });
    },

    async applyAiContent(
      input: ApplyAiChapterContentRecordInput,
    ): Promise<ApplyAiChapterContentOutcome> {
      return db.transaction(async (tx) => {
        // 1. 读取活跃章节（已软删视为不存在）。
        const [current] = await tx
          .select()
          .from(chapters)
          .where(and(eq(chapters.id, input.chapterId), isNull(chapters.deletedAt)))
          .limit(1);

        if (!current) {
          return { status: 'not_found' };
        }

        // 2. 乐观锁前置校验：版本不匹配时直接返回，绝不写入脏快照。
        if (current.version !== input.expectedVersion) {
          return { status: 'conflict', chapter: mapChapterRow(current) };
        }

        // 3. 先为应用前的原稿留底（`source: 'ai'`，不可变快照）。
        const [revision] = await tx
          .insert(chapterRevisions)
          .values({
            chapterId: current.id,
            version: current.version,
            source: 'ai',
            note: input.note,
            titleSnapshot: current.title,
            contentText: current.contentText,
            contentJson: current.contentJson,
            wordCount: current.wordCount,
          })
          .returning();

        if (!revision) {
          throw new Error('AI 正文应用失败：写入留底快照未返回记录。');
        }

        // 4. 条件更新（带乐观锁）；并发被抢时返回 0 行。
        const [row] = await tx
          .update(chapters)
          .set({
            contentText: input.contentText,
            ...(input.contentJson === undefined ? {} : { contentJson: input.contentJson }),
            wordCount: input.wordCount,
            version: sql`${chapters.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chapters.id, input.chapterId),
              isNull(chapters.deletedAt),
              eq(chapters.version, input.expectedVersion),
            ),
          )
          .returning();

        if (row) {
          return {
            status: 'applied',
            chapter: mapChapterRow(row),
            backupRevision: mapRevisionRow(revision),
          };
        }

        // 并发抢占：事务回滚会抹除上方的快照写入。
        const [latest] = await tx
          .select()
          .from(chapters)
          .where(and(eq(chapters.id, input.chapterId), isNull(chapters.deletedAt)))
          .limit(1);
        return latest
          ? { status: 'conflict', chapter: mapChapterRow(latest) }
          : { status: 'not_found' };
      });
    },

    async reorder(bookId, items) {
      await db.transaction(async (tx) => {
        for (const item of items) {
          await tx
            .update(chapters)
            .set({ volumeId: item.volumeId, sortOrder: item.sortOrder, updatedAt: new Date() })
            .where(and(eq(chapters.id, item.chapterId), eq(chapters.bookId, bookId)));
        }
      });
    },
  };
}
