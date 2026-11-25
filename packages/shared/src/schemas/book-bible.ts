import { z } from 'zod';
import {
  MAX_BOOK_OUTLINE_FIELD_LENGTH,
  MAX_CARD_ALIAS_LENGTH,
  MAX_CARD_ALIASES_COUNT,
  MAX_CARD_CONTENT_LENGTH,
  MAX_CARD_SUMMARY_LENGTH,
  MAX_CARD_TAG_LENGTH,
  MAX_CARD_TAGS_COUNT,
  MAX_CARD_TITLE_LENGTH,
  MAX_CHAPTER_OUTLINE_LENGTH,
  MAX_CHAPTER_SUMMARY_LENGTH,
  chapterSummarySourceSchema,
  knowledgeCardCategorySchema,
} from '../constants/book-bible.js';
import {
  isoDateTimeSchema,
  nonNegativeIntSchema,
  tokenCountSchema,
  trimmedText,
  usdAmountSchema,
  uuidSchema,
} from './primitives.js';

/* -------------------------------------------------------------------------- */
/*                                  全书总大纲                                 */
/* -------------------------------------------------------------------------- */

/** 总大纲单字段文本（允许为空串，表示尚未填写）。 */
const bookOutlineTextFieldSchema = z.string().max(MAX_BOOK_OUTLINE_FIELD_LENGTH);

/**
 * 全书总大纲 DTO。
 * 新书尚未保存时服务端返回空字段结构 + `updatedAt: null`（不返回 404）。
 */
export const bookOutlineDtoSchema = z
  .strictObject({
    bookId: uuidSchema,
    /** 核心主线 */
    mainPlot: bookOutlineTextFieldSchema,
    /** 世界观概览 */
    worldSetting: bookOutlineTextFieldSchema,
    /** 文风与禁忌 */
    styleGuide: bookOutlineTextFieldSchema,
    /** 阶段与结局规划 */
    endingPlan: bookOutlineTextFieldSchema,
    updatedAt: isoDateTimeSchema.nullable(),
  })
  .describe('全书总大纲 DTO');

export type BookOutlineDto = z.infer<typeof bookOutlineDtoSchema>;

/** `PUT /api/v1/books/:bookId/outline` 请求体（整段覆盖，未传字段置空）。 */
export const upsertBookOutlineSchema = z
  .strictObject({
    mainPlot: bookOutlineTextFieldSchema.default(''),
    worldSetting: bookOutlineTextFieldSchema.default(''),
    styleGuide: bookOutlineTextFieldSchema.default(''),
    endingPlan: bookOutlineTextFieldSchema.default(''),
  })
  .describe('保存全书总大纲请求');

export type UpsertBookOutlineInput = z.infer<typeof upsertBookOutlineSchema>;
export type UpsertBookOutlineInputPayload = z.input<typeof upsertBookOutlineSchema>;

/* -------------------------------------------------------------------------- */
/*                                  设定卡                                     */
/* -------------------------------------------------------------------------- */

/** 单条关键事件 / 出场人物名称长度上限。 */
const KEY_EVENT_MAX_LENGTH = 200;
const CHARACTER_NAME_MAX_LENGTH = 80;

/** 关键事件条数上限。 */
const MAX_KEY_EVENTS_COUNT = 30;

/** 出场人物条数上限。 */
const MAX_CHARACTERS_PRESENT_COUNT = 50;

/** 设定卡列表关键字搜索长度上限。 */
const MAX_CARD_SEARCH_LENGTH = 100;

/**
 * 设定卡 DTO。
 * 向量列只暴露 `hasEmbedding` 与 `embeddingModelRef`，绝不下发原始浮点数组。
 */
