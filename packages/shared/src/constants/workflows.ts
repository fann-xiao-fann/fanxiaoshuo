import { z } from 'zod';

/**
 * 批量写书流水线（Batch Workflows Engine）领域枚举 / 中文展示名 / 预算与返工常量。
 *
 * 服务端（Drizzle 列默认值、状态机校验与 SSE 发送）、`packages/agents`（单章编排阶段回调）、
 * Worker（断点续跑与预算熔断判定）与前端（批次状态徽标、步骤时间线、费用表盘）
 * 必须共用此处的字面量，禁止各自硬编码导致前后端枚举漂移。
 */

/* -------------------------------------------------------------------------- */
/*                                  运行模式                                   */
/* -------------------------------------------------------------------------- */

/**
 * 3 种批量运行模式：
 * - `outline_only`：`showrunner` 批量拆解章节细纲；
 * - `write_chapters`：`writer` 逐章成文（可选 `critic` 审稿返工与 `lorekeeper` 摘要）；
 * - `full_pipeline`：拆细纲 → 写正文 → 审稿返工 → 摘要提炼全链路。
 */
export const WORKFLOW_MODES = ['outline_only', 'write_chapters', 'full_pipeline'] as const;

export const workflowModeSchema = z.enum(WORKFLOW_MODES);

export type WorkflowMode = z.infer<typeof workflowModeSchema>;

/** 运行模式中文展示名（新建批次弹窗与批次列表筛选共用）。 */
export const WORKFLOW_MODE_LABELS = {
  outline_only: '仅拆细纲',
  write_chapters: '批量成文',
  full_pipeline: '全链路生产',
} as const satisfies Record<WorkflowMode, string>;

/* -------------------------------------------------------------------------- */
/*                                  运行状态                                   */
/* -------------------------------------------------------------------------- */

/** 批次状态流转：queued → running →（paused ⇄ running）→ completed | failed | cancelled。 */
export const WORKFLOW_RUN_STATUSES = [
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;

export const workflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUSES);

export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

/** 批次状态中文展示名（批次列表与详情面板的状态徽标共用）。 */
export const WORKFLOW_RUN_STATUS_LABELS = {
  queued: '排队中',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '已失败',
  cancelled: '已取消',
} as const satisfies Record<WorkflowRunStatus, string>;

/** 终态批次（可安全删除，且不再被 Worker 推进）。 */
export const WORKFLOW_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export type WorkflowTerminalStatus = (typeof WORKFLOW_TERMINAL_STATUSES)[number];

/**
 * 是否终态（`completed` / `failed` / `cancelled`）。
 * 服务端删除批次与前端控制按钮的可用性判定必须复用此函数。
 */
export function isWorkflowTerminalStatus(status: WorkflowRunStatus): boolean {
  return (WORKFLOW_TERMINAL_STATUSES as readonly WorkflowRunStatus[]).includes(status);
}

/* -------------------------------------------------------------------------- */
/*                                  步骤状态                                   */
/* -------------------------------------------------------------------------- */

/** 单章步骤状态：pending → running → completed | failed；批次取消时未执行步骤置 skipped。 */
export const WORKFLOW_STEP_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;

export const workflowStepStatusSchema = z.enum(WORKFLOW_STEP_STATUSES);

export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;

/** 步骤状态中文展示名（步骤时间线徽标共用）。 */
export const WORKFLOW_STEP_STATUS_LABELS = {
  pending: '待执行',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
} as const satisfies Record<WorkflowStepStatus, string>;

/* -------------------------------------------------------------------------- */
/*                                  步骤阶段                                   */
/* -------------------------------------------------------------------------- */

/** 单章执行阶段（Mastra 工作流 `onStageChange` 回调与 SSE 实时进度共用）。 */
export const WORKFLOW_STEP_STAGES = [
  'idle',
  'planning',
  'writing',
  'reviewing',
  'reworking',
  'summarizing',
  'done',
] as const;

export const workflowStepStageSchema = z.enum(WORKFLOW_STEP_STAGES);

export type WorkflowStepStage = z.infer<typeof workflowStepStageSchema>;

