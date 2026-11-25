import {
  API_ERROR_CODES,
  MAX_RECENT_SUMMARIES_COUNT,
  apiErrorCodeSchema,
  knowledgeCardCategorySchema,
  workflowModeSchema,
  workflowPauseReasonSchema,
  workflowRunConfigSchema,
  workflowRunStatusSchema,
  workflowStepStageSchema,
  workflowStepStatusSchema,
  type ApiErrorCode,
  type KnowledgeCardCategory,
  type WorkflowMode,
  type WorkflowPauseReason,
  type WorkflowRunConfig,
  type WorkflowRunStatus,
  type WorkflowStepStage,
  type WorkflowStepStatus,
} from '@fanxiaoshuo/shared';
import type {
  ContextBookInfo,
  ContextBookOutlineInput,
  ContextKnowledgeCardInput,
  ContextPrevChapterInput,
  ContextRecentSummaryInput,
  ParsedExtractedSummary,
} from '@fanxiaoshuo/agents';
import type { Pool, QueryResultRow } from 'pg';
import { WorkerJobError } from '../errors.js';
import type { QueryExecutor } from './usage-log-writer.js';

/**
 * 批量流水线 PostgreSQL 仓储（Worker 侧，纯 `pg` SQL）。
 *
 * 设计原则：
 * - 表名 / 列名与 `apps/server/src/db/schema.ts`（迁移 `0003_*.sql`）逐列对齐，禁止臆造；
 * - 全部方法只依赖注入的 `Pool` / `PoolClient`，业务层通过 `WorkflowStore` 接口消费，
 *   从而可以在单元测试中用纯内存 Fake 完整驱动 `workflow-job` 处理器；
 * - 所有金额列（`numeric`）统一归一化为有限数字，时间列统一归一化为 ISO 字符串或 null。
 */

/* -------------------------------------------------------------------------- */
/*                                  领域快照                                   */
/* -------------------------------------------------------------------------- */

/** 批次进度公共字段（事件发布与步骤累加共用）。 */
export interface WorkflowRunProgress {
  readonly status: WorkflowRunStatus;
  readonly totalSteps: number;
  readonly completedSteps: number;
  readonly failedSteps: number;
  readonly spentCostUsd: number;
  readonly maxCostUsd: number | null;
}

/** 批次完整快照（`workflow_runs` JOIN `books.title`）。 */
export interface WorkflowRunSnapshot extends WorkflowRunProgress {
  readonly id: string;
  readonly bookId: string;
  readonly bookTitle: string;
  readonly mode: WorkflowMode;
  readonly config: WorkflowRunConfig;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly pauseRequested: boolean;
  readonly cancelRequested: boolean;
  readonly pauseReason: WorkflowPauseReason | null;
  readonly errorCode: ApiErrorCode | null;
  readonly errorMessage: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** 单章步骤快照（按 `step_index ASC` 排序）。 */
export interface WorkflowStepSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly chapterId: string;
  readonly stepIndex: number;
  readonly chapterTitleSnapshot: string;
  readonly status: WorkflowStepStatus;
  readonly stage: WorkflowStepStage;
  readonly reworkCount: number;
  readonly criticScore: number | null;
  readonly backupRevisionId: string | null;
}

/** 批次 + 有序步骤。 */
export interface WorkflowRunWithSteps {
  readonly run: WorkflowRunSnapshot;
  readonly steps: readonly WorkflowStepSnapshot[];
}

/** 轻量控制态（每个检查点低成本轮询）。 */
export interface WorkflowControlState {
  readonly status: WorkflowRunStatus;
  readonly pauseRequested: boolean;
  readonly cancelRequested: boolean;
  readonly maxCostUsd: number | null;
  readonly spentCostUsd: number;
}

/** 批次累计统计快照（步骤落盘后返回，用于实时事件）。 */
export interface WorkflowRunTotalsSnapshot extends WorkflowRunProgress {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}

/** 单章执行所需的 Book Bible 上下文。 */
export interface ChapterContextData {
  readonly book: ContextBookInfo;
  readonly bookOutline: ContextBookOutlineInput | null;
  readonly cards: readonly ContextKnowledgeCardInput[];
  /** 当前章之前、有内容的前序摘要（旧 → 新） */
  readonly recentSummaries: readonly ContextRecentSummaryInput[];
  /** 紧邻上一章完整正文（无上一章为 null） */
  readonly prevChapter: ContextPrevChapterInput | null;
  readonly chapter: {
    readonly id: string;
    readonly title: string;
    readonly contentText: string;
    readonly outline: string | null;
  };
}

/** `markStepCompleted` 参数。 */
export interface StepCompletionData {
  readonly reworkCount: number;
  readonly criticScore: number | null;
  readonly criticPassed: boolean | null;
  readonly criticSummary: string | null;
  readonly criticIssues: readonly string[];
  readonly outputWordCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly backupRevisionId: string | null;
}

/** `markStepFailed` 参数（保留已消耗 Token 与费用）。 */
export interface StepFailureData {
  readonly errorCode: ApiErrorCode;
  readonly errorMessage: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly reworkCount?: number;
  readonly criticScore?: number | null;
}

