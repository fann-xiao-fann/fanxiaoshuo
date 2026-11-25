import { z } from 'zod';
import {
  CHAPTER_STATUSES,
  MAX_CHAPTER_CONTENT_LENGTH,
  chapterStatusSchema,
} from '../constants/books.js';
import { bookDtoSchema } from './book.js';
import { isoDateTimeSchema, nonNegativeIntSchema, trimmedText, uuidSchema } from './primitives.js';
import { volumeDtoSchema } from './volume.js';

/** 章节标题长度上限。 */
export const CHAPTER_TITLE_MAX_LENGTH = 120;

/** 章节版本号：正整数乐观锁序号。 */
export const chapterVersionSchema = z.number().int().positive();

/**
 * TipTap（ProseMirror）文档 JSON。
 * 结构由前端编辑器保证，共享包只做「顶层必须是对象」的宽松校验，
 * 避免把编辑器节点协议复制进契约层。
 */
export const tiptapJsonSchema = z
  .record(z.string(), z.unknown())
  .describe('TipTap / ProseMirror 文档 JSON（顶层对象）');

export type TiptapJson = z.infer<typeof tiptapJsonSchema>;

/** 章节正文纯文本上限（归一化后段落以 `\n\n` 分隔）。 */
export const chapterContentTextSchema = z.string().max(MAX_CHAPTER_CONTENT_LENGTH);

/**
 * 卷章树中的章节元信息（**不含正文**，保证百章级目录树响应体积小）。
 * `volumeId` 为 null 表示「未分卷章节」。
 */
