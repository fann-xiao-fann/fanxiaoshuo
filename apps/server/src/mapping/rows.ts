import type {
  BookRow,
  ChapterRevisionRow,
  ChapterRow,
  VolumeRow,
} from '../db/schema.js';
import { parseBookStatus, parseChapterStatus, parseRevisionSource } from '../domain/books.js';
import type {
  BookRecord,
  ChapterMetaRecord,
  ChapterRecord,
  ChapterRevisionRecord,
  VolumeRecord,
} from '../repositories/types.js';

/**
 * PostgreSQL 行 → 领域记录映射（唯一入口）。
 *
 * 集中在 `mapping/rows.ts`，避免各仓储互相 import 造成循环依赖；
 * `status` / `source` 等 text 列统一经领域函数兜底解析。
 */

export function mapBookRow(row: BookRow): BookRecord {
  return {
    id: row.id,
    title: row.title,
    authorPenName: row.authorPenName,
    genre: row.genre,
    status: parseBookStatus(row.status),
    synopsis: row.synopsis,
    targetChapterWords: row.targetChapterWords,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapVolumeRow(row: VolumeRow): VolumeRecord {
  return {
    id: row.id,
    bookId: row.bookId,
    title: row.title,
    summary: row.summary,
    sortOrder: row.sortOrder,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapChapterRow(row: ChapterRow): ChapterRecord {
  return {
    id: row.id,
    bookId: row.bookId,
    volumeId: row.volumeId,
    title: row.title,
    sortOrder: row.sortOrder,
    status: parseChapterStatus(row.status),
    contentText: row.contentText,
    contentJson: row.contentJson ?? null,
    wordCount: row.wordCount,
    version: row.version,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 卷章树 / 回收站查询列（不含正文，保证响应轻量）。 */
export type ChapterMetaRow = Pick<
  ChapterRow,
  | 'id'
  | 'bookId'
  | 'volumeId'
  | 'title'
  | 'sortOrder'
  | 'status'
  | 'wordCount'
  | 'version'
  | 'deletedAt'
  | 'createdAt'
  | 'updatedAt'
>;

/** 剥离正文，卷章树 / 回收站接口专用。 */
export function mapChapterMetaRow(row: ChapterMetaRow): ChapterMetaRecord {
  return {
    id: row.id,
    bookId: row.bookId,
    volumeId: row.volumeId,
    title: row.title,
    sortOrder: row.sortOrder,
    status: parseChapterStatus(row.status),
    wordCount: row.wordCount,
    version: row.version,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapRevisionRow(row: ChapterRevisionRow): ChapterRevisionRecord {
  return {
    id: row.id,
    chapterId: row.chapterId,
    version: row.version,
    source: parseRevisionSource(row.source),
    note: row.note,
    titleSnapshot: row.titleSnapshot,
    contentText: row.contentText,
    contentJson: row.contentJson ?? null,
    wordCount: row.wordCount,
    createdAt: row.createdAt,
  };
}
