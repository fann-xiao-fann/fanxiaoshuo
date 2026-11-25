import {
  API_ERROR_CODES,
  workflowJobPayloadSchema,
  type AgentRole,
  type ApiErrorCode,
  type WorkflowEventPayload,
  type WorkflowPauseReason,
  type WorkflowRunStatus,
  type WorkflowStepStage,
  type WorkflowStepStatus,
} from '@fanxiaoshuo/shared';
import {
  BudgetExceededError,
  isModelGatewayError,
  sanitizeErrorMessage,
  toSanitizedGatewayError,
  type BatchChapterWorkflowHooks,
  type BatchChapterWorkflowInput,
  type BatchChapterWorkflowModels,
  type BatchChapterWorkflowResult,
  type BatchChapterStopDecision,
  type FanXiaoshuoRuntime,
  type WorkflowRoleModelInput,
} from '@fanxiaoshuo/agents';
import type { Job } from 'bullmq';
import { WorkerJobError, isWorkerJobError } from '../errors.js';
import { createWorkflowEvent, type WorkflowEventPublisher } from '../events/workflow-events.js';
import type { WorkerLogger } from '../logger.js';
import type {
  ChapterContextData,
  WorkflowRunProgress,
  WorkflowRunSnapshot,
  WorkflowStepSnapshot,
  WorkflowStore,
} from '../db/workflow-repository.js';
import { normalizeMaxAttempts } from './smoke-job.js';

/**
 * `novel-workflows` 队列处理器。
 *
 * 职责边界（全部外部能力可注入，便于无 Redis / 无 PG 的纯单元测试）：
 * 1. 解析 `{ runId }` 负载，加载批次与有序步骤；
 * 2. 按 `stepIndex` 升序遍历**未完成**步骤（`completed` / `skipped` 一律跳过，断点续跑绝不重做）；
 * 3. 每步执行前低成本轮询暂停 / 取消 / 预算熔断控制态；
 * 4. 每步执行中通过 `onStageChange` 落盘阶段并广播实时事件，`shouldStop` 提供安全断点；
 * 5. 单章成功后先安全落盘（留底 `source: 'ai'` 快照 → 正文 → 摘要）再累加批次账本；
 * 6. 预算熔断转为 `paused (BUDGET_EXCEEDED)` 正常返回（绝不抛给 BullMQ 重试导致重复扣费）；
 * 7. 其它异常脱敏后标记步骤失败 + 批次失败，保留前序已完成章节成果。
 */

/** 与 BullMQ 解耦的任务上下文（单元测试无需构造真实 `Job`）。 */
export interface WorkflowJobContext {
  readonly jobId: string;
  /** BullMQ `job.attemptsMade`：本次执行前已失败的次数（0 表示首次执行） */
  readonly attemptsMade: number;
  /** 最大尝试次数（含首次），来自 `job.opts.attempts` */
  readonly maxAttempts: number;
  readonly data: unknown;
}

/** 可注入的运行时能力（生产为 Mastra 门面，测试为轻量 Fake）。 */
export type WorkflowJobRuntime = Pick<FanXiaoshuoRuntime, 'runBatchChapterWorkflow'>;

/** 处理器依赖（全部可注入）。 */
export interface WorkflowJobProcessorDeps {
  readonly store: WorkflowStore;
  readonly runtime: WorkflowJobRuntime;
  readonly resolveRoleModel: (role: AgentRole) => Promise<WorkflowRoleModelInput>;
  readonly publishEvent: WorkflowEventPublisher;
  /** 毫秒时间源，默认 `Date.now`（测试注入固定时钟） */
  readonly now?: () => number;
  readonly logger?: WorkerLogger;
}

/** 处理器结果（供 BullMQ 返回值与日志使用）。 */
export interface WorkflowJobResult {
  readonly runId: string;
  /** 结束时批次状态；批次不存在时为 null */
  readonly status: WorkflowRunStatus | null;
  /** 本次任务实际推进的步骤数（正常完成或失败的章节） */
  readonly processedSteps: number;
  readonly completedSteps: number;
  readonly failedSteps: number;
  readonly spentCostUsd: number;
}

export type WorkflowJobProcessor = (context: WorkflowJobContext) => Promise<WorkflowJobResult>;

