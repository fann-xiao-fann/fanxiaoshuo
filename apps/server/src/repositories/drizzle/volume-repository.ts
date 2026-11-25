import { and, asc, eq, isNotNull, isNull, max, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { chapters, volumes } from '../../db/schema.js';
import { mapVolumeRow } from '../../mapping/rows.js';
import type {
  CreateVolumeRecordInput,
  TrashScope,
  UpdateVolumeRecordPatch,
  VolumeAggregateRecord,
  VolumeRecord,
  VolumeRepository,
} from '../types.js';

/** 按 `sortOrder` 与创建时间稳定排序（内存归并用）。 */
function compareSortOrder(a: VolumeRecord, b: VolumeRecord): number {
  return a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime();
}

/** Drizzle 实现的分卷仓储（卷内章数与字数聚合只统计未软删章节）。 */
export function createDrizzleVolumeRepository(db: Database): VolumeRepository {
  /** 取本书未软删章节聚合（用于卷内统计）。 */
  async function loadChapterAggregates(
    bookId: string,
  ): Promise<Map<string, { chapterCount: number; totalWordCount: number }>> {
    const rows = await db
      .select({
        volumeId: chapters.volumeId,
        wordCount: chapters.wordCount,
      })
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), isNull(chapters.deletedAt)));

    const aggregates = new Map<string, { chapterCount: number; totalWordCount: number }>();
    for (const row of rows) {
      if (row.volumeId === null) {
        continue;
      }
      const current = aggregates.get(row.volumeId) ?? { chapterCount: 0, totalWordCount: 0 };
      current.chapterCount += 1;
      current.totalWordCount += row.wordCount;
      aggregates.set(row.volumeId, current);
    }
    return aggregates;
  }

  /** 追加到末尾时的下一个 `sortOrder`。 */
  async function nextSortOrder(bookId: string): Promise<number> {
    const [row] = await db
      .select({ value: max(volumes.sortOrder) })
      .from(volumes)
      .where(eq(volumes.bookId, bookId));
    return (row?.value ?? -1) + 1;
  }

  return {
    async listByBook(bookId: string, scope: TrashScope) {
      const rows = await db
        .select()
        .from(volumes)
        .where(
          and(
            eq(volumes.bookId, bookId),
            scope === 'deleted' ? isNotNull(volumes.deletedAt) : isNull(volumes.deletedAt),
          ),
        )
        .orderBy(asc(volumes.sortOrder), asc(volumes.createdAt));

      const aggregates = await loadChapterAggregates(bookId);

      const records: VolumeAggregateRecord[] = rows.map((row) => {
        const aggregate = aggregates.get(row.id);
        return {
          volume: mapVolumeRow(row),
          chapterCount: aggregate?.chapterCount ?? 0,
          totalWordCount: aggregate?.totalWordCount ?? 0,
        };
      });

      records.sort((left, right) => compareSortOrder(left.volume, right.volume));
      return records;
    },

    async findById(id) {
      const [row] = await db.select().from(volumes).where(eq(volumes.id, id)).limit(1);
      return row ? mapVolumeRow(row) : null;
    },

    async create(input: CreateVolumeRecordInput) {
      const sortOrder = input.sortOrder ?? (await nextSortOrder(input.bookId));
      const [row] = await db
        .insert(volumes)
        .values({
          bookId: input.bookId,
          title: input.title,
          summary: input.summary,
          sortOrder,
        })
        .returning();
      if (!row) {
        throw new Error('分卷创建失败：数据库未返回记录。');
      }
      return mapVolumeRow(row);
    },

    async update(id, patch: UpdateVolumeRecordPatch) {
      const [row] = await db
        .update(volumes)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(volumes.id, id))
        .returning();
      return row ? mapVolumeRow(row) : null;
    },

    async softDelete(id) {
      const [row] = await db
        .update(volumes)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(volumes.id, id), isNull(volumes.deletedAt)))
        .returning();
      if (row) {
        return mapVolumeRow(row);
      }
      const [existing] = await db.select().from(volumes).where(eq(volumes.id, id)).limit(1);
      return existing ? mapVolumeRow(existing) : null;
    },

    async restore(id) {
      const [row] = await db
        .update(volumes)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(volumes.id, id))
        .returning();
      return row ? mapVolumeRow(row) : null;
    },

    async purge(id) {
      // 外键 `ON DELETE SET NULL` 会自动把该卷下未删章节移入「未分卷区」。
      const rows = await db.delete(volumes).where(eq(volumes.id, id)).returning({ id: volumes.id });
      return rows.length > 0;
    },

    async reorder(bookId, volumeIds) {
      await db.transaction(async (tx) => {
        for (const [index, volumeId] of volumeIds.entries()) {
          await tx
            .update(volumes)
            .set({ sortOrder: index, updatedAt: sql`now()` })
            .where(and(eq(volumes.id, volumeId), eq(volumes.bookId, bookId)));
        }
      });
    },
  };
}