/** 安全中止（暂停 / 取消 / 预算熔断）后回滚步骤时携带的部分用量。 */
export interface StepResetUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedCostUsd?: number;
}

/** `persistChapterWorkflowOutputs` 参数。 */
export interface PersistChapterOutputsInput {
  readonly bookId: string;
  readonly chapterId: string;
  readonly plannedOutline: string | null;
  readonly contentText: string | null;
  readonly outputWordCount: number;
  readonly enableCritic: boolean;
  readonly extractedSummary: ParsedExtractedSummary | null;
  readonly mode: WorkflowMode;
}

/** 安全写入结果：写前留底的 `source: 'ai'` 快照 ID。 */
export interface PersistChapterOutputsResult {
  readonly backupRevisionId: string | null;
}

/**
 * Worker 侧批量流水线仓储契约（生产实现为 `createPgWorkflowStore`）。
 *
 * 全部方法都以 PostgreSQL 为唯一真相来源；暂停 / 取消 / 预算检查只读
 * `readRunControlState`，避免每个检查点拉取整批步骤。
 */
export interface WorkflowStore {
  loadRunWithSteps(runId: string): Promise<WorkflowRunWithSteps | null>;
  readRunControlState(runId: string): Promise<WorkflowControlState | null>;
  markRunRunning(runId: string): Promise<void>;
  markRunPaused(runId: string, reason: WorkflowPauseReason): Promise<WorkflowRunTotalsSnapshot>;
  markRunCancelled(runId: string): Promise<WorkflowRunTotalsSnapshot>;
  markRunFinished(
    runId: string,
    status: 'completed' | 'failed',
    error?: { code: ApiErrorCode; message: string } | null,
  ): Promise<WorkflowRunTotalsSnapshot>;
  markStepRunning(stepId: string, stage: WorkflowStepStage): Promise<void>;
  updateStepStage(
    stepId: string,
    stage: WorkflowStepStage,
    meta?: { reworkCount?: number; criticScore?: number | null },
  ): Promise<void>;
  markStepCompleted(
    runId: string,
    stepId: string,
    data: StepCompletionData,
  ): Promise<WorkflowRunTotalsSnapshot>;
  markStepFailed(
    runId: string,
    stepId: string,
    data: StepFailureData,
  ): Promise<WorkflowRunTotalsSnapshot>;
  resetStepToPending(stepId: string, data?: StepResetUsage): Promise<void>;
  loadChapterContextData(bookId: string, chapterId: string): Promise<ChapterContextData>;
  persistChapterWorkflowOutputs(
    input: PersistChapterOutputsInput,
  ): Promise<PersistChapterOutputsResult>;
}

/* -------------------------------------------------------------------------- */
/*                                  SQL 语句                                   */
/* -------------------------------------------------------------------------- */

const SELECT_RUN_SQL = `
SELECT
  r.id,
  r.book_id,
  b.title AS book_title,
  r.mode,
  r.status,
  r.config_json,
  r.total_steps,
  r.completed_steps,
  r.failed_steps,
  r.max_cost_usd,
  r.spent_cost_usd,
  r.total_input_tokens,
  r.total_output_tokens,
  r.pause_requested,
  r.cancel_requested,
  r.pause_reason,
  r.error_code,
  r.error_message,
  r.started_at,
  r.finished_at
FROM workflow_runs r
JOIN books b ON b.id = r.book_id
WHERE r.id = $1::uuid
LIMIT 1
`.trim();

const SELECT_STEPS_SQL = `
SELECT
  id,
  run_id,
  chapter_id,
  step_index,
  chapter_title_snapshot,
  status,
  stage,
  rework_count,
  critic_score,
  backup_revision_id
FROM workflow_steps
WHERE run_id = $1::uuid
ORDER BY step_index ASC
`.trim();

const SELECT_CONTROL_SQL = `
SELECT status, pause_requested, cancel_requested, max_cost_usd, spent_cost_usd
FROM workflow_runs
WHERE id = $1::uuid
LIMIT 1
`.trim();

const RETURNING_TOTALS = `
  status,
  total_steps,
  completed_steps,
  failed_steps,
  spent_cost_usd,
  max_cost_usd,
  total_input_tokens,
  total_output_tokens
`.trim();

const MARK_RUN_RUNNING_SQL = `
UPDATE workflow_runs
SET
  status = 'running',
  started_at = COALESCE(started_at, now()),
  pause_reason = NULL,
  error_code = NULL,
  error_message = NULL,
  updated_at = now()
WHERE id = $1::uuid
`.trim();

const MARK_RUN_PAUSED_SQL = `
UPDATE workflow_runs
SET
  status = 'paused',
  pause_requested = false,
  pause_reason = $2,
  updated_at = now()
WHERE id = $1::uuid
RETURNING ${RETURNING_TOTALS}
`.trim();

const SKIP_PENDING_STEPS_SQL = `
UPDATE workflow_steps
SET status = 'skipped', updated_at = now()
WHERE run_id = $1::uuid AND status IN ('pending', 'running')
`.trim();