/** 事件可选附加字段（批次 / 步骤事件共用）。 */
interface WorkflowEventExtra {
  readonly pauseReason?: WorkflowPauseReason | null;
  readonly stepId?: string | null;
  readonly chapterId?: string | null;
  readonly stepIndex?: number | null;
  readonly stepStatus?: WorkflowStepStatus | null;
  readonly stepStage?: WorkflowStepStage | null;
  readonly criticScore?: number | null;
  readonly errorCode?: ApiErrorCode | null;
  readonly errorMessage?: string | null;
}

/** 步骤级事件必填附加字段。 */
interface StepEventExtra extends WorkflowEventExtra {
  readonly stepStatus: WorkflowStepStatus;
}

/** 当前批次所需的角色集合（按运行模式与配置快照按需解析，绝不解析多余角色）。 */
interface WorkflowRoleNeeds {
  readonly showrunner: boolean;
  readonly writer: boolean;
  readonly critic: boolean;
  readonly lorekeeper: boolean;
}

/**
 * 构造 `novel-workflows` 任务处理器。
 *
 * 失败分类：
 * - 预算熔断（`BudgetExceededError` / `BUDGET_EXCEEDED`）→ `paused`，正常返回；
 * - 其它异常 → 单步 `failed` + 批次 `failed`，脱敏后正常返回（任务本身不重试）。
 */
