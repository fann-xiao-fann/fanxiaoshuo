import type {
  BookOutlineRow,
  BookRow,
  ChapterRevisionRow,
  ChapterRow,
  ChapterSummaryRow,
  KnowledgeCardRow,
  VolumeRow,
  WorkflowRunRow,
  WorkflowStepRow,
} from '../db/schema.js';
import { parseBookStatus, parseChapterStatus, parseRevisionSource } from '../domain/books.js';
import {
  apiErrorCodeSchema,
  chapterSummarySourceSchema,
  knowledgeCardCategorySchema,
  workflowModeSchema,
  workflowPauseReasonSchema,
  workflowRunConfigSchema,
  workflowRunStatusSchema,
  workflowStepStageSchema,
  workflowStepStatusSchema,
  type ChapterSummarySource,
  type KnowledgeCardCategory,
  type WorkflowMode,
  type WorkflowRunConfig,
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
  WorkflowRunRecord,
  WorkflowStepRecord,
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

/* -------------------------------------------------------------------------- */
/*               Change 4：批量流水线行 → 领域记录（含脏数据兜底）               */
/* -------------------------------------------------------------------------- */

/** 批次配置快照脏数据兜底：非法 `config_json` 退化为全部默认值，避免详情页 500。 */
export function parseWorkflowRunConfig(value: unknown): WorkflowRunConfig {
  const parsed = workflowRunConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : workflowRunConfigSchema.parse({});
}

/** 批次主表行 + 关联 `books.title`（列表 / 详情查询共同列）。 */
export type WorkflowRunRowWithBookTitle = WorkflowRunRow & { readonly bookTitle: string | null };

/** numeric 列（字符串）→ number；脏值归零并保留 6 位小数。 */
export function parseNumeric(value: string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 可空 numeric 列 → number | null。 */
export function parseNullableNumeric(value: string | null | undefined): number | null {
  return value === null || value === undefined ? null : parseNumeric(value);
}

export function mapWorkflowRunRow(row: WorkflowRunRowWithBookTitle): WorkflowRunRecord {
  const parsedMode = workflowModeSchema.safeParse(row.mode);
  const parsedStatus = workflowRunStatusSchema.safeParse(row.status);
  const parsedPauseReason =
    row.pauseReason === null ? null : workflowPauseReasonSchema.safeParse(row.pauseReason);

  return {
    id: row.id,
    bookId: row.bookId,
    bookTitle: row.bookTitle ?? '',
    // 非法枚举属于数据损坏：回退到最保守的可用取值，而非整页抛错
    mode: parsedMode.success ? parsedMode.data : FALLBACK_WORKFLOW_MODE,
    status: parsedStatus.success ? parsedStatus.data : 'failed',
    config: parseWorkflowRunConfig(row.configJson),
    totalSteps: row.totalSteps,
    completedSteps: row.completedSteps,
    failedSteps: row.failedSteps,
    maxCostUsd: parseNullableNumeric(row.maxCostUsd),
    spentCostUsd: parseNumeric(row.spentCostUsd),
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    pauseRequested: row.pauseRequested,
    cancelRequested: row.cancelRequested,
    pauseReason:
      parsedPauseReason !== null && parsedPauseReason.success ? parsedPauseReason.data : null,
    errorCode: parseApiErrorCodeOrNull(row.errorCode),
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapWorkflowStepRow(row: WorkflowStepRow): WorkflowStepRecord {
  const parsedStatus = workflowStepStatusSchema.safeParse(row.status);
  const parsedStage = workflowStepStageSchema.safeParse(row.stage);

  return {
    id: row.id,
    runId: row.runId,
    chapterId: row.chapterId,
    stepIndex: row.stepIndex,
    chapterTitleSnapshot: row.chapterTitleSnapshot,
    status: parsedStatus.success ? parsedStatus.data : 'failed',
    stage: parsedStage.success ? parsedStage.data : 'idle',
    reworkCount: row.reworkCount,
    criticScore: row.criticScore,
    criticPassed: row.criticPassed,
    criticSummary: row.criticSummary,
    criticIssues: toStringArray(row.criticIssuesJson),
    outputWordCount: row.outputWordCount,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    estimatedCostUsd: parseNumeric(row.estimatedCostUsd),
    backupRevisionId: row.backupRevisionId,
    errorCode: parseApiErrorCodeOrNull(row.errorCode),
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 批次模式脏数据兜底（非法值归入最轻量的 `outline_only`）。 */
const FALLBACK_WORKFLOW_MODE: WorkflowMode = 'outline_only';

/** `error_code` 文本 → 受控错误码（未知值归 null，避免详情接口整体 500）。 */
function parseApiErrorCodeOrNull(value: string | null): WorkflowRunRecord['errorCode'] {
  if (value === null) {
    return null;
  }
  const parsed = apiErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
