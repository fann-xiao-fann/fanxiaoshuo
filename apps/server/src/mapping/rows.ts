import type {
  BookOutlineRow,
  BookRow,
  ChapterRevisionRow,
  ChapterRow,
  ChapterSummaryRow,
  KnowledgeCardRow,
  VolumeRow,
} from '../db/schema.js';
import { parseBookStatus, parseChapterStatus, parseRevisionSource } from '../domain/books.js';
import {
  chapterSummarySourceSchema,
  knowledgeCardCategorySchema,
  type ChapterSummarySource,
  type KnowledgeCardCategory,
} from '@fanxiaoshuo/shared';
import type {
  BookOutlineRecord,
  BookRecord,
  ChapterMetaRecord,
  ChapterRecord,
  ChapterRevisionRecord,
  ChapterSummaryRecord,
  KnowledgeCardRecord,
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

/* -------------------------------------------------------------------------- */
/*                    Change 3：Book Bible 行 → 领域记录                    */
/* -------------------------------------------------------------------------- */

/** 设定卡分类脏数据兜底（非法值归入 `world`，避免整页 500）。 */
const FALLBACK_CARD_CATEGORY: KnowledgeCardCategory = 'world';

/** 章节摘要来源脏数据兜底（非法值归入 `manual`）。 */
const FALLBACK_SUMMARY_SOURCE: ChapterSummarySource = 'manual';

/** jsonb `string[]` 列容错归一化（丢弃非字符串与空白项）。 */
export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function mapBookOutlineRow(row: BookOutlineRow): BookOutlineRecord {
  return {
    bookId: row.bookId,
    mainPlot: row.mainPlot,
    worldSetting: row.worldSetting,
    styleGuide: row.styleGuide,
    endingPlan: row.endingPlan,
    updatedAt: row.updatedAt,
  };
}

export function mapKnowledgeCardRow(row: KnowledgeCardRow): KnowledgeCardRecord {
  const parsedCategory = knowledgeCardCategorySchema.safeParse(row.category);
  return {
    id: row.id,
    bookId: row.bookId,
    category: parsedCategory.success ? parsedCategory.data : FALLBACK_CARD_CATEGORY,
    title: row.title,
    summary: row.summary,
    content: row.content,
    aliases: toStringArray(row.aliases),
    tags: toStringArray(row.tags),
    pinned: row.pinned,
    sortOrder: row.sortOrder,
    embedding: row.embedding ?? null,
    embeddingModelRef: row.embeddingModelRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapChapterSummaryRow(row: ChapterSummaryRow): ChapterSummaryRecord {
  const parsedSource = chapterSummarySourceSchema.safeParse(row.source);
  return {
    chapterId: row.chapterId,
    bookId: row.bookId,
    outline: row.outline,
    summary: row.summary,
    keyEvents: toStringArray(row.keyEvents),
    charactersPresent: toStringArray(row.charactersPresent),
    source: parsedSource.success ? parsedSource.data : FALLBACK_SUMMARY_SOURCE,
    updatedAt: row.updatedAt,
  };
}
