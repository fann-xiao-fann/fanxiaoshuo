import { z } from 'zod';
import { agentRoleSchema } from '../constants/agent-roles.js';
import { MAX_CHAPTER_CONTENT_LENGTH } from '../constants/books.js';
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_RECENT_SUMMARIES_COUNT,
  MAX_AI_INSTRUCTION_LENGTH,
  MAX_CARD_TITLE_LENGTH,
  MAX_MAX_CONTEXT_TOKENS,
  MAX_RECENT_SUMMARIES_COUNT,
  MIN_MAX_CONTEXT_TOKENS,
  aiApplyModeSchema,
  aiWriteActionSchema,
  contextCardRecallReasonSchema,
  knowledgeCardCategorySchema,
} from '../constants/book-bible.js';
import { apiErrorCodeSchema } from '../errors.js';
import {
  chapterContentTextSchema,
  chapterDetailDtoSchema,
  chapterVersionSchema,
  tiptapJsonSchema,
} from './chapter.js';
import { REVISION_NOTE_MAX_LENGTH, chapterRevisionSummarySchema } from './chapter-revision.js';
import { nonNegativeIntSchema, tokenCountSchema, usdAmountSchema, uuidSchema } from './primitives.js';

/* -------------------------------------------------------------------------- */
/*                          上下文组装共享请求字段                             */
/* -------------------------------------------------------------------------- */

/** 手动勾选设定卡数量上限（防御性上限，避免单个请求携带过多 ID）。 */
const MAX_SELECTED_CARD_IDS = 50;

/** 单章目标字数范围（与 `DEFAULT_TARGET_CHAPTER_WORDS` 同量级）。 */
const MIN_TARGET_WORDS = 100;
const MAX_TARGET_WORDS = 10_000;

/**
 * 上下文组装请求的共享字段（预览与流式写作共用同一套语义，
 * 保证「预览所见 = 生成所用」）。
 */
export const aiContextOptionsShape = {
  action: aiWriteActionSchema,
  /** 本轮写作指令（可空） */
  instruction: z.string().trim().max(MAX_AI_INSTRUCTION_LENGTH).default(''),
  /** 编辑器当前选区文本（扩写 / 改写 / 润色聚焦该段） */
  selectedText: z.string().max(MAX_CHAPTER_CONTENT_LENGTH).optional(),
  /** 编辑器当前未保存正文（优先于服务端最新正文） */
  currentContentText: chapterContentTextSchema.optional(),
  /** 用户手动勾选的设定卡 ID 列表（最高优先级纳入上下文） */
  cardIds: z.array(uuidSchema).max(MAX_SELECTED_CARD_IDS).optional(),
  /** 是否纳入全书总大纲 */
  includeOutline: z.boolean().default(true),
  /** 是否拼接上一章尾部正文做衔接 */
  includePrevChapterTail: z.boolean().default(true),
  /** 纳入的前序章节摘要条数（0 表示不纳入） */
  maxRecentSummaries: z
    .number()
    .int()
    .min(0)
    .max(MAX_RECENT_SUMMARIES_COUNT)
    .default(DEFAULT_RECENT_SUMMARIES_COUNT),
  /** 上下文 Token 预算 */
  maxContextTokens: z
    .number()
    .int()
    .min(MIN_MAX_CONTEXT_TOKENS)
    .max(MAX_MAX_CONTEXT_TOKENS)
    .default(DEFAULT_MAX_CONTEXT_TOKENS),
  /** 期望生成的目标字数（未传则由 Prompt 按动作自行把握） */
  targetWords: z.number().int().min(MIN_TARGET_WORDS).max(MAX_TARGET_WORDS).optional(),
} as const;

/* -------------------------------------------------------------------------- */
/*                              上下文预算预览                                 */
/* -------------------------------------------------------------------------- */

/** `POST /api/v1/chapters/:chapterId/ai/context-preview` 请求体。 */
export const aiContextPreviewRequestSchema = z
  .strictObject(aiContextOptionsShape)
  .describe('上下文组装预览请求');

export type AiContextPreviewRequest = z.infer<typeof aiContextPreviewRequestSchema>;
export type AiContextPreviewRequestPayload = z.input<typeof aiContextPreviewRequestSchema>;

/** 上下文中的一个分段（总大纲 / 设定卡 / 前情摘要 / 上一章尾部 / 当前章 / 指令）。 */
export const aiContextSectionPreviewSchema = z
  .strictObject({
    /** 分段稳定标识，如 `book-outline` / `knowledge-cards` */
    key: z.string().min(1).max(64),
    /** 分段中文名（预览面板直接展示） */
    label: z.string().min(1).max(64),
    estimatedTokens: nonNegativeIntSchema,
    /** 该分段是否因预算裁剪而被截断 */
    truncated: z.boolean(),
    /** 分段正文预览（已按预算裁剪） */
    preview: z.string(),
  })
  .describe('上下文分段预览');

export type AiContextSectionPreview = z.infer<typeof aiContextSectionPreviewSchema>;

/** 被纳入上下文的设定卡（含纳入原因与相关性得分）。 */
export const aiContextSelectedCardSchema = z
  .strictObject({
    id: uuidSchema,
    title: z.string().min(1).max(MAX_CARD_TITLE_LENGTH),
    category: knowledgeCardCategorySchema,
    reason: contextCardRecallReasonSchema,
    /** 相关性得分：手动勾选 / 常驻卡片为 0（按优先级而非分数排序） */
    score: z.number().nonnegative(),
    estimatedTokens: nonNegativeIntSchema,
  })
  .describe('纳入上下文的设定卡');

export type AiContextSelectedCard = z.infer<typeof aiContextSelectedCardSchema>;

