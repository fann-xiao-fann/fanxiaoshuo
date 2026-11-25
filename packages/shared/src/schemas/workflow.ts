import { z } from 'zod';
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  MAX_AI_INSTRUCTION_LENGTH,
  MAX_MAX_CONTEXT_TOKENS,
  MIN_MAX_CONTEXT_TOKENS,
} from '../constants/book-bible.js';
import { PAGINATION } from '../constants/runtime.js';
import {
  DEFAULT_WORKFLOW_MAX_COST_USD,
  DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS,
  DEFAULT_WORKFLOW_MIN_PASS_SCORE,
  MAX_WORKFLOW_CHAPTERS_PER_RUN,
  MAX_WORKFLOW_MAX_COST_USD,
  MAX_WORKFLOW_REWORK_ROUNDS,
  MIN_WORKFLOW_MAX_COST_USD,
  workflowEventTypeSchema,
  workflowModeSchema,
  workflowPauseReasonSchema,
  workflowRunStatusSchema,
  workflowStepStageSchema,
  workflowStepStatusSchema,
} from '../constants/workflows.js';
import { apiErrorCodeSchema } from '../errors.js';
import {
  isoDateTimeSchema,
  nonNegativeIntSchema,
  tokenCountSchema,
  usdAmountSchema,
  uuidSchema,
} from './primitives.js';

/* -------------------------------------------------------------------------- */
/*                            创建批次请求（目标章节）                          */
/* -------------------------------------------------------------------------- */

/** 自动新建章节的标题前缀长度上限。 */
const MAX_CHAPTER_TITLE_PREFIX_LENGTH = 60;

/**
 * 自动新建章节配置（`chapterIds` 的互斥替代方案）。
 * `volumeId` 为 `null` 时由服务端落到默认分卷。
 */
export const autoCreateChaptersConfigSchema = z
  .strictObject({
    /** 目标分卷 ID；`null` 表示使用本书默认分卷 */
    volumeId: uuidSchema.nullable().default(null),
    /** 自动新建章节数量 */
    count: z.number().int().min(1).max(MAX_WORKFLOW_CHAPTERS_PER_RUN),
    /** 章节标题前缀（服务端拼接序号，如 `第1章`） */
    titlePrefix: z.string().trim().max(MAX_CHAPTER_TITLE_PREFIX_LENGTH).default('第'),
  })
  .describe('批量任务自动新建章节配置');

export type AutoCreateChaptersConfig = z.infer<typeof autoCreateChaptersConfigSchema>;
export type AutoCreateChaptersConfigPayload = z.input<typeof autoCreateChaptersConfigSchema>;

/* -------------------------------------------------------------------------- */
/*                                批次配置快照                                 */
/* -------------------------------------------------------------------------- */

/**
 * 批次配置快照（落盘 `workflow_runs.config_json`，Worker 与前端均以此为准）。
 * 创建批次时内联展开到请求体，续跑时不可变更（仅允许上调 `maxCostUsd`）。
 */
export const workflowRunConfigSchema = z
  .strictObject({
    /** 是否启用 `critic` 审稿质检 */
    enableCritic: z.boolean().default(true),
    /** 审稿及格分（0–100），低于该分触发返工 */
    minPassScore: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(DEFAULT_WORKFLOW_MIN_PASS_SCORE),
    /** 最大返工轮数（0 表示审稿不通过也不返工） */
    maxReworkRounds: z
      .number()
      .int()
      .min(0)
      .max(MAX_WORKFLOW_REWORK_ROUNDS)
      .default(DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS),
    /** 是否启用 `lorekeeper` 摘要提炼（供后续章节召回） */
    enableSummary: z.boolean().default(true),
    /** 单章目标字数；未传则由角色配置或默认值兜底 */
    targetWords: z.number().int().min(100).max(10_000).optional(),
    /** 单次上下文 Token 预算 */
    maxContextTokens: z
      .number()
      .int()
      .min(MIN_MAX_CONTEXT_TOKENS)
      .max(MAX_MAX_CONTEXT_TOKENS)
      .default(DEFAULT_MAX_CONTEXT_TOKENS),
    /** 全书通用的额外写作指令（可空） */
    instruction: z.string().trim().max(MAX_AI_INSTRUCTION_LENGTH).default(''),
  })
  .describe('批量任务配置快照');

