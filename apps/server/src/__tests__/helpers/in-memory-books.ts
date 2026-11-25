import { randomUUID } from 'node:crypto';
import { countNovelWords } from '@fanxiaoshuo/shared';
import { FORCE_OVERWRITE_BACKUP_NOTE } from '../../domain/books.js';
import type {
  BookAggregateRecord,
  BookListFilter,
  BookRecord,
  BookRepository,
  ChapterMetaRecord,
  ChapterRecord,
  ChapterRepository,
  ChapterRevisionRecord,
  ChapterRevisionRepository,
  ChapterSaveOutcome,
  CreateBookRecordInput,
  CreateChapterRecordInput,
  CreateChapterRevisionRecordInput,
  CreateVolumeRecordInput,
  RestoreChapterRevisionRecordInput,
  RestoreChapterRevisionResult,
  SaveChapterContentRecordInput,
  TrashScope,
  UpdateBookRecordPatch,
  UpdateChapterMetaRecordPatch,
  UpdateVolumeRecordPatch,
  VolumeAggregateRecord,
  VolumeRecord,
  VolumeRepository,
} from '../../repositories/types.js';

/**
 * 书库四仓储的内存实现（测试专用，与 Drizzle 实现语义逐条对齐）。
 *
 * 语义约定（与生产实现一致）：
 * - 聚合只统计未软删的卷与章；软删分卷下的章不计入全书汇总；
 * - `softDelete` 幂等，已删记录再次软删原样返回；
 * - 彻底删除分卷时，把该卷下章节的 `volumeId` 置 null（模拟 `ON DELETE SET NULL`）；
 * - 正文保存为乐观锁：`version` 不匹配返回 `conflict`，强制覆盖时先落 `restore` 备份快照。
 */

export interface InMemoryBookState {
  readonly books: Map<string, BookRecord>;
  readonly volumes: Map<string, VolumeRecord>;
  readonly chapters: Map<string, ChapterRecord>;
  readonly revisions: Map<string, ChapterRevisionRecord[]>;
}

export interface InMemoryBookRepositories {
  readonly books: BookRepository;
  readonly volumes: VolumeRepository;
  readonly chapters: ChapterRepository;
  readonly chapterRevisions: ChapterRevisionRepository;
  readonly state: InMemoryBookState;
}

function isActive(record: { readonly deletedAt: Date | null }): boolean {
  return record.deletedAt === null;
}

function bySortOrder<T extends { sortOrder: number; createdAt: Date }>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime();
}

function stripContent(record: ChapterRecord): ChapterMetaRecord {
  const { contentText: _contentText, contentJson: _contentJson, ...meta } = record;
  return meta;
}

