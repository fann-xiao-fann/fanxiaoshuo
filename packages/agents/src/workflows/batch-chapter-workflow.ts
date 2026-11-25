import {
  API_ERROR_CODES,
  countNovelWords,
  USAGE_SCENES,
  type AgentRole,
  type WorkflowMode,
  type WorkflowRunConfig,
  type WorkflowStepStage,
} from '@fanxiaoshuo/shared';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  assembleChapterContext,
  type ContextBookInfo,
  type ContextBookOutlineInput,
  type ContextPrevChapterInput,
  type ContextRecentSummaryInput,
} from '../context/context-assembler.js';
import type { ContextKnowledgeCardInput } from '../context/card-recall.js';
import { isModelGatewayError, ModelGatewayError } from '../gateway/errors.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { BudgetContext, ResolvedModelConfig } from '../gateway/types.js';
import {
  buildChapterCriticPrompts,
  buildChapterOutlinePrompts,
  buildChapterReworkPrompts,
  parseCriticReview,
  parsePlannedOutline,
  type ParsedCriticReview,
} from '../prompts/batch-workflow.js';
import {
  buildSummaryExtractPrompts,
  parseExtractedSummary,
  type ParsedExtractedSummary,
} from '../prompts/chapter-writer.js';

/**
 * 批量写书流水线的「单章 Mastra 工作流」。
 *
 * 固定 3 个 Step：`plan-outline` → `draft-and-review` → `extract-summary`。
 * 每个 Step 内部按运行模式与配置快照短路（未启用的阶段直接透传状态），
 * 从而让「仅拆细纲 / 仅成文 / 全链路生产」共用同一条经过验证的编排。
 *
 * 关键约束：
 * - 所有模型调用 100% 经 `ModelGateway`，每次调用都实时累加并透传 `budgetContext`；
 * - `BudgetExceededError` / `ModelGatewayError` 在 Step 内被捕获后交由运行门面**原样上抛**
 *   （Mastra 会把 Step 抛出的异常序列化为普通 Error，直接依赖它会丢失错误分类），
 *   确保 Worker 能精准识别 `BUDGET_EXCEEDED` 并熔断暂停；
 * - 阶段推进、暂停/取消检查点全部通过 `hooks` 回调交给 Worker 落盘，本模块不接触数据库与队列。
 */

/** Mastra 单章批量工作流固定 ID。 */
export const BATCH_CHAPTER_WORKFLOW_ID = 'fanxiaoshuo-batch-chapter';

/* -------------------------------------------------------------------------- */
/*                                业务契约类型                                 */
/* -------------------------------------------------------------------------- */

/** 单个角色在批量流水线中的模型配置（由 Worker 从 `agent_role_bindings` 解析）。 */
export interface WorkflowRoleModelInput {
  readonly config: ResolvedModelConfig;
  readonly temperature?: number;
  readonly maxOutputTokens?: number | null;
}

/** 单章流水线可用的 4 个角色模型（按运行模式按需取用）。 */
export interface BatchChapterWorkflowModels {
  readonly showrunner?: WorkflowRoleModelInput;
  readonly writer?: WorkflowRoleModelInput;
  readonly critic?: WorkflowRoleModelInput;
  readonly lorekeeper?: WorkflowRoleModelInput;
}

/** 批次级预算上下文（`maxCostUsd` 为 null 表示不限制）。 */
export interface BatchChapterWorkflowBudget {
  readonly maxCostUsd: number | null;
  readonly spentCostUsd: number;
}

/** 本章目标章节信息。 */
export interface BatchChapterWorkflowChapterInput {
  readonly id: string;
  readonly title: string;
  readonly contentText: string;
  readonly outline?: string;
}

/** `runBatchChapterWorkflow` 入参（Worker 任务边界，全部为纯数据）。 */
export interface BatchChapterWorkflowInput {
  readonly runId: string;
  readonly mode: WorkflowMode;
  readonly book: ContextBookInfo;
  readonly bookOutline?: ContextBookOutlineInput | null;
  readonly cards?: readonly ContextKnowledgeCardInput[];
  readonly recentSummaries?: readonly ContextRecentSummaryInput[];
  readonly prevChapter?: ContextPrevChapterInput | null;
  readonly chapter: BatchChapterWorkflowChapterInput;
  readonly config: WorkflowRunConfig;
  readonly models: BatchChapterWorkflowModels;
  readonly budget?: BatchChapterWorkflowBudget;
}