export const knowledgeCardDtoSchema = z
  .strictObject({
    id: uuidSchema,
    bookId: uuidSchema,
    category: knowledgeCardCategorySchema,
    title: z.string().min(1).max(MAX_CARD_TITLE_LENGTH),
    summary: z.string().max(MAX_CARD_SUMMARY_LENGTH),
    content: z.string().max(MAX_CARD_CONTENT_LENGTH),
    aliases: z.array(z.string().min(1).max(MAX_CARD_ALIAS_LENGTH)),
    tags: z.array(z.string().min(1).max(MAX_CARD_TAG_LENGTH)),
    /** 是否常驻置顶（每次组装上下文都纳入） */
    pinned: z.boolean(),
    sortOrder: nonNegativeIntSchema,
    /** 是否已生成向量（未配置 Embedding 模型时为 false） */
    hasEmbedding: z.boolean(),
    /** 向量模型引用 `provider/modelId`，未向量化时为 null */
    embeddingModelRef: z.string().max(256).nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .describe('设定卡 DTO（不含原始向量）');

export type KnowledgeCardDto = z.infer<typeof knowledgeCardDtoSchema>;

/** 查询串中的空字符串视为「未传」（Fastify 会把 `?q=` 解析为空串）。 */
function emptyToUndefined<S extends z.ZodType>(schema: S) {
  return z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? undefined : value),
    schema,
  );
}

/**
 * 查询串布尔值：兼容 Fastify 的 `'true' / 'false'` 字符串形式，
 * 输出仍为契约中的 `boolean`。
 */
const optionalQueryBoolean = emptyToUndefined(
  z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .optional(),
);

/** `GET /api/v1/books/:bookId/cards` 查询串。 */
export const knowledgeCardListQuerySchema = z
  .strictObject({
    category: emptyToUndefined(knowledgeCardCategorySchema.optional()),
    /** 标题 / 别名 / 摘要 / 正文关键字（服务端做大小写不敏感模糊匹配） */
    q: emptyToUndefined(z.string().trim().max(MAX_CARD_SEARCH_LENGTH).optional()),
    pinned: optionalQueryBoolean,
  })
  .describe('设定卡列表查询（分类 / 关键字 / 常驻状态）');

export type KnowledgeCardListQuery = z.infer<typeof knowledgeCardListQuerySchema>;
export type KnowledgeCardListQueryPayload = z.input<typeof knowledgeCardListQuerySchema>;

/** `GET /api/v1/books/:bookId/cards` 响应。 */
export const knowledgeCardListResponseSchema = z
  .strictObject({
    items: z.array(knowledgeCardDtoSchema),
    total: nonNegativeIntSchema,
  })
  .describe('设定卡列表响应');

export type KnowledgeCardListResponse = z.infer<typeof knowledgeCardListResponseSchema>;

/** `POST /api/v1/books/:bookId/cards` 请求体。 */
export const createKnowledgeCardSchema = z
  .strictObject({
    category: knowledgeCardCategorySchema,
    title: trimmedText(MAX_CARD_TITLE_LENGTH),
    summary: z.string().max(MAX_CARD_SUMMARY_LENGTH).default(''),
    content: z.string().max(MAX_CARD_CONTENT_LENGTH).default(''),
    aliases: z.array(trimmedText(MAX_CARD_ALIAS_LENGTH)).max(MAX_CARD_ALIASES_COUNT).default([]),
    tags: z.array(trimmedText(MAX_CARD_TAG_LENGTH)).max(MAX_CARD_TAGS_COUNT).default([]),
    pinned: z.boolean().default(false),
  })
  .describe('新建设定卡请求');

export type CreateKnowledgeCardInput = z.infer<typeof createKnowledgeCardSchema>;
export type CreateKnowledgeCardInputPayload = z.input<typeof createKnowledgeCardSchema>;

/** `PATCH /api/v1/books/:bookId/cards/:cardId` 请求体（至少提供一个待更新字段）。 */
export const updateKnowledgeCardSchema = z
  .strictObject({
    category: knowledgeCardCategorySchema.optional(),
    title: trimmedText(MAX_CARD_TITLE_LENGTH).optional(),
    summary: z.string().max(MAX_CARD_SUMMARY_LENGTH).optional(),
    content: z.string().max(MAX_CARD_CONTENT_LENGTH).optional(),
    aliases: z.array(trimmedText(MAX_CARD_ALIAS_LENGTH)).max(MAX_CARD_ALIASES_COUNT).optional(),
    tags: z.array(trimmedText(MAX_CARD_TAG_LENGTH)).max(MAX_CARD_TAGS_COUNT).optional(),
    pinned: z.boolean().optional(),
    sortOrder: nonNegativeIntSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: '至少需要提供一个待更新字段',
  })
  .describe('更新设定卡请求（含置顶切换与排序）');

