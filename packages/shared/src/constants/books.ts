import { z } from 'zod';

/**
 * 书库 / 卷章 / 快照 / 导出相关领域枚举与运行常量。
 *
 * 服务端（Drizzle 列默认值）、Worker（Change 4 批量成文）与前端（状态标签、导出菜单）
 * 必须共用此处的字面量与中文展示名，禁止各自硬编码。
 */

/* -------------------------------------------------------------------------- */
/*                                    书籍状态                                 */
/* -------------------------------------------------------------------------- */

/** 作品写作状态：草稿 → 连载中 → 已完结 / 已归档。 */
export const BOOK_STATUSES = ['draft', 'ongoing', 'completed', 'archived'] as const;

export const bookStatusSchema = z.enum(BOOK_STATUSES);

export type BookStatus = z.infer<typeof bookStatusSchema>;

/** 书籍状态中文展示名（书架筛选器与状态徽标共用）。 */
export const BOOK_STATUS_LABELS = {
  draft: '草稿',
  ongoing: '连载中',
  completed: '已完结',
  archived: '已归档',
} as const satisfies Record<BookStatus, string>;

/* -------------------------------------------------------------------------- */
/*                                    章节状态                                 */
/* -------------------------------------------------------------------------- */

/** 章节状态：细纲 → 草稿 → 待审 → 定稿。 */
export const CHAPTER_STATUSES = ['outline', 'draft', 'reviewing', 'final'] as const;

export const chapterStatusSchema = z.enum(CHAPTER_STATUSES);

export type ChapterStatus = z.infer<typeof chapterStatusSchema>;

/** 章节状态中文展示名（卷章树状态点与编辑器状态选择器共用）。 */
export const CHAPTER_STATUS_LABELS = {
  outline: '细纲',
  draft: '草稿',
  reviewing: '待审',
  final: '定稿',
} as const satisfies Record<ChapterStatus, string>;

/* -------------------------------------------------------------------------- */
/*                                  快照来源                                   */
/* -------------------------------------------------------------------------- */

/**
 * 历史快照来源：
 * - `manual` 用户手动命名快照
 * - `auto` 保存正文时按节流间隔自动留底
 * - `restore` 回滚前对当前正文的自动备份（安全网）
 * - `ai` Change 4 后台 Worker 改写前留底
 */
export const REVISION_SOURCES = ['manual', 'auto', 'restore', 'ai'] as const;

export const revisionSourceSchema = z.enum(REVISION_SOURCES);

export type RevisionSource = z.infer<typeof revisionSourceSchema>;

/** 快照来源中文展示名（历史版本抽屉共用）。 */
export const REVISION_SOURCE_LABELS = {
  manual: '手动快照',
  auto: '自动快照',
  restore: '回滚备份',
  ai: 'AI 生成',
} as const satisfies Record<RevisionSource, string>;

/* -------------------------------------------------------------------------- */
/*                                  导出格式                                   */
/* -------------------------------------------------------------------------- */

/** 整本导出格式：纯文本 / Markdown。 */
export const EXPORT_FORMATS = ['txt', 'md'] as const;

export const exportFormatSchema = z.enum(EXPORT_FORMATS);

export type ExportFormat = z.infer<typeof exportFormatSchema>;

/** 导出格式元信息：文件扩展名与响应 `Content-Type`（服务端下载头唯一来源）。 */
export const EXPORT_FORMAT_META = {
  txt: {
    label: '纯文本',
    extension: 'txt',
    contentType: 'text/plain; charset=utf-8',
  },
  md: {
    label: 'Markdown',
    extension: 'md',
    contentType: 'text/markdown; charset=utf-8',
  },
} as const satisfies Record<
  ExportFormat,
  { readonly label: string; readonly extension: string; readonly contentType: string }
>;

/* -------------------------------------------------------------------------- */
/*                                  运行常量                                   */
/* -------------------------------------------------------------------------- */

/** 自动快照节流间隔：距上一次 `auto` 快照超过 5 分钟才再次留底，防止快照表被写爆。 */
export const AUTO_REVISION_INTERVAL_MS = 5 * 60 * 1000;

/** 单章正文最大字符数（防止异常报文打垮 Fastify / 浏览器内存）。 */
export const MAX_CHAPTER_CONTENT_LENGTH = 500_000;

/** 新建书籍时单章目标字数默认值（网文单章常见 3000 字）。 */
export const DEFAULT_TARGET_CHAPTER_WORDS = 3000;

/** 单章目标字数上限（防御性上限，避免误输入天文数字）。 */
export const MAX_TARGET_CHAPTER_WORDS = 50_000;