const MARK_RUN_CANCELLED_SQL = `
UPDATE workflow_runs
SET
  status = 'cancelled',
  cancel_requested = true,
  finished_at = now(),
  updated_at = now()
WHERE id = $1::uuid
RETURNING ${RETURNING_TOTALS}
`.trim();

const MARK_RUN_FINISHED_SQL = `
UPDATE workflow_runs
SET
  completed_steps = (
    SELECT count(*)::int FROM workflow_steps WHERE run_id = $1::uuid AND status = 'completed'
  ),
  failed_steps = (
    SELECT count(*)::int FROM workflow_steps WHERE run_id = $1::uuid AND status = 'failed'
  ),
  status = $2,
  finished_at = now(),
  error_code = $3,
  error_message = $4,
  updated_at = now()
WHERE id = $1::uuid
RETURNING ${RETURNING_TOTALS}
`.trim();

const MARK_STEP_RUNNING_SQL = `
UPDATE workflow_steps
SET
  status = 'running',
  stage = $2,
  started_at = COALESCE(started_at, now()),
  error_code = NULL,
  error_message = NULL,
  updated_at = now()
WHERE id = $1::uuid
`.trim();

const UPDATE_STEP_STAGE_SQL = `
UPDATE workflow_steps
SET
  stage = $2,
  rework_count = COALESCE($3::int, rework_count),
  critic_score = CASE WHEN $4::boolean THEN $5::int ELSE critic_score END,
  updated_at = now()
WHERE id = $1::uuid
`.trim();

const MARK_STEP_COMPLETED_SQL = `
UPDATE workflow_steps
SET
  status = 'completed',
  stage = 'done',
  rework_count = $2,
  critic_score = $3,
  critic_passed = $4,
  critic_summary = $5,
  critic_issues_json = $6::jsonb,
  output_word_count = $7,
  input_tokens = $8,
  output_tokens = $9,
  estimated_cost_usd = $10,
  backup_revision_id = $11,
  error_code = NULL,
  error_message = NULL,
  finished_at = now(),
  updated_at = now()
WHERE id = $1::uuid
`.trim();

const MARK_STEP_FAILED_SQL = `
UPDATE workflow_steps
SET
  status = 'failed',
  rework_count = COALESCE($2::int, rework_count),
  critic_score = CASE WHEN $3::boolean THEN $4::int ELSE critic_score END,
  input_tokens = $5,
  output_tokens = $6,
  estimated_cost_usd = $7,
  error_code = $8,
  error_message = $9,
  finished_at = now(),
  updated_at = now()
WHERE id = $1::uuid
`.trim();

const RECOUNT_RUN_SQL = `
UPDATE workflow_runs
SET
  completed_steps = (
    SELECT count(*)::int FROM workflow_steps WHERE run_id = $1::uuid AND status = 'completed'
  ),
  failed_steps = (
    SELECT count(*)::int FROM workflow_steps WHERE run_id = $1::uuid AND status = 'failed'
  ),
  spent_cost_usd = spent_cost_usd + $2,
  total_input_tokens = total_input_tokens + $3,
  total_output_tokens = total_output_tokens + $4,
  updated_at = now()
WHERE id = $1::uuid
RETURNING ${RETURNING_TOTALS}
`.trim();

/**
 * 把步骤重置为 `pending`，同时把「本次已产生但会被丢弃」的部分用量累加到批次账本。
 *
 * 数据修改型 CTE 会各自执行一次：步骤归零（续跑时重新计量），
 * 批次累加（真实消耗绝不漏算），彻底避免重复扣费或漏记费用。
 */
const RESET_STEP_SQL = `
WITH target_step AS (
  UPDATE workflow_steps
  SET
    status = 'pending',
    stage = 'idle',
    input_tokens = 0,
    output_tokens = 0,
    estimated_cost_usd = 0,
    finished_at = NULL,
    updated_at = now()
  WHERE id = $1::uuid
  RETURNING run_id
)
UPDATE workflow_runs r
SET
  spent_cost_usd = r.spent_cost_usd + $2,
  total_input_tokens = r.total_input_tokens + $3,
  total_output_tokens = r.total_output_tokens + $4,
  updated_at = now()
WHERE r.id = (SELECT run_id FROM target_step)
`.trim();

const SELECT_BOOK_SQL = `
SELECT title, genre, synopsis, target_chapter_words
FROM books
WHERE id = $1::uuid AND deleted_at IS NULL
LIMIT 1
`.trim();

const SELECT_BOOK_OUTLINE_SQL = `
SELECT main_plot, world_setting, style_guide, ending_plan
FROM book_outlines
WHERE book_id = $1::uuid
LIMIT 1
`.trim();

const SELECT_CARDS_SQL = `
SELECT
  id,
  category,
  title,
  summary,
  content,
  aliases,
  tags,
  pinned,
  sort_order,
  embedding
FROM knowledge_cards
WHERE book_id = $1::uuid
ORDER BY sort_order ASC, created_at ASC, id ASC
`.trim();

const SELECT_VOLUMES_SQL = `
SELECT id, sort_order
FROM volumes
WHERE book_id = $1::uuid AND deleted_at IS NULL
ORDER BY sort_order ASC, created_at ASC, id ASC
`.trim();