/** 阶段回调附带信息（返工轮次与审稿得分，供步骤时间线展示）。 */
export interface BatchChapterWorkflowStageMeta {
  readonly reworkCount?: number;
  readonly criticScore?: number | null;
}

/** 暂停/取消检查点返回值。 */
export type BatchChapterStopDecision = 'pause' | 'cancel' | null;

/** 单章工作流钩子（全部可选，纯回调，不涉及任何 Mastra 类型）。 */
export interface BatchChapterWorkflowHooks {
  /** 阶段流转回调（规划 / 成文 / 审稿 / 返工 / 摘要 / 完成） */
  onStageChange?: (
    stage: WorkflowStepStage,
    meta?: BatchChapterWorkflowStageMeta,
  ) => Promise<void> | void;
  /** 安全断点前的暂停 / 取消检查（每阶段与每轮返工前调用） */
  shouldStop?: () => Promise<BatchChapterStopDecision> | BatchChapterStopDecision;
  /** 外部取消信号（透传给 `ModelGateway`） */
  abortSignal?: AbortSignal;
  /** 仅供单元测试注入 Mock 模型；生产代码不应传入 */
  languageModelOverrides?: Partial<Record<AgentRole, import('ai').LanguageModel>>;
}

/** 工作流产出的纯业务结果（不含 Mastra 运行 ID）。 */
export interface BatchChapterWorkflowOutput {
  readonly stoppedReason: 'paused' | 'cancelled' | null;
  readonly plannedOutline: string | null;
  readonly contentText: string | null;
  readonly outputWordCount: number;
  readonly reworkCount: number;
  readonly criticReview: ParsedCriticReview | null;
  readonly extractedSummary: ParsedExtractedSummary | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
}

/** `runBatchChapterWorkflow` 返回值（门面补齐工作流 ID 与 Mastra 运行 ID）。 */
export interface BatchChapterWorkflowResult extends BatchChapterWorkflowOutput {
  readonly workflowId: typeof BATCH_CHAPTER_WORKFLOW_ID;
  readonly mastraRunId: string;
}

/**
 * 构建工作流时的可选引擎钩子（仅供 `createFanXiaoshuoRuntime` 内部使用）。
 * 用于把 Step 内捕获到的网关错误原样交还给运行门面。
 */
export interface BatchChapterWorkflowEngineOptions {
  /** Step 内捕获到网关错误（预算熔断 / 上游错误）时的上报回调 */
  readonly onGatewayFailure?: (runId: string, error: ModelGatewayError) => void;
}

/* -------------------------------------------------------------------------- */
/*                              内部运行状态                                   */
/* -------------------------------------------------------------------------- */

/**
 * 工作流原始入参（门面把业务入参与钩子一起交给 Mastra）。
 * 钩子只存在于进程内，不会被序列化或落库。
 */
export interface BatchChapterWorkflowRunInput {
  readonly input: BatchChapterWorkflowInput;
  readonly hooks: BatchChapterWorkflowHooks;
}

/** Step 之间流转的可变状态（把输入、钩子与累计账本一次性带过 3 个 Step）。 */
export interface BatchChapterRunState {
  readonly input: BatchChapterWorkflowInput;
  readonly hooks: BatchChapterWorkflowHooks;
  /** 本次运行开始前批次已花费的费用（用于预算熔断判定） */
  readonly initialSpentCostUsd: number;
  stoppedReason: 'paused' | 'cancelled' | null;
  plannedOutline: string | null;
  contentText: string | null;
  reworkCount: number;
  criticReview: ParsedCriticReview | null;
  extractedSummary: ParsedExtractedSummary | null;
  inputTokens: number;
  outputTokens: number;
  /** 本次运行累计产生的费用（不含 `initialSpentCostUsd`） */
  accruedCostUsd: number;
  /** Step 内捕获到的网关错误（由门面原样上抛） */
  failure: ModelGatewayError | null;
}

