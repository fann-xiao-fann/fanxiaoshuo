import { z } from 'zod';

/**
 * Book Bible（作品设定记忆层）与章内 AI 写作的领域枚举 / 中文展示名 / 预算常量。
 *
 * 服务端（Drizzle 列默认值、上下文组装与 SSE 发送）、`packages/agents`（Prompt 与召回）
 * 与前端（分类标签、动作按钮、Token 预算滑块）必须共用此处的字面量，
 * 禁止各自硬编码导致前后端枚举漂移。
 */

/* -------------------------------------------------------------------------- */
/*                                  设定卡分类                                 */
/* -------------------------------------------------------------------------- */

/** 6 类结构化设定卡：人物 / 世界观 / 势力 / 物品（金手指）/ 伏笔 / 时间线。 */
export const KNOWLEDGE_CARD_CATEGORIES = [
  'character',
  'world',
  'faction',
  'item',
  'foreshadowing',
  'timeline',
] as const;

export const knowledgeCardCategorySchema = z.enum(KNOWLEDGE_CARD_CATEGORIES);

export type KnowledgeCardCategory = z.infer<typeof knowledgeCardCategorySchema>;

/** 设定卡分类中文展示名（设定集面板的分类标签页与筛选器共用）。 */
export const KNOWLEDGE_CARD_CATEGORY_LABELS = {
  character: '人物',
  world: '世界观',
  faction: '势力',
  item: '物品/金手指',
  foreshadowing: '伏笔',
  timeline: '时间线',
} as const satisfies Record<KnowledgeCardCategory, string>;

/* -------------------------------------------------------------------------- */
/*                                  摘要来源                                   */
/* -------------------------------------------------------------------------- */

/** 章节摘要来源：`manual` 用户手工编辑 / `ai` lorekeeper 从正文提炼。 */
export const CHAPTER_SUMMARY_SOURCES = ['manual', 'ai'] as const;

export const chapterSummarySourceSchema = z.enum(CHAPTER_SUMMARY_SOURCES);

export type ChapterSummarySource = z.infer<typeof chapterSummarySourceSchema>;

/** 章节摘要来源中文展示名（本章记忆标签页的来源徽标共用）。 */
export const CHAPTER_SUMMARY_SOURCE_LABELS = {
  manual: '手工维护',
  ai: 'AI 提炼',
} as const satisfies Record<ChapterSummarySource, string>;

/* -------------------------------------------------------------------------- */
/*                                章内写作动作                                 */
/* -------------------------------------------------------------------------- */

/** 编辑器内 4 种 AI 写作动作：续写 / 扩写 / 改写 / 润色。 */
export const AI_WRITE_ACTIONS = ['continue', 'expand', 'rewrite', 'polish'] as const;

export const aiWriteActionSchema = z.enum(AI_WRITE_ACTIONS);

export type AiWriteAction = z.infer<typeof aiWriteActionSchema>;

/** 写作动作中文展示名（AI 助手动作按钮与 Prompt 选择器共用）。 */
export const AI_WRITE_ACTION_LABELS = {
  continue: '续写',
  expand: '扩写',
  rewrite: '改写',
  polish: '润色',
} as const satisfies Record<AiWriteAction, string>;

/* -------------------------------------------------------------------------- */
/*                                正文应用模式                                 */
/* -------------------------------------------------------------------------- */

/** AI 正文应用模式：追加到文末 / 替换全文 / 替换选中片段。 */
export const AI_APPLY_MODES = ['append', 'replace_all', 'replace_selection'] as const;

export const aiApplyModeSchema = z.enum(AI_APPLY_MODES);

export type AiApplyMode = z.infer<typeof aiApplyModeSchema>;

/** 应用模式中文展示名（应用确认弹窗的按钮文案共用）。 */
export const AI_APPLY_MODE_LABELS = {
  append: '追加到文末',
  replace_all: '替换全文',
  replace_selection: '替换选中片段',
} as const satisfies Record<AiApplyMode, string>;

/* -------------------------------------------------------------------------- */
/*                                SSE 事件名                                   */
/* -------------------------------------------------------------------------- */

/**
 * 章内 AI 写作 SSE 帧名（`event:` 字段），与 `SSE_EVENT_NAMES` 同构但独立命名，
 * 避免两套流式协议的帧名被误混用。
 */