export function createInMemoryBookRepositories(options: {
  now: () => Date;
}): InMemoryBookRepositories {
  const now = options.now;

  const bookMap = new Map<string, BookRecord>();
  const volumeMap = new Map<string, VolumeRecord>();
  const chapterMap = new Map<string, ChapterRecord>();
  const revisionMap = new Map<string, ChapterRevisionRecord[]>();

  function activeVolumeIdsOf(bookId: string): Set<string> {
    return new Set(
      [...volumeMap.values()]
        .filter((volume) => volume.bookId === bookId && isActive(volume))
        .map((volume) => volume.id),
    );
  }

  function aggregateOf(bookId: string): BookAggregateRecord | null {
    const book = bookMap.get(bookId);
    if (!book) {
      return null;
    }
    const activeVolumes = activeVolumeIdsOf(bookId);
    const activeChapters = [...chapterMap.values()].filter(
      (chapter) =>
        chapter.bookId === bookId &&
        isActive(chapter) &&
        (chapter.volumeId === null || activeVolumes.has(chapter.volumeId)),
    );
    return {
      book,
      volumeCount: activeVolumes.size,
      chapterCount: activeChapters.length,
      totalWordCount: activeChapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    };
  }

  function volumeAggregateOf(volume: VolumeRecord): VolumeAggregateRecord {
    const chapters = [...chapterMap.values()].filter(
      (chapter) => chapter.volumeId === volume.id && isActive(chapter),
    );
    return {
      volume,
      chapterCount: chapters.length,
      totalWordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    };
  }

  function nextVolumeSortOrder(bookId: string): number {
    const orders = [...volumeMap.values()]
      .filter((volume) => volume.bookId === bookId)
      .map((volume) => volume.sortOrder);
    return orders.length === 0 ? 0 : Math.max(...orders) + 1;
  }

  function nextChapterSortOrder(bookId: string, volumeId: string | null): number {
    const orders = [...chapterMap.values()]
      .filter((chapter) => chapter.bookId === bookId && chapter.volumeId === volumeId)
      .map((chapter) => chapter.sortOrder);
    return orders.length === 0 ? 0 : Math.max(...orders) + 1;
  }

  function revisionsOf(chapterId: string): ChapterRevisionRecord[] {
    const list = revisionMap.get(chapterId);
    if (!list) {
      revisionMap.set(chapterId, []);
      return revisionMap.get(chapterId) ?? [];
    }
    return list;
  }

  function sortedRevisions(chapterId: string): ChapterRevisionRecord[] {
    return [...revisionsOf(chapterId)].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.version - a.version,
    );
  }

  function insertRevision(input: CreateChapterRevisionRecordInput): ChapterRevisionRecord {
    const record: ChapterRevisionRecord = {
      id: randomUUID(),
      chapterId: input.chapterId,
      version: input.version,
      source: input.source,
      note: input.note,
      titleSnapshot: input.titleSnapshot,
      contentText: input.contentText,
      contentJson: input.contentJson,
      wordCount: input.wordCount,
      createdAt: now(),
    };
    revisionsOf(input.chapterId).push(record);
    return record;
  }

  const bookRepository: BookRepository = {
    async list(filter: BookListFilter) {
      const keyword = filter.q?.trim().toLowerCase() ?? '';
      const matched = [...bookMap.values()].filter((book) => {
        const inTrash = book.deletedAt !== null;
        if (filter.includeDeleted === 'only' ? !inTrash : inTrash) {
          return false;
        }
        if (filter.status !== undefined && book.status !== filter.status) {
          return false;
        }
        if (keyword.length === 0) {
          return true;
        }
        return [book.title, book.authorPenName, book.synopsis, book.genre].some((field) =>
          field.toLowerCase().includes(keyword),
        );
      });

      matched.sort(
        (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime(),
      );

      return matched.map((book) => aggregateOf(book.id)).filter((item): item is BookAggregateRecord => item !== null);
    },

    async findById(id) {
      return bookMap.get(id) ?? null;
    },

    async findAggregateById(id) {
      return aggregateOf(id);
    },

    async create(input: CreateBookRecordInput) {
      const at = now();
      const record: BookRecord = {
        id: randomUUID(),
        title: input.title,
        authorPenName: input.authorPenName,
        genre: input.genre,
        status: input.status,
        synopsis: input.synopsis,
        targetChapterWords: input.targetChapterWords,
        deletedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      bookMap.set(record.id, record);
      return record;
    },

    async update(id, patch: UpdateBookRecordPatch) {
      const current = bookMap.get(id);
      if (!current) {
        return null;
      }
      const next: BookRecord = { ...current, ...patch, updatedAt: now() };
      bookMap.set(id, next);
      return next;
    },

    async softDelete(id) {
      const current = bookMap.get(id);
      if (!current) {
        return null;
      }
      if (current.deletedAt !== null) {
        return current;
      }
      const at = now();
      const next: BookRecord = { ...current, deletedAt: at, updatedAt: at };
      bookMap.set(id, next);
      return next;
    },

    async restore(id) {
      const current = bookMap.get(id);
      if (!current) {
        return null;
      }
      const next: BookRecord = { ...current, deletedAt: null, updatedAt: now() };
      bookMap.set(id, next);
      return next;
    },

    async purge(id) {
      if (!bookMap.has(id)) {
        return false;
      }
      for (const chapter of [...chapterMap.values()]) {
        if (chapter.bookId === id) {
          chapterMap.delete(chapter.id);
          revisionMap.delete(chapter.id);
        }
      }
      for (const volume of [...volumeMap.values()]) {
        if (volume.bookId === id) {
          volumeMap.delete(volume.id);
        }
      }
      bookMap.delete(id);
      return true;
    },
  };

  const volumeRepository: VolumeRepository = {
    async listByBook(bookId: string, scope: TrashScope) {
      return [...volumeMap.values()]
        .filter(
          (volume) =>
            volume.bookId === bookId &&
            (scope === 'deleted' ? volume.deletedAt !== null : isActive(volume)),
        )
        .sort(bySortOrder)
        .map(volumeAggregateOf);
    },

    async findById(id) {
      return volumeMap.get(id) ?? null;
    },

    async create(input: CreateVolumeRecordInput) {
      const at = now();
      const record: VolumeRecord = {
        id: randomUUID(),
        bookId: input.bookId,
        title: input.title,
        summary: input.summary,
        sortOrder: input.sortOrder ?? nextVolumeSortOrder(input.bookId),
        deletedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      volumeMap.set(record.id, record);
      return record;
    },

    async update(id, patch: UpdateVolumeRecordPatch) {
      const current = volumeMap.get(id);
      if (!current) {
        return null;
      }
      const next: VolumeRecord = { ...current, ...patch, updatedAt: now() };
      volumeMap.set(id, next);
      return next;
    },

    async softDelete(id) {
      const current = volumeMap.get(id);
      if (!current) {
        return null;
      }
      if (current.deletedAt !== null) {
        return current;
      }
      const at = now();
      const next: VolumeRecord = { ...current, deletedAt: at, updatedAt: at };
      volumeMap.set(id, next);
      return next;
    },

    async restore(id) {
      const current = volumeMap.get(id);
      if (!current) {
        return null;
      }
      const next: VolumeRecord = { ...current, deletedAt: null, updatedAt: now() };
      volumeMap.set(id, next);
      return next;
    },

    async purge(id) {
      if (!volumeMap.has(id)) {
        return false;
      }
      // 模拟外键 `ON DELETE SET NULL`：卷下章节移入未分卷区，正文不丢。
      for (const chapter of [...chapterMap.values()]) {
        if (chapter.volumeId === id) {
          chapterMap.set(chapter.id, { ...chapter, volumeId: null, updatedAt: now() });
        }
      }
      volumeMap.delete(id);
      return true;
    },

    async reorder(bookId, volumeIds) {
      for (const [index, volumeId] of volumeIds.entries()) {
        const current = volumeMap.get(volumeId);
        if (!current || current.bookId !== bookId) {
          continue;
        }
        volumeMap.set(volumeId, { ...current, sortOrder: index, updatedAt: now() });
      }
    },
  };

  const chapterRepository: ChapterRepository = {
    async listByBook(bookId: string, scope: TrashScope) {
      return [...chapterMap.values()]
        .filter(
          (chapter) =>
            chapter.bookId === bookId &&
            (scope === 'deleted' ? chapter.deletedAt !== null : isActive(chapter)),
        )
        .sort(bySortOrder)
        .map(stripContent);
    },

    async listWithContentByBook(bookId) {
      return [...chapterMap.values()]
        .filter((chapter) => chapter.bookId === bookId)
        .sort(bySortOrder);
    },

    async findById(id) {
      return chapterMap.get(id) ?? null;
    },

    async create(input: CreateChapterRecordInput) {
      const at = now();
      const record: ChapterRecord = {
        id: randomUUID(),
        bookId: input.bookId,
        volumeId: input.volumeId,
        title: input.title,
        sortOrder: input.sortOrder ?? nextChapterSortOrder(input.bookId, input.volumeId),
        status: input.status,
        contentText: '',
        contentJson: null,
        wordCount: 0,
        version: 1,
        deletedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      chapterMap.set(record.id, record);
      return record;
    },

    async updateMeta(id, patch: UpdateChapterMetaRecordPatch) {
      const current = chapterMap.get(id);
      if (!current) {
        return null;
      }
      const movingVolume =
        patch.volumeId !== undefined && patch.volumeId !== current.volumeId;
      const sortOrder =
        patch.sortOrder ??
        (movingVolume
          ? nextChapterSortOrder(current.bookId, patch.volumeId ?? null)
          : undefined);
      const next: ChapterRecord = {
        ...current,
        ...patch,
        ...(sortOrder === undefined ? {} : { sortOrder }),
        updatedAt: now(),
      };
      chapterMap.set(id, next);
      return next;
    },

    async softDelete(id) {
      const current = chapterMap.get(id);
      if (!current) {
        return null;
      }
      if (current.deletedAt !== null) {
        return current;
      }
      const at = now();
      const next: ChapterRecord = { ...current, deletedAt: at, updatedAt: at };
      chapterMap.set(id, next);
      return next;
    },

    async restore(id) {
      const current = chapterMap.get(id);
      if (!current) {
        return null;
      }
      const next: ChapterRecord = { ...current, deletedAt: null, updatedAt: now() };
      chapterMap.set(id, next);
      return next;
    },

    async purge(id) {
      if (!chapterMap.has(id)) {
        return false;
      }
      chapterMap.delete(id);
      revisionMap.delete(id);
      return true;
    },

    async saveContent(input: SaveChapterContentRecordInput): Promise<ChapterSaveOutcome> {
      const current = chapterMap.get(input.chapterId);
      if (!current || current.deletedAt !== null) {
        return { status: 'not_found' };
      }
      if (!input.forceOverwrite && current.version !== input.expectedVersion) {
        return { status: 'conflict', chapter: current };
      }

      let backupRevision: ChapterRevisionRecord | null = null;
      if (input.forceOverwrite) {
        backupRevision = insertRevision({
          chapterId: current.id,
          version: current.version,
          source: 'restore',
          note: FORCE_OVERWRITE_BACKUP_NOTE,
          titleSnapshot: current.title,
          contentText: current.contentText,
          contentJson: current.contentJson,
          wordCount: current.wordCount,
        });
      }

      const next: ChapterRecord = {
        ...current,
        title: input.title ?? current.title,
        contentText: input.contentText,
        contentJson: input.contentJson === undefined ? current.contentJson : input.contentJson,
        wordCount: input.wordCount,
        version: current.version + 1,
        updatedAt: now(),
      };
      chapterMap.set(current.id, next);
      return { status: 'saved', chapter: next, backupRevision };
    },

    async reorder(bookId, items) {
      for (const item of items) {
        const current = chapterMap.get(item.chapterId);
        if (!current || current.bookId !== bookId) {
          continue;
        }
        chapterMap.set(current.id, {
          ...current,
          volumeId: item.volumeId,
          sortOrder: item.sortOrder,
          updatedAt: now(),
        });
      }
    },
  };

  const chapterRevisionRepository: ChapterRevisionRepository = {
    async listByChapter(chapterId) {
      return sortedRevisions(chapterId);
    },

    async findById(revisionId) {
      for (const list of revisionMap.values()) {
        const found = list.find((revision) => revision.id === revisionId);
        if (found) {
          return found;
        }
      }
      return null;
    },

    async findLatestByChapter(chapterId) {
      return sortedRevisions(chapterId)[0] ?? null;
    },

    async findLatestBySource(chapterId, source) {
      return sortedRevisions(chapterId).find((revision) => revision.source === source) ?? null;
    },

    async create(input) {
      return insertRevision(input);
    },

    async restore(
      input: RestoreChapterRevisionRecordInput,
    ): Promise<RestoreChapterRevisionResult | null> {
      const current = chapterMap.get(input.chapterId);
      if (!current || current.deletedAt !== null) {
        return null;
      }
      const backupRevision = insertRevision(input.backup);
      const next: ChapterRecord = {
        ...current,
        title: input.restore.title,
        contentText: input.restore.contentText,
        contentJson: input.restore.contentJson,
        wordCount: input.restore.wordCount,
        version: current.version + 1,
        updatedAt: now(),
      };
      chapterMap.set(current.id, next);
      return { chapter: next, backupRevision };
    },
  };

  return {
    books: bookRepository,
    volumes: volumeRepository,
    chapters: chapterRepository,
    chapterRevisions: chapterRevisionRepository,
    state: {
      books: bookMap,
      volumes: volumeMap,
      chapters: chapterMap,
      revisions: revisionMap,
    },
  };
}

/** 供测试快速计算字数（与服务端一致，避免测试里手写期望值时口径漂移）。 */
export function expectedWordCount(text: string): number {
  return countNovelWords(text);
}