const SELECT_CHAPTERS_SQL = `
SELECT id, title, volume_id, sort_order, content_text, status
FROM chapters
WHERE book_id = $1::uuid AND deleted_at IS NULL
ORDER BY sort_order ASC, created_at ASC, id ASC
`.trim();

const SELECT_SUMMARIES_SQL = `
SELECT chapter_id, outline, summary, key_events
FROM chapter_summaries
WHERE book_id = $1::uuid
`.trim();

const SELECT_CHAPTER_FOR_UPDATE_SQL = `
SELECT id, title, content_text, content_json, word_count, version, status
FROM chapters
WHERE id = $1::uuid AND deleted_at IS NULL
FOR UPDATE
`.trim();

const INSERT_AI_REVISION_SQL = `
INSERT INTO chapter_revisions (
  chapter_id,
  version,
  source,
  note,
  title_snapshot,
  content_text,
  content_json,
  word_count
) VALUES ($1::uuid, $2, 'ai', $3, $4, $5, $6, $7)
RETURNING id
`.trim();

const UPDATE_CHAPTER_CONTENT_SQL = `
UPDATE chapters
SET
  content_text = $2,
  content_json = NULL,
  word_count = $3,
  version = version + 1,
  status = CASE WHEN status = 'outline' THEN $4 ELSE status END,
  updated_at = now()
WHERE id = $1::uuid
`.trim();

const UPSERT_CHAPTER_SUMMARY_SQL = `
INSERT INTO chapter_summaries (
  chapter_id,
  book_id,
  outline,
  summary,
  key_events,
  characters_present,
  source,
  updated_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7, now())
ON CONFLICT (chapter_id) DO UPDATE
SET
  outline = CASE WHEN $8::boolean THEN EXCLUDED.outline ELSE chapter_summaries.outline END,
  summary = CASE WHEN $9::boolean THEN EXCLUDED.summary ELSE chapter_summaries.summary END,
  key_events = CASE WHEN $9::boolean THEN EXCLUDED.key_events ELSE chapter_summaries.key_events END,
  characters_present = CASE
    WHEN $9::boolean THEN EXCLUDED.characters_present ELSE chapter_summaries.characters_present
  END,
  source = CASE WHEN $9::boolean THEN EXCLUDED.source ELSE chapter_summaries.source END,
  updated_at = now()
`.trim();

/* -------------------------------------------------------------------------- */
/*                                  行类型                                     */
/* -------------------------------------------------------------------------- */

interface WorkflowRunRow extends QueryResultRow {
  readonly id: string;
  readonly book_id: string;
  readonly book_title: string;
  readonly mode: string;
  readonly status: string;
  readonly config_json: unknown;
  readonly total_steps: number;
  readonly completed_steps: number;
  readonly failed_steps: number;
  readonly max_cost_usd: string | number | null;
  readonly spent_cost_usd: string | number;
  readonly total_input_tokens: number;
  readonly total_output_tokens: number;
  readonly pause_requested: boolean;
  readonly cancel_requested: boolean;
  readonly pause_reason: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly started_at: Date | string | null;
  readonly finished_at: Date | string | null;
}

interface WorkflowStepRow extends QueryResultRow {
  readonly id: string;
  readonly run_id: string;
  readonly chapter_id: string;
  readonly step_index: number;
  readonly chapter_title_snapshot: string;
  readonly status: string;
  readonly stage: string;
  readonly rework_count: number;
  readonly critic_score: number | null;
  readonly backup_revision_id: string | null;
}

interface WorkflowTotalsRow extends QueryResultRow {
  readonly status: string;
  readonly total_steps: number;
  readonly completed_steps: number;
  readonly failed_steps: number;
  readonly spent_cost_usd: string | number;
  readonly max_cost_usd: string | number | null;
  readonly total_input_tokens: number;
  readonly total_output_tokens: number;
}

interface WorkflowControlRow extends QueryResultRow {
  readonly status: string;
  readonly pause_requested: boolean;
  readonly cancel_requested: boolean;
  readonly max_cost_usd: string | number | null;
  readonly spent_cost_usd: string | number;
}

interface BookRow extends QueryResultRow {
  readonly title: string;
  readonly genre: string;
  readonly synopsis: string;
  readonly target_chapter_words: number;
}

interface BookOutlineRow extends QueryResultRow {
  readonly main_plot: string;
  readonly world_setting: string;
  readonly style_guide: string;
  readonly ending_plan: string;
}

interface CardRow extends QueryResultRow {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly aliases: unknown;
  readonly tags: unknown;
  readonly pinned: boolean;
  readonly sort_order: number;
  readonly embedding: unknown;
}

interface VolumeRow extends QueryResultRow {
  readonly id: string;
  readonly sort_order: number;
}

interface ChapterRow extends QueryResultRow {
  readonly id: string;
  readonly title: string;
  readonly volume_id: string | null;
  readonly sort_order: number;
  readonly content_text: string;
  readonly status: string;
}

interface SummaryRow extends QueryResultRow {
  readonly chapter_id: string;
  readonly outline: string;
  readonly summary: string;
  readonly key_events: unknown;
}