export const AI_STREAM_EVENT_NAMES = {
  /** 首帧：模型、上下文预算与召回卡片清单 */
  start: 'start',
  /** 增量正文帧 */
  delta: 'delta',
  /** 终帧：Token / 费用 / 耗时 / usageLogId */
  done: 'done',
  /** 错误帧：脱敏错误码与信息 */
  error: 'error',
} as const;

export type AiStreamEventName = (typeof AI_STREAM_EVENT_NAMES)[keyof typeof AI_STREAM_EVENT_NAMES];

/* -------------------------------------------------------------------------- */
/*                              设定卡召回原因                                 */
/* -------------------------------------------------------------------------- */

/** 设定卡被纳入上下文的原因：手动勾选 > 常驻置顶 > 关键词/向量自动召回。 */
export const CONTEXT_CARD_RECALL_REASONS = ['selected', 'pinned', 'recalled'] as const;

export const contextCardRecallReasonSchema = z.enum(CONTEXT_CARD_RECALL_REASONS);

export type ContextCardRecallReason = z.infer<typeof contextCardRecallReasonSchema>;

/** 召回原因中文展示名（上下文预览中卡片清单的来源标注共用）。 */
export const CONTEXT_CARD_RECALL_REASON_LABELS = {
  selected: '手动勾选',
  pinned: '常驻置顶',
  recalled: '智能召回',
} as const satisfies Record<ContextCardRecallReason, string>;

/* -------------------------------------------------------------------------- */
/*                              上下文预算常量                                 */
/* -------------------------------------------------------------------------- */

/** 单次上下文 Token 预算默认值（网文单章 3000 字 + 设定与前情约 8000 token）。 */
export const DEFAULT_MAX_CONTEXT_TOKENS = 8_000;

/** 上下文 Token 预算下限（低于该值几乎无法容纳总大纲与当前章细纲）。 */
export const MIN_MAX_CONTEXT_TOKENS = 1_000;

/** 上下文 Token 预算上限（防御性上限，避免误输入天文数字打爆上游上下文窗口）。 */
export const MAX_MAX_CONTEXT_TOKENS = 128_000;

/** 默认召回的前序章节摘要条数。 */
export const DEFAULT_RECENT_SUMMARIES_COUNT = 3;

/** 前序章节摘要条数上限。 */
export const MAX_RECENT_SUMMARIES_COUNT = 10;

/** 默认拼接的上一章尾部正文字数（衔接上下文）。 */
export const DEFAULT_PREV_CHAPTER_TAIL_CHARS = 800;

/** 上一章尾部衔接字数上限。 */
export const MAX_PREV_CHAPTER_TAIL_CHARS = 4_000;

/** 自动召回设定卡的最大张数（不含手动勾选与常驻置顶卡片）。 */
export const MAX_RECALLED_CARDS = 8;

/* -------------------------------------------------------------------------- */
/*                                字段长度上限                                 */
/* -------------------------------------------------------------------------- */

/** 总大纲单个字段（主线 / 世界观 / 文风 / 结局）长度上限。 */
export const MAX_BOOK_OUTLINE_FIELD_LENGTH = 50_000;

/** 设定卡标题长度上限。 */
export const MAX_CARD_TITLE_LENGTH = 100;

/** 设定卡摘要长度上限（进入上下文的高频字段，必须精炼）。 */
export const MAX_CARD_SUMMARY_LENGTH = 1_000;

/** 设定卡详细设定长度上限。 */
export const MAX_CARD_CONTENT_LENGTH = 20_000;

/** 设定卡单个别名长度上限。 */
export const MAX_CARD_ALIAS_LENGTH = 60;

/** 设定卡别名数量上限。 */
export const MAX_CARD_ALIASES_COUNT = 20;

/** 设定卡单个标签长度上限。 */
export const MAX_CARD_TAG_LENGTH = 40;

/** 设定卡标签数量上限。 */
export const MAX_CARD_TAGS_COUNT = 20;

/** 本章细纲长度上限。 */
export const MAX_CHAPTER_OUTLINE_LENGTH = 10_000;

/** 本章剧情摘要长度上限。 */
export const MAX_CHAPTER_SUMMARY_LENGTH = 10_000;

/** 单轮 AI 写作指令长度上限。 */
export const MAX_AI_INSTRUCTION_LENGTH = 4_000;