/** 审稿 / 返工循环的防御性迭代上限（正常路径远小于该值）。 */
const MAX_REVIEW_LOOP_ITERATIONS = 16;

/** 费用累加后的归一化精度（USD 保留 6 位小数，与库表 `numeric(12,6)` 对齐）。 */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/* -------------------------------------------------------------------------- */
/*                                 工具函数                                    */
/* -------------------------------------------------------------------------- */

/** 缺少某角色模型配置时的显式错误（绝不泄露任何密钥）。 */
function missingRoleModelError(role: AgentRole): ModelGatewayError {
  return new ModelGatewayError(
    `批量流水线缺少 ${role} 角色的模型配置，已阻止本次模型调用。`,
    { category: 'PROVIDER_ERROR', code: API_ERROR_CODES.INTERNAL_ERROR },
  );
}

/** 按角色取模型配置。 */
function resolveRoleModel(
  input: BatchChapterWorkflowInput,
  role: AgentRole,
): WorkflowRoleModelInput {
  const models = input.models;
  const model =
    role === 'showrunner'
      ? models.showrunner
      : role === 'writer'
        ? models.writer
        : role === 'critic'
          ? models.critic
          : models.lorekeeper;
  if (!model) throw missingRoleModelError(role);
  return model;
}

/** 构造当前时刻的实时预算上下文（`maxCostUsd` 为 null 时不传预算上限）。 */
function buildBudgetContext(state: BatchChapterRunState): BudgetContext | undefined {
  const budget = state.input.budget;
  if (!budget || budget.maxCostUsd === null) return undefined;
  return {
    runId: state.input.runId,
    maxCostUsd: budget.maxCostUsd,
    spentCostUsd: roundUsd(state.initialSpentCostUsd + state.accruedCostUsd),
  };
}

/** 通知阶段变化。 */
async function notifyStage(
  state: BatchChapterRunState,
  stage: WorkflowStepStage,
  meta?: BatchChapterWorkflowStageMeta,
): Promise<void> {
  const handler = state.hooks.onStageChange;
  if (!handler) return;
  if (meta === undefined) {
    await handler(stage);
    return;
  }
  await handler(stage, meta);
}

/**
 * 暂停 / 取消检查点。
 *
 * @returns `true` 表示已停止（`stoppedReason` 已被置位），调用方必须立即结束当前阶段。
 */
async function stopIfRequested(state: BatchChapterRunState): Promise<boolean> {
  if (state.stoppedReason !== null) return true;
  const shouldStop = state.hooks.shouldStop;
  if (!shouldStop) return false;
  const decision = await shouldStop();
  if (decision === 'pause') {
    state.stoppedReason = 'paused';
    return true;
  }
  if (decision === 'cancel') {
    state.stoppedReason = 'cancelled';
    return true;
  }
  return false;
}

/** 把运行状态收敛为工作流输出。 */
function buildOutput(state: BatchChapterRunState): BatchChapterWorkflowOutput {
  return {
    stoppedReason: state.stoppedReason,
    plannedOutline: state.plannedOutline,
    contentText: state.contentText,
    outputWordCount: countNovelWords(state.contentText ?? ''),
    reworkCount: state.reworkCount,
    criticReview: state.criticReview,
    extractedSummary: state.extractedSummary,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    estimatedCostUsd: roundUsd(state.accruedCostUsd),
  };
}

/* -------------------------------------------------------------------------- */
/*                             Step / Workflow 定义                            */
/* -------------------------------------------------------------------------- */

const workflowInputSchema = z.custom<BatchChapterWorkflowRunInput>(() => true);
const runStateSchema = z.custom<BatchChapterRunState>(() => true);
const workflowOutputSchema = z.custom<BatchChapterWorkflowOutput>(() => true);

/**
 * 构建 `fanxiaoshuo-batch-chapter` 单章 Mastra 工作流。
 *
 * 工作流无状态（所有运行期数据都在 Step 之间的 `inputData` 里流转），
 * 因此可以被 `Mastra` 实例长期持有，并被不同批次、不同章节复用。
 */