/** 步骤阶段中文展示名（步骤时间线当前阶段标签共用）。 */
export const WORKFLOW_STEP_STAGE_LABELS = {
  idle: '等待',
  planning: '规划细纲',
  writing: '撰写正文',
  reviewing: '审稿质检',
  reworking: '按意见返工',
  summarizing: '提炼摘要',
  done: '完成',
} as const satisfies Record<WorkflowStepStage, string>;

/* -------------------------------------------------------------------------- */
/*                                  暂停原因                                   */
/* -------------------------------------------------------------------------- */

/** 批次暂停原因：用户手动暂停 / 触及 `maxCostUsd` 预算上限自动熔断。 */
export const WORKFLOW_PAUSE_REASONS = ['USER_PAUSED', 'BUDGET_EXCEEDED'] as const;

export const workflowPauseReasonSchema = z.enum(WORKFLOW_PAUSE_REASONS);

export type WorkflowPauseReason = z.infer<typeof workflowPauseReasonSchema>;

/** 暂停原因中文展示名（批次详情提示条与「上调预算续跑」引导文案共用）。 */
export const WORKFLOW_PAUSE_REASON_LABELS = {
  USER_PAUSED: '手动暂停',
  BUDGET_EXCEEDED: '触及预算上限',
} as const satisfies Record<WorkflowPauseReason, string>;

/* -------------------------------------------------------------------------- */
/*                                  事件类型                                   */
/* -------------------------------------------------------------------------- */

/** 批次事件类型（Worker 发布 → Redis Pub/Sub → Fastify SSE 转发）。 */
export const WORKFLOW_EVENT_TYPES = [
  'workflow.queued',
  'workflow.running',
  'workflow.step_updated',
  'workflow.paused',
  'workflow.completed',
  'workflow.failed',
  'workflow.cancelled',
] as const;

export const workflowEventTypeSchema = z.enum(WORKFLOW_EVENT_TYPES);

export type WorkflowEventType = z.infer<typeof workflowEventTypeSchema>;

/** 批次状态 → 事件类型映射（发布批次级事件时统一由此推导，避免字面量漂移）。 */
export const WORKFLOW_STATUS_TO_EVENT_TYPE: Record<WorkflowRunStatus, WorkflowEventType> = {
  queued: 'workflow.queued',
  running: 'workflow.running',
  paused: 'workflow.paused',
  completed: 'workflow.completed',
  failed: 'workflow.failed',
  cancelled: 'workflow.cancelled',
};

/* -------------------------------------------------------------------------- */
/*                                SSE 帧名                                     */
/* -------------------------------------------------------------------------- */

/**
 * 批量流水线 SSE 帧名（`event:` 字段），与 `SSE_EVENT_NAMES` / `AI_STREAM_EVENT_NAMES`
 * 独立命名，避免三套流式协议的帧名被误混用。
 */
export const WORKFLOW_SSE_EVENT_NAMES = {
  ready: 'ready',
  /** 批次 / 步骤进度事件帧（载荷为 `workflowEventSchema`） */
  workflowEvent: 'workflow-event',
  ping: 'ping',
} as const;

export type WorkflowSseEventName =
  (typeof WORKFLOW_SSE_EVENT_NAMES)[keyof typeof WORKFLOW_SSE_EVENT_NAMES];

/* -------------------------------------------------------------------------- */
/*                              预算与返工常量                                 */
/* -------------------------------------------------------------------------- */

/** 审稿默认及格分（`critic` 0–100 评分）。 */
export const DEFAULT_WORKFLOW_MIN_PASS_SCORE = 75;

/** 默认最大返工轮数（未达及格分时交给 `writer` 返工的次数）。 */
export const DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS = 1;

/** 最大返工轮数硬上限（防止返工死循环烧光 Token）。 */
export const MAX_WORKFLOW_REWORK_ROUNDS = 3;

/** 单批次默认预算上限（USD）。 */
export const DEFAULT_WORKFLOW_MAX_COST_USD = 5;

/** 预算上限最小值（USD）：必须为正，0 会让批次刚创建即熔断。 */
export const MIN_WORKFLOW_MAX_COST_USD = 0.0001;

/** 预算上限最大值（USD）：防御性上限，避免误输入天文数字。 */
export const MAX_WORKFLOW_MAX_COST_USD = 500;

/** 单批次最多纳管章节数（同时约束 `chapterIds` 与 `autoCreateChapters.count`）。 */
export const MAX_WORKFLOW_CHAPTERS_PER_RUN = 50;