export type UpdateKnowledgeCardInput = z.infer<typeof updateKnowledgeCardSchema>;
export type UpdateKnowledgeCardInputPayload = z.input<typeof updateKnowledgeCardSchema>;

/* -------------------------------------------------------------------------- */
/*                              章节细纲与摘要                                 */
/* -------------------------------------------------------------------------- */

/** 章节摘要 DTO（`updatedAt: null` 表示尚未填写）。 */
export const chapterSummaryDtoSchema = z
  .strictObject({
    chapterId: uuidSchema,
    bookId: uuidSchema,
    outline: z.string().max(MAX_CHAPTER_OUTLINE_LENGTH),
    summary: z.string().max(MAX_CHAPTER_SUMMARY_LENGTH),
    keyEvents: z.array(z.string().min(1).max(KEY_EVENT_MAX_LENGTH)),
    charactersPresent: z.array(z.string().min(1).max(CHARACTER_NAME_MAX_LENGTH)),
    source: chapterSummarySourceSchema,
    updatedAt: isoDateTimeSchema.nullable(),
  })
  .describe('章节细纲与剧情摘要 DTO');

export type ChapterSummaryDto = z.infer<typeof chapterSummaryDtoSchema>;

/** `PUT /api/v1/chapters/:chapterId/summary` 请求体（至少提供一个待更新字段）。 */
export const upsertChapterSummarySchema = z
  .strictObject({
    outline: z.string().max(MAX_CHAPTER_OUTLINE_LENGTH).optional(),
    summary: z.string().max(MAX_CHAPTER_SUMMARY_LENGTH).optional(),
    keyEvents: z.array(trimmedText(KEY_EVENT_MAX_LENGTH)).max(MAX_KEY_EVENTS_COUNT).optional(),
    charactersPresent: z
      .array(trimmedText(CHARACTER_NAME_MAX_LENGTH))
      .max(MAX_CHARACTERS_PRESENT_COUNT)
      .optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: '至少需要提供一个待更新字段',
  })
  .describe('手工保存章节细纲与摘要请求');

export type UpsertChapterSummaryInput = z.infer<typeof upsertChapterSummarySchema>;
export type UpsertChapterSummaryInputPayload = z.input<typeof upsertChapterSummarySchema>;

/** AI 提炼指令长度上限（比写作指令更短，聚焦摘要口径）。 */
const MAX_EXTRACT_INSTRUCTION_LENGTH = 1_000;

/** `POST /api/v1/chapters/:chapterId/summary/extract` 请求体。 */
export const extractChapterSummarySchema = z
  .strictObject({
    /** true = 提炼后直接以 `source: 'ai'` 落盘（保留原有细纲）；false = 仅返回结果 */
    save: z.boolean().default(true),
    instruction: trimmedText(MAX_EXTRACT_INSTRUCTION_LENGTH).optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .describe('lorekeeper 从正文提炼章节摘要请求');

export type ExtractChapterSummaryInput = z.infer<typeof extractChapterSummarySchema>;
export type ExtractChapterSummaryInputPayload = z.input<typeof extractChapterSummarySchema>;

/** 一次模型调用的用量摘要（与 `llm_usage_logs` 记录一一对应）。 */
export const aiUsageSummarySchema = z
  .strictObject({
    inputTokens: tokenCountSchema,
    outputTokens: tokenCountSchema,
    estimatedCostUsd: usdAmountSchema,
    latencyMs: nonNegativeIntSchema,
  })
  .describe('模型调用用量摘要');

export type AiUsageSummary = z.infer<typeof aiUsageSummarySchema>;

/** `POST /api/v1/chapters/:chapterId/summary/extract` 响应。 */
export const extractChapterSummaryResponseSchema = z
  .strictObject({
    summary: chapterSummaryDtoSchema,
    usage: aiUsageSummarySchema,
    modelRef: z.string().min(1).max(256),
    /** 审计日志 ID；落盘失败时为 null（不影响摘要返回） */
    usageLogId: uuidSchema.nullable(),
  })
  .describe('lorekeeper 摘要提炼响应');

export type ExtractChapterSummaryResponse = z.infer<typeof extractChapterSummaryResponseSchema>;