interface LockedChapterRow extends QueryResultRow {
  readonly id: string;
  readonly title: string;
  readonly content_text: string;
  readonly content_json: unknown;
  readonly word_count: number;
  readonly version: number;
  readonly status: string;
}

/* -------------------------------------------------------------------------- */
/*                                  工具函数                                   */
/* -------------------------------------------------------------------------- */

/** 批次配置快照解析：忽略快照中的非配置字段（如 `chapterIds`）。 */
function parseRunConfig(raw: unknown): WorkflowRunConfig {
  const record = asRecord(raw);
  if (!record) {
    throw new WorkerJobError(
      '批次配置快照缺失或非对象，无法执行。',
      API_ERROR_CODES.INTERNAL_ERROR,
    );
  }
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(workflowRunConfigSchema.shape)) {
    const value = record[key];
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  const parsed = workflowRunConfigSchema.safeParse(picked);
  if (!parsed.success) {
    throw new WorkerJobError(
      '批次配置快照未通过契约校验，已阻止本次执行。',
      API_ERROR_CODES.INTERNAL_ERROR,
    );
  }
  return parsed.data;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** pg NUMERIC 默认返回字符串，统一转为有限非负数字。 */
function toFiniteNumber(value: string | number | null): number {
  if (value === null) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 可空金额 / 数值列。 */
function toNullableNumber(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoString(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

/** 非负整数归一化。 */
function toNonNegativeInt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

/** `vector` 列在驱动层以 `"[0.1,0.2]"` 文本往返，解析失败返回 null。 */
function parseEmbedding(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const numbers = value.filter(
      (item): item is number => typeof item === 'number' && Number.isFinite(item),
    );
    return numbers.length > 0 ? numbers : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null;
  }
  const body = trimmed.slice(1, -1).trim();
  if (body.length === 0) {
    return null;
  }
  const numbers = body
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((item) => Number.isFinite(item));
  return numbers.length > 0 ? numbers : null;
}

/** 卡片分类兜底（脏数据不阻断整批执行）。 */
function parseCardCategory(value: string): KnowledgeCardCategory {
  const parsed = knowledgeCardCategorySchema.safeParse(value);
  return parsed.success ? parsed.data : 'world';
}

function parseRunStatus(value: string): WorkflowRunStatus {
  const parsed = workflowRunStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkerJobError('批次状态非法，已阻止本次执行。', API_ERROR_CODES.INTERNAL_ERROR);
  }
  return parsed.data;
}

function parseStepStatus(value: string): WorkflowStepStatus {
  const parsed = workflowStepStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : 'pending';
}

function parseStepStage(value: string): WorkflowStepStage {
  const parsed = workflowStepStageSchema.safeParse(value);
  return parsed.success ? parsed.data : 'idle';
}

function parsePauseReason(value: string | null): WorkflowPauseReason | null {
  if (value === null) {
    return null;
  }
  const parsed = workflowPauseReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseErrorCode(value: string | null): ApiErrorCode | null {
  if (value === null) {
    return null;
  }
  const parsed = apiErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseMode(value: string): WorkflowMode {
  const parsed = workflowModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkerJobError('批次运行模式非法，已阻止本次执行。', API_ERROR_CODES.INTERNAL_ERROR);
  }
  return parsed.data;
}


/* -------------------------------------------------------------------------- */
/*                                 生产实现                                    */
/* -------------------------------------------------------------------------- */

/**
 * 基于 `pg.Pool` 的生产 `WorkflowStore`。
 *
 * 所有多表写入（取消批次、步骤完成 / 失败累加、章节安全写入）都在显式事务内完成，
 * 确保「步骤状态 + 批次账本」或「留底快照 + 正文 + 摘要」永远原子生效。
 */
export function createPgWorkflowStore(pool: Pool): WorkflowStore {
  async function inTransaction<T>(body: (client: QueryExecutor) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 回滚失败不应覆盖原始错误（连接可能已断开）。
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async loadRunWithSteps(runId: string): Promise<WorkflowRunWithSteps | null> {
      const runResult = await pool.query<WorkflowRunRow>(SELECT_RUN_SQL, [runId]);
      const runRow = runResult.rows[0];
      if (!runRow) {
        return null;
      }
      const stepResult = await pool.query<WorkflowStepRow>(SELECT_STEPS_SQL, [runId]);
      return {
        run: mapRun(runRow),
        steps: stepResult.rows.map(mapStep),
      };
    },

    async readRunControlState(runId: string): Promise<WorkflowControlState | null> {
      const result = await pool.query<WorkflowControlRow>(SELECT_CONTROL_SQL, [runId]);
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      return {
        status: parseRunStatus(row.status),
        pauseRequested: row.pause_requested === true,
        cancelRequested: row.cancel_requested === true,
        maxCostUsd: toNullableNumber(row.max_cost_usd),
        spentCostUsd: toFiniteNumber(row.spent_cost_usd),
      };
    },

    async markRunRunning(runId: string): Promise<void> {
      await pool.query(MARK_RUN_RUNNING_SQL, [runId]);
    },

    async markRunPaused(
      runId: string,
      reason: WorkflowPauseReason,
    ): Promise<WorkflowRunTotalsSnapshot> {
      const result = await pool.query<WorkflowTotalsRow>(MARK_RUN_PAUSED_SQL, [runId, reason]);
      const row = result.rows[0];
      if (!row) {
        throw new WorkerJobError('批量流水线批次不存在。', 'WORKFLOW_RUN_NOT_FOUND');
      }
      return mapTotals(row);
    },

    async markRunCancelled(runId: string): Promise<WorkflowRunTotalsSnapshot> {
      return inTransaction(async (client) => {
        await client.query(SKIP_PENDING_STEPS_SQL, [runId]);
        const result = await client.query<WorkflowTotalsRow>(MARK_RUN_CANCELLED_SQL, [runId]);
        const row = result.rows[0];
        if (!row) {
          throw new WorkerJobError('批量流水线批次不存在。', 'WORKFLOW_RUN_NOT_FOUND');
        }
        return mapTotals(row);
      });
    },

    async markRunFinished(
      runId: string,
      status: 'completed' | 'failed',
      error?: { code: ApiErrorCode; message: string } | null,
    ): Promise<WorkflowRunTotalsSnapshot> {
      const result = await pool.query<WorkflowTotalsRow>(MARK_RUN_FINISHED_SQL, [
        runId,
        status,
        error?.code ?? null,
        error?.message ?? null,
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new WorkerJobError('批量流水线批次不存在。', 'WORKFLOW_RUN_NOT_FOUND');
      }
      return mapTotals(row);
    },

    async markStepRunning(stepId: string, stage: WorkflowStepStage): Promise<void> {
      await pool.query(MARK_STEP_RUNNING_SQL, [stepId, stage]);
    },

    async updateStepStage(
      stepId: string,
      stage: WorkflowStepStage,
      meta?: { reworkCount?: number; criticScore?: number | null },
    ): Promise<void> {
      const hasCriticScore = meta !== undefined && meta.criticScore !== undefined;
      await pool.query(UPDATE_STEP_STAGE_SQL, [
        stepId,
        stage,
        meta?.reworkCount ?? null,
        hasCriticScore,
        hasCriticScore ? (meta?.criticScore ?? null) : null,
      ]);
    },

    async markStepCompleted(
      runId: string,
      stepId: string,
      data: StepCompletionData,
    ): Promise<WorkflowRunTotalsSnapshot> {
      return inTransaction(async (client) => {
        await client.query(MARK_STEP_COMPLETED_SQL, [
          stepId,
          toNonNegativeInt(data.reworkCount),
          data.criticScore,
          data.criticPassed,
          data.criticSummary,
          JSON.stringify(data.criticIssues),
          toNonNegativeInt(data.outputWordCount),
          toNonNegativeInt(data.inputTokens),
          toNonNegativeInt(data.outputTokens),
          toFiniteNumber(data.estimatedCostUsd),
          data.backupRevisionId,
        ]);
        const result = await client.query<WorkflowTotalsRow>(RECOUNT_RUN_SQL, [
          runId,
          toFiniteNumber(data.estimatedCostUsd),
          toNonNegativeInt(data.inputTokens),
          toNonNegativeInt(data.outputTokens),
        ]);
        const row = result.rows[0];
        if (!row) {
          throw new WorkerJobError('批量流水线批次不存在。', 'WORKFLOW_RUN_NOT_FOUND');
        }
        return mapTotals(row);
      });
    },

    async markStepFailed(
      runId: string,
      stepId: string,
      data: StepFailureData,
    ): Promise<WorkflowRunTotalsSnapshot> {
      return inTransaction(async (client) => {
        const hasCriticScore = data.criticScore !== undefined;
        await client.query(MARK_STEP_FAILED_SQL, [
          stepId,
          data.reworkCount ?? null,
          hasCriticScore,
          hasCriticScore ? (data.criticScore ?? null) : null,
          toNonNegativeInt(data.inputTokens),
          toNonNegativeInt(data.outputTokens),
          toFiniteNumber(data.estimatedCostUsd),
          data.errorCode,
          data.errorMessage,
        ]);
        const result = await client.query<WorkflowTotalsRow>(RECOUNT_RUN_SQL, [
          runId,
          toFiniteNumber(data.estimatedCostUsd),
          toNonNegativeInt(data.inputTokens),
          toNonNegativeInt(data.outputTokens),
        ]);
        const row = result.rows[0];
        if (!row) {
          throw new WorkerJobError('批量流水线批次不存在。', 'WORKFLOW_RUN_NOT_FOUND');
        }
        return mapTotals(row);
      });
    },

    async resetStepToPending(stepId: string, data?: StepResetUsage): Promise<void> {
      await pool.query(RESET_STEP_SQL, [
        stepId,
        toFiniteNumber(data?.estimatedCostUsd ?? 0),
        toNonNegativeInt(data?.inputTokens ?? 0),
        toNonNegativeInt(data?.outputTokens ?? 0),
      ]);
    },

    async loadChapterContextData(
      bookId: string,
      chapterId: string,
    ): Promise<ChapterContextData> {
      const bookResult = await pool.query<BookRow>(SELECT_BOOK_SQL, [bookId]);
      const bookRow = bookResult.rows[0];
      if (!bookRow) {
        throw new WorkerJobError('批量流水线目标书籍不存在或已删除。', 'BOOK_NOT_FOUND');
      }

      const [outlineResult, cardResult, volumeResult, chapterResult, summaryResult] =
        await Promise.all([
          pool.query<BookOutlineRow>(SELECT_BOOK_OUTLINE_SQL, [bookId]),
          pool.query<CardRow>(SELECT_CARDS_SQL, [bookId]),
          pool.query<VolumeRow>(SELECT_VOLUMES_SQL, [bookId]),
          pool.query<ChapterRow>(SELECT_CHAPTERS_SQL, [bookId]),
          pool.query<SummaryRow>(SELECT_SUMMARIES_SQL, [bookId]),
        ]);

      const outlineRow = outlineResult.rows[0];
      const bookOutline: ContextBookOutlineInput | null = outlineRow
        ? {
            mainPlot: outlineRow.main_plot,
            worldSetting: outlineRow.world_setting,
            styleGuide: outlineRow.style_guide,
            endingPlan: outlineRow.ending_plan,
          }
        : null;

      const cards: ContextKnowledgeCardInput[] = cardResult.rows.map((row) => ({
        id: row.id,
        category: parseCardCategory(row.category),
        title: row.title,
        summary: row.summary,
        content: row.content,
        aliases: toStringList(row.aliases),
        tags: toStringList(row.tags),
        pinned: row.pinned === true,
        sortOrder: toNonNegativeInt(row.sort_order),
        embedding: parseEmbedding(row.embedding),
      }));

      const summaryByChapter = new Map<string, SummaryRow>();
      for (const row of summaryResult.rows) {
        summaryByChapter.set(row.chapter_id, row);
      }

      const readingOrder = flattenReadingOrder(volumeResult.rows, chapterResult.rows);
      const currentIndex = readingOrder.findIndex((chapter) => chapter.id === chapterId);
      const currentChapter = currentIndex >= 0 ? readingOrder[currentIndex] : undefined;

      if (!currentChapter) {
        throw new WorkerJobError(
          '批量流水线目标章节不存在或不属于该书。',
          'CHAPTER_NOT_FOUND',
        );
      }

      const recentSummaries: ContextRecentSummaryInput[] = [];
      for (const chapter of readingOrder.slice(0, currentIndex)) {
        const summary = summaryByChapter.get(chapter.id);
        const text = summary?.summary?.trim() ?? '';
        if (text.length === 0) {
          continue;
        }
        recentSummaries.push({
          chapterTitle: chapter.title,
          summary: text,
          ...(summary ? { keyEvents: toStringList(summary.key_events) } : {}),
        });
      }

      const previousChapter =
        currentIndex > 0 ? (readingOrder[currentIndex - 1] as ChapterRow) : null;
      const prevChapter: ContextPrevChapterInput | null =
        previousChapter && previousChapter.content_text.trim().length > 0
          ? { title: previousChapter.title, contentText: previousChapter.content_text }
          : null;

      const currentOutline = summaryByChapter.get(currentChapter.id)?.outline ?? '';

      return {
        book: {
          title: bookRow.title,
          genre: bookRow.genre,
          synopsis: bookRow.synopsis,
          targetChapterWords: toNonNegativeInt(bookRow.target_chapter_words),
        },
        bookOutline,
        cards,
        recentSummaries: recentSummaries.slice(-MAX_RECENT_SUMMARIES_COUNT),
        prevChapter,
        chapter: {
          id: currentChapter.id,
          title: currentChapter.title,
          contentText: currentChapter.content_text,
          outline: currentOutline.trim().length > 0 ? currentOutline : null,
        },
      };
    },

    async persistChapterWorkflowOutputs(
      input: PersistChapterOutputsInput,
    ): Promise<PersistChapterOutputsResult> {
      return inTransaction(async (client) => {
        let backupRevisionId: string | null = null;

        if (input.contentText !== null) {
          const lockedResult = await client.query<LockedChapterRow>(
            SELECT_CHAPTER_FOR_UPDATE_SQL,
            [input.chapterId],
          );
          const locked = lockedResult.rows[0];
          if (!locked) {
            throw new WorkerJobError(
              '批量流水线目标章节不存在或已删除。',
              'CHAPTER_NOT_FOUND',
            );
          }

          const revisionResult = await client.query<{ id: string } & QueryResultRow>(
            INSERT_AI_REVISION_SQL,
            [
              input.chapterId,
              locked.version,
              '批量流水线写入前自动留底',
              locked.title,
              locked.content_text,
              locked.content_json === null || locked.content_json === undefined
                ? null
                : JSON.stringify(locked.content_json),
              toNonNegativeInt(locked.word_count),
            ],
          );
          backupRevisionId = revisionResult.rows[0]?.id ?? null;

          const nextStatus = resolveNextChapterStatus(input.enableCritic);
          await client.query(UPDATE_CHAPTER_CONTENT_SQL, [
            input.chapterId,
            input.contentText,
            toNonNegativeInt(input.outputWordCount),
            nextStatus,
          ]);
        }

        const hasOutline = input.plannedOutline !== null;
        const hasSummary = input.extractedSummary !== null;

        if (hasOutline || hasSummary) {
          const summary = input.extractedSummary;
          await client.query(UPSERT_CHAPTER_SUMMARY_SQL, [
            input.chapterId,
            input.bookId,
            input.plannedOutline ?? '',
            summary?.summary ?? '',
            JSON.stringify(summary?.keyEvents ?? []),
            JSON.stringify(summary?.charactersPresent ?? []),
            resolveSummarySource(input.mode, hasSummary),
            hasOutline,
            hasSummary,
          ]);
        }

        return { backupRevisionId };
      });
    },
  };
}

/** 正文写入后的章节状态：留待审稿则 `reviewing`，否则直接 `draft`。 */
function resolveNextChapterStatus(enableCritic: boolean): 'reviewing' | 'draft' {
  return enableCritic ? 'reviewing' : 'draft';
}

/** 摘要来源：只有真正提炼出摘要（且非仅拆细纲模式）才标记为 AI 产出。 */
function resolveSummarySource(mode: WorkflowMode, hasSummary: boolean): 'ai' | 'manual' {
  return hasSummary && mode !== 'outline_only' ? 'ai' : 'manual';
}

/**
 * 展平阅读顺序：分卷按 `sort_order` 升序 → 卷内章按 `sort_order` 升序 → 未分卷章按 `sort_order` 升序。
 * 返回顺序即批量流水线的推荐执行顺序（前章摘要 / 结尾承接依赖此顺序）。
 */
function flattenReadingOrder(volumes: readonly VolumeRow[], chapters: readonly ChapterRow[]): ChapterRow[] {
  const volumeOrder = new Map<string, number>();
  for (const [index, volume] of volumes.entries()) {
    volumeOrder.set(volume.id, index);
  }

  const grouped = new Map<string, ChapterRow[]>();
  const unassigned: ChapterRow[] = [];
  for (const chapter of chapters) {
    if (chapter.volume_id === null) {
      unassigned.push(chapter);
      continue;
    }
    const bucket = grouped.get(chapter.volume_id);
    if (bucket) {
      bucket.push(chapter);
    } else {
      grouped.set(chapter.volume_id, [chapter]);
    }
  }

  const orderedVolumes = [...grouped.entries()].sort((a, b) => {
    const left = volumeOrder.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
    const right = volumeOrder.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });

  const bySortOrder = (a: ChapterRow, b: ChapterRow): number =>
    toNonNegativeInt(a.sort_order) - toNonNegativeInt(b.sort_order);

  const result: ChapterRow[] = [];
  for (const [, bucket] of orderedVolumes) {
    result.push(...[...bucket].sort(bySortOrder));
  }
  result.push(...[...unassigned].sort(bySortOrder));
  return result;
}

function mapRun(row: WorkflowRunRow): WorkflowRunSnapshot {
  return {
    id: row.id,
    bookId: row.book_id,
    bookTitle: row.book_title,
    mode: parseMode(row.mode),
    status: parseRunStatus(row.status),
    config: parseRunConfig(row.config_json),
    totalSteps: toNonNegativeInt(row.total_steps),
    completedSteps: toNonNegativeInt(row.completed_steps),
    failedSteps: toNonNegativeInt(row.failed_steps),
    maxCostUsd: toNullableNumber(row.max_cost_usd),
    spentCostUsd: toFiniteNumber(row.spent_cost_usd),
    totalInputTokens: toNonNegativeInt(row.total_input_tokens),
    totalOutputTokens: toNonNegativeInt(row.total_output_tokens),
    pauseRequested: row.pause_requested === true,
    cancelRequested: row.cancel_requested === true,
    pauseReason: parsePauseReason(row.pause_reason),
    errorCode: parseErrorCode(row.error_code),
    errorMessage: row.error_message,
    startedAt: toIsoString(row.started_at),
    finishedAt: toIsoString(row.finished_at),
  };
}

function mapStep(row: WorkflowStepRow): WorkflowStepSnapshot {
  return {
    id: row.id,
    runId: row.run_id,
    chapterId: row.chapter_id,
    stepIndex: toNonNegativeInt(row.step_index),
    chapterTitleSnapshot: row.chapter_title_snapshot,
    status: parseStepStatus(row.status),
    stage: parseStepStage(row.stage),
    reworkCount: toNonNegativeInt(row.rework_count),
    criticScore: toNullableNumber(row.critic_score),
    backupRevisionId: row.backup_revision_id,
  };
}

function mapTotals(row: WorkflowTotalsRow): WorkflowRunTotalsSnapshot {
  return {
    status: parseRunStatus(row.status),
    totalSteps: toNonNegativeInt(row.total_steps),
    completedSteps: toNonNegativeInt(row.completed_steps),
    failedSteps: toNonNegativeInt(row.failed_steps),
    spentCostUsd: toFiniteNumber(row.spent_cost_usd),
    maxCostUsd: toNullableNumber(row.max_cost_usd),
    totalInputTokens: toNonNegativeInt(row.total_input_tokens),
    totalOutputTokens: toNonNegativeInt(row.total_output_tokens),
  };
}