export function createWorkflowJobProcessor(
  deps: WorkflowJobProcessorDeps,
): WorkflowJobProcessor {
  const now = deps.now ?? (() => Date.now());

  const safePublish = async (event: WorkflowEventPayload): Promise<void> => {
    try {
      await deps.publishEvent(event);
    } catch (error) {
      // 事件通道故障不应阻断写作与落盘；脱敏后告警即可。
      deps.logger?.warn('[worker] 批次事件发布失败', {
        runId: typeof event.runId === 'string' ? event.runId : 'unknown',
        type: event.type,
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  };

  const publishRunEvent = async (
    run: Pick<WorkflowRunSnapshot, 'id' | 'bookId'>,
    progress: WorkflowRunProgress,
    type: WorkflowEventPayload['type'],
    extra: WorkflowEventExtra = {},
  ): Promise<void> => {
    await safePublish(
      createWorkflowEvent({
        type,
        runId: run.id,
        bookId: run.bookId,
        status: progress.status,
        totalSteps: progress.totalSteps,
        completedSteps: progress.completedSteps,
        failedSteps: progress.failedSteps,
        spentCostUsd: progress.spentCostUsd,
        maxCostUsd: progress.maxCostUsd,
        timestamp: new Date(now()),
        ...extra,
      }),
    );
  };

  /** 步骤级事件统一走 `workflow.step_updated`（批次进度字段取当前已知最新值）。 */
  const publishStepEvent = async (
    run: Pick<WorkflowRunSnapshot, 'id' | 'bookId'>,
    progress: WorkflowRunProgress,
    step: WorkflowStepSnapshot,
    extra: StepEventExtra,
  ): Promise<void> => {
    await publishRunEvent(run, progress, 'workflow.step_updated', {
      stepId: step.id,
      chapterId: step.chapterId,
      stepIndex: step.stepIndex,
      stepStatus: extra.stepStatus,
      stepStage: extra.stepStage ?? null,
      criticScore: extra.criticScore ?? null,
      ...(extra.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
      ...(extra.errorMessage === undefined ? {} : { errorMessage: extra.errorMessage }),
    });
  };

  return async (context: WorkflowJobContext): Promise<WorkflowJobResult> => {
    const parsed = workflowJobPayloadSchema.safeParse(context.data);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join('.') ?? '(root)';
      throw new WorkerJobError(
        `批量流水线任务负载非法：字段 ${field} 未通过校验。`,
        API_ERROR_CODES.VALIDATION_ERROR,
      );
    }
    const runId = parsed.data.runId;

    const loaded = await deps.store.loadRunWithSteps(runId);
    if (!loaded) {
      deps.logger?.warn('[worker] 批量流水线批次不存在，任务安全结束', {
        jobId: context.jobId,
        runId,
      });
      return emptyResult(runId);
    }

    const run = loaded.run;
    if (run.status === 'completed' || run.status === 'cancelled') {
      // 断点续跑 / 重复投递兜底：终态批次绝不再推进（避免重复扣费与覆盖成果）。
      deps.logger?.info('[worker] 批次已处于终态，任务安全结束', {
        jobId: context.jobId,
        runId,
        status: run.status,
      });
      return resultOf(runId, run, 0);
    }

    await deps.store.markRunRunning(runId);
    await publishRunEvent(run, { ...toProgress(run), status: 'running' }, 'workflow.running');

    /** 本次任务内解析出的明文 Key 仅用于错误脱敏，绝不进入日志 / 事件 / 数据库 */
    const apiKeys: string[] = [];
    let processedSteps = 0;
    /** 最新批次进度基线（每步完成后由事务返回的快照刷新） */
    let progress: WorkflowRunProgress = { ...toProgress(run), status: 'running' };

    const steps = [...loaded.steps].sort((a, b) => a.stepIndex - b.stepIndex);

    for (const step of steps) {
      // 已完成 / 已跳过：断点续跑的核心保证——绝不重做已完成章节。
      if (step.status === 'completed' || step.status === 'skipped') {
        continue;
      }

      const control = await deps.store.readRunControlState(runId);
      if (!control) {
        deps.logger?.warn('[worker] 批次已被删除，停止推进', { runId });
        return emptyResult(runId);
      }

      progress = {
        ...progress,
        status: 'running',
        spentCostUsd: control.spentCostUsd,
        maxCostUsd: control.maxCostUsd,
      };

      if (control.cancelRequested) {
        const totals = await deps.store.markRunCancelled(runId);
        await publishRunEvent(run, totals, 'workflow.cancelled');
        return resultOf(runId, totals, processedSteps);
      }

      if (control.pauseRequested) {
        const totals = await deps.store.markRunPaused(runId, 'USER_PAUSED');
        await publishRunEvent(run, totals, 'workflow.paused', { pauseReason: 'USER_PAUSED' });
        return resultOf(runId, totals, processedSteps);
      }

      if (control.maxCostUsd !== null && control.spentCostUsd >= control.maxCostUsd) {
        const totals = await deps.store.markRunPaused(runId, 'BUDGET_EXCEEDED');
        await publishRunEvent(run, totals, 'workflow.paused', {
          pauseReason: 'BUDGET_EXCEEDED',
        });
        return resultOf(runId, totals, processedSteps);
      }

      try {
        const models = await resolveStepModels(run, deps.resolveRoleModel, apiKeys);
        // 每章开跑前重新读取最新 Book Bible（上一章刚写入的正文与摘要必须被下一章感知）。
        const chapterContext = await deps.store.loadChapterContextData(
          run.bookId,
          step.chapterId,
        );

        await deps.store.markStepRunning(step.id, 'idle');
        await publishStepEvent(run, progress, step, {
          stepStatus: 'running',
          stepStage: 'idle',
        });

        const hooks: BatchChapterWorkflowHooks = {
          onStageChange: async (stage, meta) => {
            await deps.store.updateStepStage(step.id, stage, meta);
            await publishStepEvent(run, progress, step, {
              stepStatus: 'running',
              stepStage: stage,
              criticScore: meta?.criticScore ?? null,
            });
          },
          shouldStop: async (): Promise<BatchChapterStopDecision> => {
            const latest = await deps.store.readRunControlState(runId);
            if (!latest) return 'cancel';
            if (latest.cancelRequested) return 'cancel';
            if (latest.pauseRequested) return 'pause';
            return null;
          },
        };

        const result = await deps.runtime.runBatchChapterWorkflow(
          buildWorkflowInput(run, step, chapterContext, models, control),
          hooks,
        );

        if (result.stoppedReason === 'cancelled') {
          // 先回滚步骤并把已产生的部分用量累加到批次账本，再收敛为取消。
          await deps.store.resetStepToPending(step.id, usageOf(result));
          const totals = await deps.store.markRunCancelled(runId);
          await publishRunEvent(run, totals, 'workflow.cancelled');
          return resultOf(runId, totals, processedSteps);
        }

        if (result.stoppedReason === 'paused') {
          await deps.store.resetStepToPending(step.id, usageOf(result));
          const totals = await deps.store.markRunPaused(runId, 'USER_PAUSED');
          await publishRunEvent(run, totals, 'workflow.paused', { pauseReason: 'USER_PAUSED' });
          return resultOf(runId, totals, processedSteps);
        }

        // 安全落盘：事务内先插 `source: 'ai'` 留底快照，再写正文与摘要。
        const persisted = await deps.store.persistChapterWorkflowOutputs({
          bookId: run.bookId,
          chapterId: step.chapterId,
          plannedOutline: result.plannedOutline,
          contentText: result.contentText,
          outputWordCount: result.outputWordCount,
          enableCritic: run.mode !== 'outline_only' && run.config.enableCritic,
          extractedSummary: result.extractedSummary,
          mode: run.mode,
        });

        const totals = await deps.store.markStepCompleted(runId, step.id, {
          reworkCount: result.reworkCount,
          criticScore: result.criticReview?.score ?? null,
          criticPassed: result.criticReview?.passed ?? null,
          criticSummary: result.criticReview?.summary ?? null,
          criticIssues: result.criticReview?.issues ?? [],
          outputWordCount: result.outputWordCount,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimatedCostUsd: result.estimatedCostUsd,
          backupRevisionId: persisted.backupRevisionId,
        });
        processedSteps += 1;
        progress = { ...totals, status: 'running' };

        await publishStepEvent(run, progress, step, {
          stepStatus: 'completed',
          stepStage: 'done',
          criticScore: result.criticReview?.score ?? null,
        });
      } catch (error) {
        if (isBudgetError(error)) {
          // 预算熔断：不抛给 BullMQ（避免整批重试重复扣费），安全暂停等待上调预算续跑。
          await deps.store.resetStepToPending(step.id);
          const totals = await deps.store.markRunPaused(runId, 'BUDGET_EXCEEDED');
          await publishRunEvent(run, totals, 'workflow.paused', {
            pauseReason: 'BUDGET_EXCEEDED',
            errorCode: API_ERROR_CODES.BUDGET_EXCEEDED,
            errorMessage: sanitizeErrorMessage(error, apiKeys),
          });
          return resultOf(runId, totals, processedSteps);
        }

        const sanitized = sanitizeWorkflowError(error, apiKeys);
        const stepTotals = await deps.store.markStepFailed(runId, step.id, {
          errorCode: sanitized.code,
          errorMessage: sanitized.message,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
        });
        const totals = await deps.store.markRunFinished(runId, 'failed', sanitized);

        await publishStepEvent(run, { ...stepTotals, status: 'failed' }, step, {
          stepStatus: 'failed',
          errorCode: sanitized.code,
          errorMessage: sanitized.message,
        });
        await publishRunEvent(run, totals, 'workflow.failed', {
          errorCode: sanitized.code,
          errorMessage: sanitized.message,
        });

        deps.logger?.error('[worker] 批量流水线章节执行失败', {
          jobId: context.jobId,
          runId,
          stepIndex: step.stepIndex,
          code: sanitized.code,
          reason: sanitized.message,
        });
        return resultOf(runId, totals, processedSteps);
      }
    }

    const totals = await deps.store.markRunFinished(runId, 'completed');
    await publishRunEvent(run, totals, 'workflow.completed');
    deps.logger?.info('[worker] 批量流水线已完成', {
      jobId: context.jobId,
      runId,
      processedSteps,
      spentCostUsd: totals.spentCostUsd,
    });
    return resultOf(runId, totals, processedSteps);
  };
}

/**
 * BullMQ 适配器：把真实 `Job` 投影为与队列解耦的 `WorkflowJobContext`。
 * 最大尝试次数优先取队列任务自身 `opts.attempts`，缺省回退到共享默认策略。
 */
export function createBullMqWorkflowJobHandler(
  processor: WorkflowJobProcessor,
): (job: Job<unknown, WorkflowJobResult>) => Promise<WorkflowJobResult> {
  return async (job) => {
    const jobId = job.id ?? `workflow-${Date.now()}`;
    return processor({
      jobId,
      attemptsMade: Math.max(0, Math.trunc(job.attemptsMade)),
      maxAttempts: normalizeMaxAttempts(job.opts.attempts),
      data: job.data,
    });
  };
}

/** 批次所需角色（按运行模式 + 配置快照按需裁剪）。 */
function roleNeeds(run: WorkflowRunSnapshot): WorkflowRoleNeeds {
  const plans = run.mode === 'outline_only' || run.mode === 'full_pipeline';
  const writes = run.mode === 'write_chapters' || run.mode === 'full_pipeline';
  return {
    showrunner: plans,
    writer: writes,
    critic: writes && run.config.enableCritic,
    lorekeeper: writes && run.config.enableSummary,
  };
}

/** 按需解析角色模型，并收集明文 Key 用于后续错误脱敏。 */
async function resolveStepModels(
  run: WorkflowRunSnapshot,
  resolveRoleModel: (role: AgentRole) => Promise<WorkflowRoleModelInput>,
  apiKeys: string[],
): Promise<BatchChapterWorkflowModels> {
  const needs = roleNeeds(run);
  const models: {
    showrunner?: WorkflowRoleModelInput;
    writer?: WorkflowRoleModelInput;
    critic?: WorkflowRoleModelInput;
    lorekeeper?: WorkflowRoleModelInput;
  } = {};

  const load = async (role: AgentRole): Promise<WorkflowRoleModelInput> => {
    const model = await resolveRoleModel(role);
    apiKeys.push(model.config.apiKey);
    return model;
  };

  if (needs.showrunner) models.showrunner = await load('showrunner');
  if (needs.writer) models.writer = await load('writer');
  if (needs.critic) models.critic = await load('critic');
  if (needs.lorekeeper) models.lorekeeper = await load('lorekeeper');
  return models;
}

/** 组装单章工作流入参（纯数据，不泄露任何连接 / 队列对象）。 */
function buildWorkflowInput(
  run: WorkflowRunSnapshot,
  step: WorkflowStepSnapshot,
  context: ChapterContextData,
  models: BatchChapterWorkflowModels,
  control: { readonly maxCostUsd: number | null; readonly spentCostUsd: number },
): BatchChapterWorkflowInput {
  return {
    runId: run.id,
    mode: run.mode,
    book: context.book,
    bookOutline: context.bookOutline,
    cards: context.cards,
    recentSummaries: context.recentSummaries,
    prevChapter: context.prevChapter,
    chapter: {
      id: context.chapter.id,
      title: context.chapter.title || step.chapterTitleSnapshot,
      contentText: context.chapter.contentText,
      ...(context.chapter.outline === null ? {} : { outline: context.chapter.outline }),
    },
    config: run.config,
    models,
    budget: { maxCostUsd: control.maxCostUsd, spentCostUsd: control.spentCostUsd },
  };
}

/** 把工作流已产生的部分用量投影为步骤回滚参数（防止费用漏算）。 */
function usageOf(result: BatchChapterWorkflowResult): {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
} {
  return {
    inputTokens: Number.isFinite(result.inputTokens) ? Math.max(0, Math.trunc(result.inputTokens)) : 0,
    outputTokens: Number.isFinite(result.outputTokens)
      ? Math.max(0, Math.trunc(result.outputTokens))
      : 0,
    estimatedCostUsd: Number.isFinite(result.estimatedCostUsd)
      ? Math.max(0, result.estimatedCostUsd)
      : 0,
  };
}

/** 预算熔断判定（网关错误分类 + 共享错误码双保险）。 */
function isBudgetError(error: unknown): boolean {
  if (error instanceof BudgetExceededError) {
    return true;
  }
  return isModelGatewayError(error) && error.code === API_ERROR_CODES.BUDGET_EXCEEDED;
}

/** 归一化错误：分类 + 脱敏（明文 API Key 绝不出现在事件 / 数据库 / 日志）。 */
function sanitizeWorkflowError(
  error: unknown,
  secrets: readonly string[],
): { readonly code: ApiErrorCode; readonly message: string } {
  const message = sanitizeErrorMessage(error, secrets);
  if (isWorkerJobError(error)) {
    return { code: error.code, message };
  }
  if (isModelGatewayError(error)) {
    return { code: error.code, message };
  }
  return { code: toSanitizedGatewayError(error, secrets).code, message };
}

/** 批次进度投影。 */
function toProgress(run: WorkflowRunSnapshot): WorkflowRunProgress {
  return {
    status: run.status,
    totalSteps: run.totalSteps,
    completedSteps: run.completedSteps,
    failedSteps: run.failedSteps,
    spentCostUsd: run.spentCostUsd,
    maxCostUsd: run.maxCostUsd,
  };
}

function resultOf(
  runId: string,
  totals: WorkflowRunProgress,
  processedSteps: number,
): WorkflowJobResult {
  return {
    runId,
    status: totals.status,
    processedSteps,
    completedSteps: totals.completedSteps,
    failedSteps: totals.failedSteps,
    spentCostUsd: totals.spentCostUsd,
  };
}

function emptyResult(runId: string): WorkflowJobResult {
  return {
    runId,
    status: null,
    processedSteps: 0,
    completedSteps: 0,
    failedSteps: 0,
    spentCostUsd: 0,
  };
}