/** `POST /api/v1/chapters/:chapterId/ai/context-preview` 响应。 */
export const aiContextPreviewResponseSchema = z
  .strictObject({
    estimatedTokens: nonNegativeIntSchema,
    maxContextTokens: z.number().int().positive(),
    /** 任一分段被裁剪时为 true */
    truncated: z.boolean(),
    sections: z.array(aiContextSectionPreviewSchema),
    selectedCards: z.array(aiContextSelectedCardSchema),
    recentSummariesCount: nonNegativeIntSchema,
    /** 上一章标题，无上一章时为 null */
    prevChapterTitle: z.string().nullable(),
    systemPromptPreview: z.string(),
    userPromptPreview: z.string(),
  })
  .describe('上下文组装预览响应');

export type AiContextPreviewResponse = z.infer<typeof aiContextPreviewResponseSchema>;

/* -------------------------------------------------------------------------- */
/*                                流式写作请求                                 */
/* -------------------------------------------------------------------------- */

/** 单次生成的最大输出 Token 范围。 */
const MIN_MAX_OUTPUT_TOKENS = 64;
const MAX_MAX_OUTPUT_TOKENS = 32_000;

/** `POST /api/v1/chapters/:chapterId/ai/stream` 请求体（`POST + SSE`）。 */
export const aiChapterStreamRequestSchema = z
  .strictObject({
    ...aiContextOptionsShape,
    /** 请求角色，默认执笔写手；摘要类场景可显式指定 lorekeeper */
    role: agentRoleSchema.default('writer'),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z
      .number()
      .int()
      .min(MIN_MAX_OUTPUT_TOKENS)
      .max(MAX_MAX_OUTPUT_TOKENS)
      .optional(),
  })
  .describe('流式 AI 章节写作请求');

export type AiChapterStreamRequest = z.infer<typeof aiChapterStreamRequestSchema>;
export type AiChapterStreamRequestPayload = z.input<typeof aiChapterStreamRequestSchema>;

/* -------------------------------------------------------------------------- */
/*                              SSE 帧（4 种）                                 */
/* -------------------------------------------------------------------------- */

/** `event: start` —— 首帧，回传模型与上下文预算结果。 */
export const aiStreamStartEventSchema = z
  .strictObject({
    runId: uuidSchema,
    chapterId: uuidSchema,
    action: aiWriteActionSchema,
    role: agentRoleSchema,
    modelRef: z.string().min(1).max(256),
    estimatedContextTokens: nonNegativeIntSchema,
    truncated: z.boolean(),
    includedCardIds: z.array(uuidSchema),
  })
  .describe('AI 写作 SSE start 帧');

export type AiStreamStartEvent = z.infer<typeof aiStreamStartEventSchema>;

/** `event: delta` —— 增量正文帧。 */
export const aiStreamDeltaEventSchema = z
  .strictObject({
    runId: uuidSchema,
    /** 本次增量文本（可能为空串，前端直接拼接） */
    text: z.string(),
  })
  .describe('AI 写作 SSE delta 帧');

export type AiStreamDeltaEvent = z.infer<typeof aiStreamDeltaEventSchema>;

/** `event: done` —— 终帧，含用量与审计日志 ID。 */
export const aiStreamDoneEventSchema = z
  .strictObject({
    runId: uuidSchema,
    fullText: z.string(),
    finishReason: z.string().min(1).max(64),
    inputTokens: tokenCountSchema,
    outputTokens: tokenCountSchema,
    estimatedCostUsd: usdAmountSchema,
    latencyMs: nonNegativeIntSchema,
    modelRef: z.string().min(1).max(256),
    /** 审计日志 ID；落盘失败时为 null */
    usageLogId: uuidSchema.nullable(),
  })
  .describe('AI 写作 SSE done 帧');

export type AiStreamDoneEvent = z.infer<typeof aiStreamDoneEventSchema>;

/** `event: error` —— 错误帧（`message` 必须已脱敏）。 */
export const aiStreamErrorEventSchema = z
  .strictObject({
    runId: uuidSchema,
    code: apiErrorCodeSchema,
    message: z.string().min(1).max(2000),
  })
  .describe('AI 写作 SSE error 帧');

export type AiStreamErrorEvent = z.infer<typeof aiStreamErrorEventSchema>;

/* -------------------------------------------------------------------------- */
/*                              原子应用 AI 正文                                */
/* -------------------------------------------------------------------------- */

/** `POST /api/v1/chapters/:chapterId/ai/apply` 请求体（携带乐观锁版本号）。 */
export const applyAiChapterContentSchema = z
  .strictObject({
    expectedVersion: chapterVersionSchema,
    action: aiWriteActionSchema,
    mode: aiApplyModeSchema,
    contentText: chapterContentTextSchema,
    contentJson: tiptapJsonSchema.nullable().optional(),
    /** 写入原因备注（写入 `source: 'ai'` 留底快照） */
    note: z.string().trim().max(REVISION_NOTE_MAX_LENGTH).optional(),
  })
  .describe('原子应用 AI 生成正文请求');

export type ApplyAiChapterContentInput = z.infer<typeof applyAiChapterContentSchema>;
export type ApplyAiChapterContentInputPayload = z.input<typeof applyAiChapterContentSchema>;

/**
 * `POST /api/v1/chapters/:chapterId/ai/apply` 响应。
 * `backupRevision` 为写入前对原稿自动留底的 `source: 'ai'` 快照，可用于一键回滚。
 */
export const applyAiChapterContentResponseSchema = z
  .strictObject({
    chapter: chapterDetailDtoSchema,
    backupRevision: chapterRevisionSummarySchema,
  })
  .describe('原子应用 AI 正文响应');

export type ApplyAiChapterContentResponse = z.infer<typeof applyAiChapterContentResponseSchema>;
