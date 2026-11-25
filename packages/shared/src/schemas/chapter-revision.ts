import { z } from 'zod';
import { revisionSourceSchema } from '../constants/books.js';
import { chapterContentTextSchema, chapterDetailDtoSchema, chapterVersionSchema, tiptapJsonSchema } from './chapter.js';
import { isoDateTimeSchema, nonNegativeIntSchema, uuidSchema } from './primitives.js';

/** 快照备注长度上限。 */
export const REVISION_NOTE_MAX_LENGTH = 200;

/** 历史快照元信息（版本历史列表项，不含正文）。 */
export const chapterRevisionSummarySchema = z
  .strictObject({
    id: uuidSchema,
    chapterId: uuidSchema,
    /** 快照产生时的章节版本号 */
    version: chapterVersionSchema,
    source: revisionSourceSchema,
    /** 备注，无备注时为空字符串 */
    note: z.string().max(REVISION_NOTE_MAX_LENGTH),
    /** 快照时刻的章节标题（章节改名后历史仍可读） */
    titleSnapshot: z.string().min(1).max(120),
    wordCount: nonNegativeIntSchema,
    createdAt: isoDateTimeSchema,
  })
  .describe('章节历史快照元信息');

export type ChapterRevisionSummary = z.infer<typeof chapterRevisionSummarySchema>;

/** 历史快照详情（预览 / 回滚前确认时返回完整正文）。 */
export const chapterRevisionDetailSchema = z
  .strictObject({
    ...chapterRevisionSummarySchema.shape,
    contentText: chapterContentTextSchema,
    contentJson: tiptapJsonSchema.nullable(),
  })
  .describe('章节历史快照详情（含正文）');

export type ChapterRevisionDetail = z.infer<typeof chapterRevisionDetailSchema>;

/** `POST /api/v1/chapters/:chapterId/revisions` 请求体（手动命名快照）。 */
export const createChapterRevisionSchema = z
  .strictObject({
    note: z.string().trim().max(REVISION_NOTE_MAX_LENGTH).optional(),
  })
  .describe('手动创建章节快照请求');

export type CreateChapterRevisionInput = z.infer<typeof createChapterRevisionSchema>;
export type CreateChapterRevisionInputPayload = z.input<typeof createChapterRevisionSchema>;

/** `GET /api/v1/chapters/:chapterId/revisions` 响应（按创建时间倒序）。 */
export const chapterRevisionListResponseSchema = z
  .strictObject({
    items: z.array(chapterRevisionSummarySchema),
    total: nonNegativeIntSchema,
  })
  .describe('章节历史快照列表响应');

export type ChapterRevisionListResponse = z.infer<typeof chapterRevisionListResponseSchema>;

/**
 * `POST /api/v1/chapters/:chapterId/revisions/:revisionId/restore` 响应。
 * `backupRevision` 为回滚前对当前正文自动留底的 `restore` 快照，可用于二次恢复。
 */
export const restoreChapterRevisionResponseSchema = z
  .strictObject({
    chapter: chapterDetailDtoSchema,
    backupRevision: chapterRevisionSummarySchema,
  })
  .describe('回滚至历史快照响应');

export type RestoreChapterRevisionResponse = z.infer<typeof restoreChapterRevisionResponseSchema>;