export const chapterTreeItemSchema = z
  .strictObject({
    id: uuidSchema,
    bookId: uuidSchema,
    volumeId: uuidSchema.nullable(),
    title: z.string().min(1).max(CHAPTER_TITLE_MAX_LENGTH),
    sortOrder: nonNegativeIntSchema,
    status: chapterStatusSchema,
    wordCount: nonNegativeIntSchema,
    version: chapterVersionSchema,
    /** 非 null 表示位于本书回收站 */
    deletedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .describe('卷章树章节节点（轻量元信息，不含正文）');

export type ChapterTreeItem = z.infer<typeof chapterTreeItemSchema>;

/** 卷章树分卷节点：分卷聚合信息 + 该卷下的章节列表（按 `sortOrder` 升序）。 */
export const volumeTreeNodeSchema = z
  .strictObject({
    ...volumeDtoSchema.shape,
    chapters: z.array(chapterTreeItemSchema),
  })
  .describe('卷章树分卷节点');

export type VolumeTreeNode = z.infer<typeof volumeTreeNodeSchema>;

/** `GET /api/v1/books/:bookId/tree` 响应。 */
export const bookTreeResponseSchema = z
  .strictObject({
    book: bookDtoSchema,
    volumes: z.array(volumeTreeNodeSchema),
    /** `volumeId` 为 null 的章节（未分卷区） */
    ungroupedChapters: z.array(chapterTreeItemSchema),
    /** 本书回收站中的节点总数（卷 + 章），前端据此展示回收站入口徽标 */
    trashCount: nonNegativeIntSchema,
  })
  .describe('整本书卷章树响应（不含章节正文）');

export type BookTreeResponse = z.infer<typeof bookTreeResponseSchema>;

/** `GET /api/v1/books/:bookId/trash` 响应（本书下已软删除的卷与章）。 */
export const bookTrashResponseSchema = z
  .strictObject({
    volumes: z.array(volumeDtoSchema),
    chapters: z.array(chapterTreeItemSchema),
  })
  .describe('本书回收站内容');

export type BookTrashResponse = z.infer<typeof bookTrashResponseSchema>;

/** `POST /api/v1/books/:bookId/chapters` 请求体（新建章自动追加到对应末尾）。 */
export const createChapterSchema = z
  .strictObject({
    /** 省略或 null 表示创建为「未分卷章节」 */
    volumeId: uuidSchema.nullable().optional(),
    title: trimmedText(CHAPTER_TITLE_MAX_LENGTH),
    status: chapterStatusSchema.default(CHAPTER_STATUSES[1]),
  })
  .describe('新建章节请求');

export type CreateChapterInput = z.infer<typeof createChapterSchema>;
export type CreateChapterInputPayload = z.input<typeof createChapterSchema>;

/**
 * `PATCH /api/v1/chapters/:chapterId` 请求体：改标题 / 状态 / 所属卷（跨卷移动）。
 * `volumeId: null` 表示移入「未分卷区」。
 */
export const updateChapterMetaSchema = z
  .strictObject({
    title: trimmedText(CHAPTER_TITLE_MAX_LENGTH).optional(),
    status: chapterStatusSchema.optional(),
    volumeId: uuidSchema.nullable().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: '至少需要提供一个待更新字段',
  })
  .describe('更新章节元信息请求（标题 / 状态 / 所属卷）');

export type UpdateChapterMetaInput = z.infer<typeof updateChapterMetaSchema>;
export type UpdateChapterMetaInputPayload = z.input<typeof updateChapterMetaSchema>;

/** 单条章节重排指令。 */
export const chapterReorderItemSchema = z.strictObject({
  chapterId: uuidSchema,
  /** 目标卷；null 表示移动到「未分卷区」 */
  volumeId: uuidSchema.nullable(),
  /** 目标卷内的新排序序号 */
  sortOrder: nonNegativeIntSchema,
});

export type ChapterReorderItem = z.infer<typeof chapterReorderItemSchema>;

/**
 * `PUT /api/v1/books/:bookId/chapters/reorder` 请求体。
 * 支持同卷排序与跨卷移动；服务端在单事务内校验全部章节归属同一本书。
 */
export const reorderChaptersSchema = z
  .strictObject({
    items: z.array(chapterReorderItemSchema).min(1).max(2_000),
  })
  .refine(
    (value) => new Set(value.items.map((item) => item.chapterId)).size === value.items.length,
    { message: '同一章节在单次重排请求中只能出现一次', path: ['items'] },
  )
  .describe('章节排序 / 跨卷移动请求');

export type ReorderChaptersInput = z.infer<typeof reorderChaptersSchema>;

/** 章节详情 DTO（编辑器加载完整正文时使用）。 */
export const chapterDetailDtoSchema = z
  .strictObject({
    id: uuidSchema,
    bookId: uuidSchema,
    volumeId: uuidSchema.nullable(),
    title: z.string().min(1).max(CHAPTER_TITLE_MAX_LENGTH),
    sortOrder: nonNegativeIntSchema,
    status: chapterStatusSchema,
    /** 服务端归一化后的纯文本正文 */
    contentText: chapterContentTextSchema,
    /** TipTap 文档 JSON；历史数据可能只有纯文本时为 null */
    contentJson: tiptapJsonSchema.nullable(),
    /** 服务端按 `countNovelWords` 重算的字数 */
    wordCount: nonNegativeIntSchema,
    version: chapterVersionSchema,
    deletedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .describe('章节详情 DTO（含正文与乐观锁版本号）');

export type ChapterDetailDto = z.infer<typeof chapterDetailDtoSchema>;

/**
 * `PUT /api/v1/chapters/:chapterId/content` 请求体。
 * `expectedVersion` 为乐观锁版本号；`forceOverwrite` 仅在用户处理冲突并先留底快照后显式传入。
 */
export const saveChapterContentSchema = z
  .strictObject({
    title: trimmedText(CHAPTER_TITLE_MAX_LENGTH).optional(),
    contentText: chapterContentTextSchema,
    contentJson: tiptapJsonSchema.nullable().optional(),
    expectedVersion: chapterVersionSchema,
    forceOverwrite: z.boolean().default(false),
  })
  .describe('保存章节正文请求（乐观并发）');

export type SaveChapterContentInput = z.infer<typeof saveChapterContentSchema>;
export type SaveChapterContentInputPayload = z.input<typeof saveChapterContentSchema>;

/** `PUT /api/v1/chapters/:chapterId/content` 响应。 */
export const chapterSaveResponseSchema = z
  .strictObject({
    chapter: chapterDetailDtoSchema,
    /** 本次保存是否按节流策略追加了一条 `auto` 快照 */
    autoRevisionCreated: z.boolean(),
  })
  .describe('保存章节正文响应');

export type ChapterSaveResponse = z.infer<typeof chapterSaveResponseSchema>;