export function createBatchChapterWorkflow(
  gateway: ModelGateway,
  options: BatchChapterWorkflowEngineOptions = {},
) {
  /** 统一网关调用：解析模型、注入实时预算、累计 Token 与费用。 */
  async function generateForRole(
    state: BatchChapterRunState,
    role: AgentRole,
    scene: string,
    prompts: { readonly system: string; readonly prompt: string },
  ): Promise<string> {
    const model = resolveRoleModel(state.input, role);
    const budgetContext = buildBudgetContext(state);
    const override = state.hooks.languageModelOverrides?.[role];
    const maxOutputTokens = model.maxOutputTokens ?? undefined;
    const abortSignal = state.hooks.abortSignal;

    const result = await gateway.generateText({
      config: model.config,
      role,
      scene,
      system: prompts.system,
      prompt: prompts.prompt,
      ...(model.temperature === undefined ? {} : { temperature: model.temperature }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(override === undefined ? {} : { languageModelOverride: override }),
      ...(abortSignal === undefined ? {} : { abortSignal }),
      ...(budgetContext === undefined ? {} : { budgetContext }),
    });

    state.inputTokens += result.inputTokens;
    state.outputTokens += result.outputTokens;
    state.accruedCostUsd = roundUsd(state.accruedCostUsd + result.estimatedCostUsd);
    return result.text;
  }

  /**
   * 受控执行一个阶段的业务逻辑。
   *
   * 网关错误（含预算熔断）在这里被捕获并上报给门面原样上抛，
   * 其余异常继续保持抛出，让 Mastra 明确标记为失败。
   */
  async function guarded(
    state: BatchChapterRunState,
    body: () => Promise<void>,
  ): Promise<void> {
    if (state.failure !== null) return;
    try {
      await body();
    } catch (error) {
      if (!isModelGatewayError(error)) throw error;
      state.failure = error;
      options.onGatewayFailure?.(state.input.runId, error);
    }
  }

  const planOutlineStep = createStep({
    id: 'plan-outline',
    inputSchema: workflowInputSchema,
    outputSchema: runStateSchema,
    execute: async ({ inputData }) => {
      const { input, hooks } = inputData;
      const state: BatchChapterRunState = {
        input,
        hooks,
        initialSpentCostUsd: input.budget?.spentCostUsd ?? 0,
        stoppedReason: null,
        plannedOutline: null,
        contentText: null,
        reworkCount: 0,
        criticReview: null,
        extractedSummary: null,
        inputTokens: 0,
        outputTokens: 0,
        accruedCostUsd: 0,
        failure: null,
      };

      if (input.mode !== 'outline_only' && input.mode !== 'full_pipeline') {
        return state;
      }

      await guarded(state, async () => {
        if (await stopIfRequested(state)) return;
        await notifyStage(state, 'planning');

        const prompts = buildChapterOutlinePrompts({
          bookTitle: input.book.title,
          ...(input.book.genre === undefined ? {} : { genre: input.book.genre }),
          bookOutline: input.bookOutline ?? null,
          cards: input.cards ?? [],
          recentSummaries: input.recentSummaries ?? [],
          prevChapter: input.prevChapter ?? null,
          chapterTitle: input.chapter.title,
          existingOutline: input.chapter.outline ?? null,
          ...(input.config.instruction ? { instruction: input.config.instruction } : {}),
        });

        const raw = await generateForRole(state, 'showrunner', USAGE_SCENES.outlinePlan, prompts);
        const planned = parsePlannedOutline(raw);
        state.plannedOutline = planned || input.chapter.outline?.trim() || null;
      });

      return state;
    },
  });

  const draftAndReviewStep = createStep({
    id: 'draft-and-review',
    inputSchema: runStateSchema,
    outputSchema: runStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      const input = state.input;

      if (input.mode !== 'write_chapters' && input.mode !== 'full_pipeline') return state;

      await guarded(state, async () => {
        if (await stopIfRequested(state)) return;

        await notifyStage(state, 'writing');

        const outline = state.plannedOutline ?? input.chapter.outline?.trim() ?? '';
        const targetWords = input.config.targetWords;
        const assembled = assembleChapterContext({
          book: input.book,
          outline: input.bookOutline ?? null,
          cards: input.cards ?? [],
          recentSummaries: input.recentSummaries ?? [],
          prevChapter: input.prevChapter ?? null,
          chapter: {
            title: input.chapter.title,
            contentText: input.chapter.contentText,
            ...(outline ? { outline } : {}),
          },
          options: {
            action: 'continue',
            role: 'writer',
            instruction: input.config.instruction,
            maxContextTokens: input.config.maxContextTokens,
            includeOutline: true,
            ...(targetWords === undefined ? {} : { targetWords }),
          },
        });

        const baseSystemPrompt = assembled.systemPrompt;
        const baseUserPrompt = assembled.userPrompt;

        let contentText = (
          await generateForRole(state, 'writer', USAGE_SCENES.chapterWrite, {
            system: baseSystemPrompt,
            prompt: baseUserPrompt,
          })
        ).trim();
        state.contentText = contentText;

        if (!input.config.enableCritic) return;

        const maxReworkRounds = Math.max(0, input.config.maxReworkRounds);
        let iterations = 0;

        while (iterations < MAX_REVIEW_LOOP_ITERATIONS) {
          iterations += 1;

          if (await stopIfRequested(state)) return;

          await notifyStage(state, 'reviewing');

          const rawReview = await generateForRole(
            state,
            'critic',
            USAGE_SCENES.chapterReview,
            buildChapterCriticPrompts({
              bookTitle: input.book.title,
              chapterTitle: input.chapter.title,
              minPassScore: input.config.minPassScore,
              bookOutline: input.bookOutline ?? null,
              cards: input.cards ?? [],
              recentSummaries: input.recentSummaries ?? [],
              chapterOutline: outline || null,
              contentText,
              ...(input.config.instruction ? { instruction: input.config.instruction } : {}),
            }),
          );

          const review = parseCriticReview(rawReview, input.config.minPassScore);
          state.criticReview = review;

          if (review.passed) return;
          if (state.reworkCount >= maxReworkRounds) return;
          if (await stopIfRequested(state)) return;

          state.reworkCount += 1;
          await notifyStage(state, 'reworking', {
            reworkCount: state.reworkCount,
            criticScore: review.score,
          });

          const reworkPrompts = buildChapterReworkPrompts({
            baseSystemPrompt,
            baseUserPrompt,
            previousDraft: contentText,
            review,
            round: state.reworkCount,
            maxRounds: Math.max(1, maxReworkRounds),
            chapterTitle: input.chapter.title,
            ...(targetWords === undefined ? {} : { targetWords }),
          });

          contentText = (
            await generateForRole(state, 'writer', USAGE_SCENES.chapterWrite, reworkPrompts)
          ).trim();
          state.contentText = contentText;
        }
      });

      return state;
    },
  });

  const extractSummaryStep = createStep({
    id: 'extract-summary',
    inputSchema: runStateSchema,
    outputSchema: workflowOutputSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      const input = state.input;

      await guarded(state, async () => {
        const shouldSummarize =
          input.mode !== 'outline_only' &&
          input.config.enableSummary &&
          (state.contentText ?? '').trim().length > 0 &&
          state.stoppedReason === null;

        if (!shouldSummarize) return;
        if (await stopIfRequested(state)) return;

        await notifyStage(state, 'summarizing');

        const prompts = buildSummaryExtractPrompts({
          bookTitle: input.book.title,
          chapterTitle: input.chapter.title,
          contentText: state.contentText ?? '',
          existingOutline: state.plannedOutline ?? input.chapter.outline ?? undefined,
          ...(input.config.instruction ? { instruction: input.config.instruction } : {}),
        });

        const raw = await generateForRole(state, 'lorekeeper', USAGE_SCENES.loreExtract, prompts);
        state.extractedSummary = parseExtractedSummary(raw);
      });

      if (state.failure === null && state.stoppedReason === null) {
        await notifyStage(state, 'done');
      }

      return buildOutput(state);
    },
  });

  return createWorkflow({
    id: BATCH_CHAPTER_WORKFLOW_ID,
    inputSchema: workflowInputSchema,
    outputSchema: workflowOutputSchema,
  })
    .then(planOutlineStep)
    .then(draftAndReviewStep)
    .then(extractSummaryStep)
    .commit();
}