export type WorkflowRunConfig = z.infer<typeof workflowRunConfigSchema>;
export type WorkflowRunConfigPayload = z.input<typeof workflowRunConfigSchema>;

/* -------------------------------------------------------------------------- */
/*                              创建 / 续跑请求                                */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/v1/workflows/runs` 请求体。
 * 目标章节二选一：`chapterIds`（已有章节）或 `autoCreateChapters`（自动新建）。
 */
export const createWorkflowRunSchema = z
  .strictObject({
    bookId: uuidSchema,
    mode: workflowModeSchema,
    /** 目标章节 ID（按阅读顺序执行，禁止重复） */
    chapterIds: z
      .array(uuidSchema)
      .min(1)
      .max(MAX_WORKFLOW_CHAPTERS_PER_RUN)
      .optional(),
    /** 自动新建章节配置（与 `chapterIds` 互斥） */
    autoCreateChapters: autoCreateChaptersConfigSchema.optional(),
    /** 预算上限（USD，`null` 表示不限制） */
    maxCostUsd: z
      .number()
      .min(MIN_WORKFLOW_MAX_COST_USD)
      .max(MAX_WORKFLOW_MAX_COST_USD)
      .nullable()
      .default(DEFAULT_WORKFLOW_MAX_COST_USD),
    ...workflowRunConfigSchema.shape,
  })
  .superRefine((value, ctx) => {
    const hasChapterIds = value.chapterIds !== undefined && value.chapterIds.length > 0;
    const hasAutoCreate = value.autoCreateChapters !== undefined;

    if (hasChapterIds === hasAutoCreate) {
      ctx.addIssue({
        code: 'custom',
        message: 'chapterIds 与 autoCreateChapters 必须且只能提供一个',
        path: hasChapterIds ? ['autoCreateChapters'] : ['chapterIds'],
      });
      return;
    }

    if (value.chapterIds !== undefined) {
      const seen = new Set<string>();
      for (const [index, chapterId] of value.chapterIds.entries()) {
        if (seen.has(chapterId)) {
          ctx.addIssue({
            code: 'custom',
            message: 'chapterIds 不允许包含重复章节',
            path: ['chapterIds', index],
          });
        }
        seen.add(chapterId);
      }
    }
  })
  .describe('创建批量流水线任务请求');

export type CreateWorkflowRunInput = z.infer<typeof createWorkflowRunSchema>;
export type CreateWorkflowRunInputPayload = z.input<typeof createWorkflowRunSchema>;

/** `POST /api/v1/workflows/runs/:runId/resume` 请求体（可选上调预算上限）。 */
export const resumeWorkflowRunSchema = z
  .strictObject({
    /** 新的预算上限（USD）；`null` 表示解除上限，未传则保持原值 */
    maxCostUsd: z
      .number()
      .min(MIN_WORKFLOW_MAX_COST_USD)
      .max(MAX_WORKFLOW_MAX_COST_USD)
      .nullable()
      .optional(),
  })
  .describe('断点续跑请求（可上调预算上限）');

export type ResumeWorkflowRunInput = z.infer<typeof resumeWorkflowRunSchema>;
export type ResumeWorkflowRunInputPayload = z.input<typeof resumeWorkflowRunSchema>;

/* -------------------------------------------------------------------------- */
/*                                 步骤 DTO                                    */
/* -------------------------------------------------------------------------- */

/** 审稿问题清单单条文本长度上限。 */
const MAX_CRITIC_ISSUE_LENGTH = 500;

/** 审稿总结 / 错误摘要长度上限（与 `llm_usage_logs.error_message` 保持一致）。 */
const MAX_SUMMARY_TEXT_LENGTH = 2_000;

/** 章节标题快照长度上限。 */
const MAX_CHAPTER_TITLE_SNAPSHOT_LENGTH = 120;

/** 单章步骤 DTO（批次详情的有序步骤时间线）。 */
export const workflowStepDtoSchema = z
  .strictObject({
    id: uuidSchema,
    runId: uuidSchema,
    chapterId: uuidSchema,
    /** 0-based 顺序序号（批次内按阅读顺序串行执行） */
    stepIndex: nonNegativeIntSchema,
    /** 入队时的章节标题快照（章节改名后仍可读） */
    chapterTitleSnapshot: z.string().min(1).max(MAX_CHAPTER_TITLE_SNAPSHOT_LENGTH),
    status: workflowStepStatusSchema,
    stage: workflowStepStageSchema,
    /** 已执行的返工轮数 */
    reworkCount: nonNegativeIntSchema,
    /** 最近一次审稿得分（0–100，未审稿为 null） */
    criticScore: z.number().int().min(0).max(100).nullable(),
    criticPassed: z.boolean().nullable(),
    criticSummary: z.string().max(MAX_SUMMARY_TEXT_LENGTH).nullable(),
    criticIssues: z.array(z.string().max(MAX_CRITIC_ISSUE_LENGTH)),
    outputWordCount: nonNegativeIntSchema,
    inputTokens: tokenCountSchema,
    outputTokens: tokenCountSchema,
    estimatedCostUsd: usdAmountSchema,
    /** 写回正文前留底的 `source: 'ai'` 快照 ID（未写入为 null） */
    backupRevisionId: uuidSchema.nullable(),
    errorCode: apiErrorCodeSchema.nullable(),
    /** 已脱敏错误摘要，禁止包含明文 Key */
    errorMessage: z.string().max(MAX_SUMMARY_TEXT_LENGTH).nullable(),
    startedAt: isoDateTimeSchema.nullable(),
    finishedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .describe('批量流水线单章步骤 DTO');

export type WorkflowStepDto = z.infer<typeof workflowStepDtoSchema>;

/* -------------------------------------------------------------------------- */
/*                              批次摘要 / 详情                                */
/* -------------------------------------------------------------------------- */

/** 书籍标题快照长度上限（与 `books.title` 契约保持一致）。 */
const MAX_BOOK_TITLE_LENGTH = 200;

/** 批次摘要 DTO（列表项与详情公共字段）。 */
export const workflowRunSummaryDtoSchema = z
  .strictObject({
    id: uuidSchema,
    bookId: uuidSchema,
    bookTitle: z.string().min(1).max(MAX_BOOK_TITLE_LENGTH),
    mode: workflowModeSchema,
    status: workflowRunStatusSchema,
    /** 创建时冻结的配置快照 */
    config: workflowRunConfigSchema,
    totalSteps: nonNegativeIntSchema,
    completedSteps: nonNegativeIntSchema,
    failedSteps: nonNegativeIntSchema,
    /** 预算上限（USD，`null` 表示不限） */
    maxCostUsd: usdAmountSchema.nullable(),
    spentCostUsd: usdAmountSchema,
    totalInputTokens: tokenCountSchema,
    totalOutputTokens: tokenCountSchema,
    pauseRequested: z.boolean(),
    cancelRequested: z.boolean(),
    pauseReason: workflowPauseReasonSchema.nullable(),
    errorCode: apiErrorCodeSchema.nullable(),
    errorMessage: z.string().max(MAX_SUMMARY_TEXT_LENGTH).nullable(),
    startedAt: isoDateTimeSchema.nullable(),
    finishedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .describe('批量流水线批次摘要 DTO');

export type WorkflowRunSummaryDto = z.infer<typeof workflowRunSummaryDtoSchema>;

/** 批次详情 DTO：摘要 + 按 `stepIndex` 升序的步骤列表。 */
export const workflowRunDetailDtoSchema = z
  .strictObject({
    ...workflowRunSummaryDtoSchema.shape,
    steps: z.array(workflowStepDtoSchema),
  })
  .describe('批量流水线批次详情 DTO（含有序步骤）');

export type WorkflowRunDetailDto = z.infer<typeof workflowRunDetailDtoSchema>;

/* -------------------------------------------------------------------------- */
/*                              列表查询与响应                                 */
/* -------------------------------------------------------------------------- */

/** 空字符串 / null 查询参数视为「未传」（Fastify 会把 `?status=` 解析为空串）。 */
function emptyToUndefined<S extends z.ZodType>(schema: S) {
  return z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    schema,
  );
}

/** `GET /api/v1/workflows/runs` 查询串（分页 + 书籍 / 状态筛选）。 */
export const workflowRunListQuerySchema = z
  .strictObject({
    bookId: emptyToUndefined(uuidSchema.optional()),
    status: emptyToUndefined(workflowRunStatusSchema.optional()),
    page: emptyToUndefined(
      z.coerce.number().int().min(1).default(PAGINATION.defaultPage),
    ),
    pageSize: emptyToUndefined(
      z.coerce
        .number()
        .int()
        .min(1)
        .max(PAGINATION.maxPageSize)
        .default(PAGINATION.defaultPageSize),
    ),
  })
  .describe('批量流水线批次分页查询');

export type WorkflowRunListQuery = z.infer<typeof workflowRunListQuerySchema>;
export type WorkflowRunListQueryPayload = z.input<typeof workflowRunListQuerySchema>;

/** `GET /api/v1/workflows/runs` 响应（创建时间倒序）。 */
export const workflowRunListResponseSchema = z
  .strictObject({
    items: z.array(workflowRunSummaryDtoSchema),
    total: nonNegativeIntSchema,
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .describe('批量流水线批次列表响应');

export type WorkflowRunListResponse = z.infer<typeof workflowRunListResponseSchema>;

/* -------------------------------------------------------------------------- */
/*                              队列任务与事件                                  */
/* -------------------------------------------------------------------------- */

/**
 * BullMQ `novel-workflows` 队列任务负载。
 * 仅承载 `runId`，全部业务配置与进度以 PostgreSQL 为唯一真相来源。
 */
export const workflowJobPayloadSchema = z
  .strictObject({
    runId: uuidSchema,
  })
  .describe('批量流水线队列任务负载');

export type WorkflowJobPayload = z.infer<typeof workflowJobPayloadSchema>;

/**
 * 批次事件（Worker 发布到 `REDIS_CHANNELS.workflowEvents` → Fastify SSE 转发给前端）。
 * 批次级事件仅填公共字段，步骤级事件（`workflow.step_updated`）额外填充 `step*` 字段。
 */
export const workflowEventSchema = z
  .strictObject({
    type: workflowEventTypeSchema,
    runId: uuidSchema,
    bookId: uuidSchema,
    status: workflowRunStatusSchema,
    timestamp: isoDateTimeSchema,
    totalSteps: nonNegativeIntSchema,
    completedSteps: nonNegativeIntSchema,
    failedSteps: nonNegativeIntSchema,
    spentCostUsd: usdAmountSchema,
    maxCostUsd: usdAmountSchema.nullable(),
    pauseReason: workflowPauseReasonSchema.nullable().default(null),
    /** 以下字段仅 `workflow.step_updated` 事件填充 */
    stepId: uuidSchema.nullable().default(null),
    chapterId: uuidSchema.nullable().default(null),
    stepIndex: nonNegativeIntSchema.nullable().default(null),
    stepStatus: workflowStepStatusSchema.nullable().default(null),
    stepStage: workflowStepStageSchema.nullable().default(null),
    criticScore: z.number().int().min(0).max(100).nullable().default(null),
    errorCode: apiErrorCodeSchema.nullable().default(null),
    errorMessage: z.string().max(MAX_SUMMARY_TEXT_LENGTH).nullable().default(null),
  })
  .describe('批量流水线进度事件（Redis Pub/Sub + SSE）');

export type WorkflowEvent = z.infer<typeof workflowEventSchema>;
export type WorkflowEventPayload = z.input<typeof workflowEventSchema>;
