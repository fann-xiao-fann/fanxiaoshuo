import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  workflowEventSchema,
  workflowRunConfigSchema,
  type AgentRole,
  type ApiErrorCode,
  type WorkflowEvent,
  type WorkflowMode,
  type WorkflowPauseReason,
  type WorkflowRunConfig,
  type WorkflowRunStatus,
  type WorkflowStepStage,
  type WorkflowStepStatus,
} from '@fanxiaoshuo/shared';
import {
  BATCH_CHAPTER_WORKFLOW_ID,
  BudgetExceededError,
  ModelGatewayError,
  resolvedModelConfigSchema,
  type BatchChapterWorkflowHooks,
  type BatchChapterWorkflowInput,
  type BatchChapterWorkflowResult,
  type WorkflowRoleModelInput,
} from '@fanxiaoshuo/agents';
import { silentWorkerLogger } from '../logger.js';
import type { WorkflowEventPublisher } from '../events/workflow-events.js';
import type {
  ChapterContextData,
  PersistChapterOutputsInput,
  StepCompletionData,
  StepFailureData,
  StepResetUsage,
  WorkflowControlState,
  WorkflowRunSnapshot,
  WorkflowRunTotalsSnapshot,
  WorkflowRunWithSteps,
  WorkflowStepSnapshot,
  WorkflowStore,
} from '../db/workflow-repository.js';
import {
  createWorkflowJobProcessor,
  type WorkflowJobProcessor,
  type WorkflowJobRuntime,
} from '../jobs/workflow-job.js';

/* -------------------------------------------------------------------------- */
/*                                  测试夹具                                   */
/* -------------------------------------------------------------------------- */

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const BOOK_ID = '22222222-2222-4222-8222-222222222222';
const CH1_ID = '33333333-3333-4333-8333-333333333333';
const CH2_ID = '44444444-4444-4444-8444-444444444444';
const STEP1_ID = '55555555-5555-4555-8555-555555555555';
const STEP2_ID = '66666666-6666-4666-8666-666666666666';
const API_KEY = 'sk-unit-test-secret-key-0001';

const DEFAULT_CONFIG: WorkflowRunConfig = workflowRunConfigSchema.parse({});

interface FakeRun {
  id: string;
  bookId: string;
  bookTitle: string;
  mode: WorkflowMode;
  status: WorkflowRunStatus;
  config: WorkflowRunConfig;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  maxCostUsd: number | null;
  spentCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  pauseRequested: boolean;
  cancelRequested: boolean;
  pauseReason: WorkflowPauseReason | null;
  errorCode: ApiErrorCode | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface FakeStep {
  id: string;
  runId: string;
  chapterId: string;
  stepIndex: number;
  chapterTitleSnapshot: string;
  status: WorkflowStepStatus;
  stage: WorkflowStepStage;
  reworkCount: number;
  criticScore: number | null;
  backupRevisionId: string | null;
}

function createRun(overrides: Partial<FakeRun> = {}): FakeRun {
  return {
    id: RUN_ID,
    bookId: BOOK_ID,
    bookTitle: '测试之书',
    mode: 'full_pipeline',
    status: 'queued',
    config: DEFAULT_CONFIG,
    totalSteps: 2,
    completedSteps: 0,
    failedSteps: 0,
    maxCostUsd: 5,
    spentCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    pauseRequested: false,
    cancelRequested: false,
    pauseReason: null,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function createStep(index: number, overrides: Partial<FakeStep> = {}): FakeStep {
  const chapterId = index === 0 ? CH1_ID : CH2_ID;
  return {
    id: index === 0 ? STEP1_ID : STEP2_ID,
    runId: RUN_ID,
    chapterId,
    stepIndex: index,
    chapterTitleSnapshot: index === 0 ? '第1章 初入江湖' : '第2章 风云再起',
    status: 'pending',
    stage: 'idle',
    reworkCount: 0,
    criticScore: null,
    backupRevisionId: null,
    ...overrides,
  };
}

function createContext(
  chapterId: string,
  title: string,
  overrides: Partial<ChapterContextData> = {},
): ChapterContextData {
  return {
    book: { title: '测试之书', genre: '玄幻', synopsis: '简介', targetChapterWords: 3000 },
    bookOutline: {
      mainPlot: '主线',
      worldSetting: '世界观',
      styleGuide: '文风',
      endingPlan: '结局',
    },
    cards: [],
    recentSummaries: [],
    prevChapter: null,
    chapter: { id: chapterId, title, contentText: '', outline: null },
    ...overrides,
  };
}

interface FakeStoreHandle {
  readonly store: WorkflowStore;
  readonly run: FakeRun;
  readonly steps: FakeStep[];
  readonly persistCalls: PersistChapterOutputsInput[];
  readonly contextLoads: Array<{ bookId: string; chapterId: string }>;
  readonly order: string[];
}

function createFakeStore(init: {
  run: FakeRun;
  steps: FakeStep[];
  contexts: Record<string, ChapterContextData>;
  onPersist?: (input: PersistChapterOutputsInput, contexts: Record<string, ChapterContextData>) => void;
}): FakeStoreHandle {
  const { run, steps, contexts } = init;
  const persistCalls: PersistChapterOutputsInput[] = [];
  const contextLoads: Array<{ bookId: string; chapterId: string }> = [];
  const order: string[] = [];

  const snapshotRun = (): WorkflowRunSnapshot => ({ ...run });

  const snapshotSteps = (): WorkflowStepSnapshot[] => steps.map((step) => ({ ...step }));

  const recompute = (): void => {
    run.completedSteps = steps.filter((step) => step.status === 'completed').length;
    run.failedSteps = steps.filter((step) => step.status === 'failed').length;
  };

  const totals = (): WorkflowRunTotalsSnapshot => ({
    status: run.status,
    totalSteps: run.totalSteps,
    completedSteps: run.completedSteps,
    failedSteps: run.failedSteps,
    spentCostUsd: run.spentCostUsd,
    maxCostUsd: run.maxCostUsd,
    totalInputTokens: run.totalInputTokens,
    totalOutputTokens: run.totalOutputTokens,
  });

  const findStep = (stepId: string): FakeStep => {
    const step = steps.find((item) => item.id === stepId);
    if (!step) {
      throw new Error(`FakeStore: 未找到步骤 ${stepId}`);
    }
    return step;
  };

  const store: WorkflowStore = {
    async loadRunWithSteps(): Promise<WorkflowRunWithSteps> {
      order.push('load');
      return { run: snapshotRun(), steps: snapshotSteps() };
    },

    async readRunControlState(): Promise<WorkflowControlState> {
      return {
        status: run.status,
        pauseRequested: run.pauseRequested,
        cancelRequested: run.cancelRequested,
        maxCostUsd: run.maxCostUsd,
        spentCostUsd: run.spentCostUsd,
      };
    },

    async markRunRunning(): Promise<void> {
      run.status = 'running';
      run.startedAt = run.startedAt ?? new Date(0).toISOString();
      run.pauseReason = null;
      run.errorCode = null;
      run.errorMessage = null;
    },

    async markRunPaused(_runId: string, reason: WorkflowPauseReason): Promise<WorkflowRunTotalsSnapshot> {
      run.status = 'paused';
      run.pauseRequested = false;
      run.pauseReason = reason;
      return totals();
    },

    async markRunCancelled(): Promise<WorkflowRunTotalsSnapshot> {
      for (const step of steps) {
        if (step.status === 'pending' || step.status === 'running') {
          step.status = 'skipped';
        }
      }
      run.status = 'cancelled';
      run.cancelRequested = true;
      run.finishedAt = new Date(0).toISOString();
      return totals();
    },

    async markRunFinished(
      _runId: string,
      status: 'completed' | 'failed',
      error?: { code: ApiErrorCode; message: string } | null,
    ): Promise<WorkflowRunTotalsSnapshot> {
      recompute();
      run.status = status;
      run.finishedAt = new Date(0).toISOString();
      run.errorCode = error?.code ?? null;
      run.errorMessage = error?.message ?? null;
      return totals();
    },

    async markStepRunning(stepId: string, stage: WorkflowStepStage): Promise<void> {
      const step = findStep(stepId);
      step.status = 'running';
      step.stage = stage;
    },

    async updateStepStage(
      stepId: string,
      stage: WorkflowStepStage,
      meta?: { reworkCount?: number; criticScore?: number | null },
    ): Promise<void> {
      const step = findStep(stepId);
      step.stage = stage;
      if (meta?.reworkCount !== undefined) step.reworkCount = meta.reworkCount;
      if (meta?.criticScore !== undefined) step.criticScore = meta.criticScore;
    },

    async markStepCompleted(
      _runId: string,
      stepId: string,
      data: StepCompletionData,
    ): Promise<WorkflowRunTotalsSnapshot> {
      const step = findStep(stepId);
      step.status = 'completed';
      step.stage = 'done';
      step.reworkCount = data.reworkCount;
      step.criticScore = data.criticScore;
      step.backupRevisionId = data.backupRevisionId;
      run.spentCostUsd += data.estimatedCostUsd;
      run.totalInputTokens += data.inputTokens;
      run.totalOutputTokens += data.outputTokens;
      recompute();
      return totals();
    },

    async markStepFailed(
      _runId: string,
      stepId: string,
      data: StepFailureData,
    ): Promise<WorkflowRunTotalsSnapshot> {
      const step = findStep(stepId);
      step.status = 'failed';
      run.spentCostUsd += data.estimatedCostUsd;
      run.totalInputTokens += data.inputTokens;
      run.totalOutputTokens += data.outputTokens;
      recompute();
      return totals();
    },

    async resetStepToPending(stepId: string, data?: StepResetUsage): Promise<void> {
      const step = findStep(stepId);
      step.status = 'pending';
      step.stage = 'idle';
      step.backupRevisionId = null;
      run.spentCostUsd += data?.estimatedCostUsd ?? 0;
      run.totalInputTokens += data?.inputTokens ?? 0;
      run.totalOutputTokens += data?.outputTokens ?? 0;
    },

    async loadChapterContextData(
      bookId: string,
      chapterId: string,
    ): Promise<ChapterContextData> {
      order.push(`context:${chapterId}`);
      contextLoads.push({ bookId, chapterId });
      const context = contexts[chapterId];
      if (!context) {
        throw new Error(`FakeStore: 未准备章节 ${chapterId} 的上下文`);
      }
      return context;
    },

    async persistChapterWorkflowOutputs(
      input: PersistChapterOutputsInput,
    ): Promise<{ backupRevisionId: string | null }> {
      persistCalls.push(input);
      order.push(`persist:${input.chapterId}`);
      init.onPersist?.(input, contexts);
      return { backupRevisionId: `rev-${input.chapterId}` };
    },
  };

  return { store, run, steps, persistCalls, contextLoads, order };
}

function createModelResolver(apiKey: string = API_KEY): {
  readonly resolve: (role: AgentRole) => Promise<WorkflowRoleModelInput>;
  readonly calls: AgentRole[];
} {
  const calls: AgentRole[] = [];
  return {
    calls,
    async resolve(role: AgentRole): Promise<WorkflowRoleModelInput> {
      calls.push(role);
      return {
        config: resolvedModelConfigSchema.parse({
          providerId: '77777777-7777-4777-8777-777777777777',
          providerName: 'unit-test-provider',
          protocol: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKey,
          modelId: 'unit-test-model',
          displayName: 'Unit Test Model',
          inputPricePer1m: 0.1,
          outputPricePer1m: 0.2,
        }),
        temperature: 0.7,
        maxOutputTokens: 2048,
      };
    },
  };
}

function createRuntime(
  handler: (
    input: BatchChapterWorkflowInput,
    hooks: BatchChapterWorkflowHooks,
  ) => Promise<BatchChapterWorkflowResult>,
): WorkflowJobRuntime & { readonly calls: BatchChapterWorkflowInput[] } {
  const calls: BatchChapterWorkflowInput[] = [];
  return {
    calls,
    async runBatchChapterWorkflow(input, hooks = {}) {
      calls.push(input);
      return handler(input, hooks);
    },
  };
}

function createResult(
  input: BatchChapterWorkflowInput,
  overrides: Partial<BatchChapterWorkflowResult> = {},
): BatchChapterWorkflowResult {
  return {
    workflowId: BATCH_CHAPTER_WORKFLOW_ID,
    mastraRunId: `mastra-run-${input.chapter.id}`,
    stoppedReason: null,
    plannedOutline: `细纲-${input.chapter.title}`,
    contentText: `正文-${input.chapter.title}`,
    outputWordCount: 1200,
    reworkCount: 1,
    criticReview: {
      score: 88,
      passed: true,
      summary: '节奏紧凑，人物口吻统一。',
      issues: ['第 3 段略显拖沓'],
      reworkGuidance: '压缩第 3 段',
    },
    extractedSummary: {
      summary: `摘要-${input.chapter.title}`,
      keyEvents: ['主角登场'],
      charactersPresent: ['主角'],
    },
    inputTokens: 100,
    outputTokens: 200,
    estimatedCostUsd: 0.01,
    ...overrides,
  };
}

function createEventCollector(): {
  readonly events: WorkflowEvent[];
  readonly publishEvent: WorkflowEventPublisher;
} {
  const events: WorkflowEvent[] = [];
  return {
    events,
    async publishEvent(payload) {
      const parsed = workflowEventSchema.parse(payload);
      events.push(parsed);
      return parsed;
    },
  };
}

function createProcessor(
  store: WorkflowStore,
  runtime: WorkflowJobRuntime,
  publishEvent: WorkflowEventPublisher,
  resolver = createModelResolver(),
): { readonly processor: WorkflowJobProcessor; readonly resolver: ReturnType<typeof createModelResolver> } {
  return {
    resolver,
    processor: createWorkflowJobProcessor({
      store,
      runtime,
      resolveRoleModel: resolver.resolve,
      publishEvent,
      logger: silentWorkerLogger,
    }),
  };
}

const CONTEXT = {
  jobId: 'workflow-job-1',
  attemptsMade: 0,
  maxAttempts: 1,
  data: { runId: RUN_ID },
};

/* -------------------------------------------------------------------------- */
/*                                  测试用例                                   */
/* -------------------------------------------------------------------------- */

describe('createWorkflowJobProcessor', () => {
  it('多章 full_pipeline 串行跑通：逐章落盘、留底快照、实时事件完整', async () => {
    const contexts: Record<string, ChapterContextData> = {
      [CH1_ID]: createContext(CH1_ID, '第1章 初入江湖'),
      [CH2_ID]: createContext(CH2_ID, '第2章 风云再起'),
    };
    const fake = createFakeStore({
      run: createRun(),
      steps: [createStep(0), createStep(1)],
      contexts,
      // 模拟「第 1 章落盘后，数据库中的第 2 章上下文立即包含第 1 章正文与摘要」。
      onPersist: (input, map) => {
        if (input.chapterId !== CH1_ID) return;
        map[CH2_ID] = createContext(CH2_ID, '第2章 风云再起', {
          prevChapter: { title: '第1章 初入江湖', contentText: input.contentText ?? '' },
          recentSummaries: [
            {
              chapterTitle: '第1章 初入江湖',
              summary: input.extractedSummary?.summary ?? '',
            },
          ],
        });
      },
    });
    const runtime = createRuntime(async (input, hooks) => {
      await hooks.onStageChange?.('planning');
      await hooks.onStageChange?.('writing');
      await hooks.onStageChange?.('reviewing', { criticScore: 88 });
      await hooks.onStageChange?.('summarizing');
      await hooks.onStageChange?.('done');
      return createResult(input);
    });
    const collector = createEventCollector();
    const { processor, resolver } = createProcessor(fake.store, runtime, collector.publishEvent);

    const result = await processor(CONTEXT);

    expect(result).toMatchObject({
      runId: RUN_ID,
      status: 'completed',
      processedSteps: 2,
      completedSteps: 2,
      failedSteps: 0,
    });
    expect(result.spentCostUsd).toBeCloseTo(0.02, 6);

    // 每章都完整解析 4 个角色模型（showrunner / writer / critic / lorekeeper）
    expect(resolver.calls).toEqual([
      'showrunner',
      'writer',
      'critic',
      'lorekeeper',
      'showrunner',
      'writer',
      'critic',
      'lorekeeper',
    ]);

    // 第 1 章：先留底快照（由 Store 返回 revision id）→ 正文 / 摘要
    expect(fake.persistCalls).toHaveLength(2);
    const first = fake.persistCalls[0];
    expect(first?.chapterId).toBe(CH1_ID);
    expect(first?.plannedOutline).toBe('细纲-第1章 初入江湖');
    expect(first?.contentText).toBe('正文-第1章 初入江湖');
    expect(first?.outputWordCount).toBe(1200);
    expect(first?.enableCritic).toBe(true);
    expect(first?.mode).toBe('full_pipeline');
    expect(first?.extractedSummary?.summary).toBe('摘要-第1章 初入江湖');

    // 第 2 章执行时必然读到最新前情记忆与紧邻上一章正文
    const secondCall = runtime.calls[1];
    expect(secondCall?.chapter.id).toBe(CH2_ID);
    expect(secondCall?.prevChapter?.contentText).toBe('正文-第1章 初入江湖');
    expect(secondCall?.recentSummaries?.[0]?.summary).toBe('摘要-第1章 初入江湖');
    expect(secondCall?.models.showrunner).toBeDefined();
    expect(secondCall?.budget).toEqual({ maxCostUsd: 5, spentCostUsd: 0.01 });

    // 落盘顺序：第 1 章先落盘，才可能加载第 2 章上下文
    expect(fake.order.indexOf(`persist:${CH1_ID}`)).toBeGreaterThan(-1);
    expect(fake.order.indexOf(`persist:${CH1_ID}`)).toBeLessThan(
      fake.order.indexOf(`context:${CH2_ID}`),
    );

    // 步骤状态与留底快照 ID 已落盘
    expect(fake.steps.map((step) => step.status)).toEqual(['completed', 'completed']);
    expect(fake.steps.map((step) => step.backupRevisionId)).toEqual([
      `rev-${CH1_ID}`,
      `rev-${CH2_ID}`,
    ]);

    // 事件：running → step_updated（多帧）→ completed
    const types = collector.events.map((event) => event.type);
    expect(types[0]).toBe('workflow.running');
    expect(types.at(-1)).toBe('workflow.completed');
    expect(types.filter((type) => type === 'workflow.step_updated').length).toBeGreaterThanOrEqual(2);

    const running = collector.events[0];
    expect(running).toMatchObject({ status: 'running', totalSteps: 2, completedSteps: 0 });

    const stepCompleted = collector.events.filter(
      (event) => event.type === 'workflow.step_updated' && event.stepStatus === 'completed',
    );
    expect(stepCompleted).toHaveLength(2);
    expect(stepCompleted[0]).toMatchObject({
      stepId: STEP1_ID,
      chapterId: CH1_ID,
      stepIndex: 0,
      stepStage: 'done',
      criticScore: 88,
    });
    expect(stepCompleted[1]).toMatchObject({
      stepId: STEP2_ID,
      completedSteps: 2,
      spentCostUsd: 0.02,
    });

    const completed = collector.events.at(-1);
    expect(completed).toMatchObject({
      type: 'workflow.completed',
      status: 'completed',
      completedSteps: 2,
      failedSteps: 0,
    });

    // 阶段事件中继：每一步的阶段流转都被广播
    const stages = collector.events
      .filter((event) => event.type === 'workflow.step_updated')
      .map((event) => event.stepStage);
    expect(stages).toContain('planning');
    expect(stages).toContain('writing');
    expect(stages).toContain('reviewing');
    expect(stages).toContain('summarizing');
  });

  it('累计费用触及 maxCostUsd：下一章开跑前自动熔断为 paused(BUDGET_EXCEEDED)', async () => {
    const contexts: Record<string, ChapterContextData> = {
      [CH1_ID]: createContext(CH1_ID, '第1章'),
      [CH2_ID]: createContext(CH2_ID, '第2章'),
    };
    const fake = createFakeStore({
      run: createRun({ maxCostUsd: 0.01 }),
      steps: [createStep(0), createStep(1)],
      contexts,
    });
    const runtime = createRuntime(async (input) =>
      createResult(input, { estimatedCostUsd: 0.01 }),
    );
    const collector = createEventCollector();
    const { processor } = createProcessor(fake.store, runtime, collector.publishEvent);

    const result = await processor(CONTEXT);

    expect(result.status).toBe('paused');
    expect(result.processedSteps).toBe(1);
    expect(runtime.calls).toHaveLength(1);
    expect(fake.persistCalls).toHaveLength(1);
    expect(fake.run.pauseReason).toBe('BUDGET_EXCEEDED');
    expect(fake.steps[0]?.status).toBe('completed');
    // 第 2 章保持 pending，供上调预算后续跑
    expect(fake.steps[1]?.status).toBe('pending');

    const paused = collector.events.at(-1);
    expect(paused).toMatchObject({
      type: 'workflow.paused',
      status: 'paused',
      pauseReason: 'BUDGET_EXCEEDED',
      completedSteps: 1,
    });
    expect(collector.events.some((event) => event.type === 'workflow.completed')).toBe(false);
  });

  it('网关抛出 BudgetExceededError：步骤回滚 pending、批次暂停且不抛给 BullMQ 重试', async () => {
    const contexts: Record<string, ChapterContextData> = {
      [CH1_ID]: createContext(CH1_ID, '第1章'),
      [CH2_ID]: createContext(CH2_ID, '第2章'),
    };
    const fake = createFakeStore({
      run: createRun({ maxCostUsd: 5 }),
      steps: [createStep(0), createStep(1)],
      contexts,
    });
    const runtime = createRuntime(async (input) => {
      if (input.chapter.id === CH2_ID) {
        throw new BudgetExceededError({
          runId: RUN_ID,
          maxCostUsd: 5,
          spentCostUsd: 5.01,
        });
      }
      return createResult(input);
    });
    const collector = createEventCollector();
    const { processor } = createProcessor(fake.store, runtime, collector.publishEvent);

    const result = await processor(CONTEXT);

    expect(result.status).toBe('paused');
    expect(result.processedSteps).toBe(1);
    expect(fake.run.pauseReason).toBe('BUDGET_EXCEEDED');
    expect(fake.steps[0]?.status).toBe('completed');
    expect(fake.steps[1]?.status).toBe('pending');
    expect(fake.steps[1]?.stage).toBe('idle');
    expect(fake.persistCalls).toHaveLength(1);

    const paused = collector.events.at(-1);
    expect(paused).toMatchObject({
      type: 'workflow.paused',
      pauseReason: 'BUDGET_EXCEEDED',
      errorCode: API_ERROR_CODES.BUDGET_EXCEEDED,
    });
  });

  it('断点续跑：跳过已完成章节，仅执行剩余 pending 章节', async () => {
    const contexts: Record<string, ChapterContextData> = {
      [CH1_ID]: createContext(CH1_ID, '第1章'),
      [CH2_ID]: createContext(CH2_ID, '第2章'),
    };
    const fake = createFakeStore({
      run: createRun({ status: 'paused', completedSteps: 1, spentCostUsd: 0.01 }),
      steps: [
        createStep(0, { status: 'completed', stage: 'done', backupRevisionId: `rev-${CH1_ID}` }),
        createStep(1),
      ],
      contexts,
    });
    const runtime = createRuntime(async (input) =>
      createResult(input, { estimatedCostUsd: 0.02 }),
    );
    const collector = createEventCollector();
    const { processor } = createProcessor(fake.store, runtime, collector.publishEvent);

    const result = await processor(CONTEXT);

    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.chapter.id).toBe(CH2_ID);
    expect(fake.persistCalls).toHaveLength(1);
    expect(fake.persistCalls[0]?.chapterId).toBe(CH2_ID);
    expect(result.status).toBe('completed');
    expect(result.completedSteps).toBe(2);
    expect(result.spentCostUsd).toBeCloseTo(0.03, 6);
  });

  it('用户暂停（pauseRequested）：不消耗任何模型调用，安全收敛为 paused(USER_PAUSED)', async () => {
    const contexts: Record<string, ChapterContextData> = {
      [CH1_ID]: createContext(CH1_ID, '第1章'),
      [CH2_ID]: createContext(CH2_ID, '第2章'),
    };
    const fake = createFakeStore({
      run: createRun({ status: 'running', pauseRequested: true }),
      steps: [createStep(0), createStep(1)],
      contexts,
    });
    const runtime = createRuntime(async (input) => createResult(input));
    const collector = createEventCollector();
    const { processor } = createProcessor(fake.store, runtime, collector.publishEvent);

    const result = await processor(CONTEXT);

    expect(result.status).toBe('paused');
    expect(runtime.calls).toHaveLength(0);
    expect(fake.persistCalls).toHaveLength(0);
    expect(fake.steps.map((step) => step.status)).toEqual(['pending', 'pending']);
    expect(fake.run.pauseReason).toBe('USER_PAUSED');
    expect(collector.events.at(-1)).toMatchObject({
      type: 'workflow.paused',
      pauseReason: 'USER_PAUSED',
    });
  });

  it('用户取消（cancelRequested）：剩余步骤置 skipped，批次收敛为 cancelled', async () => {
    const contexts: Record<string, ChapterContextData> = {
      [CH1_ID]: createContext(CH1_ID, '第1章'),
      [CH2_ID]: createContext(CH2_ID, '第2章'),
    };
    const fake = createFakeStore({
      run: createRun({ status: 'running', cancelRequested: true }),
      steps: [createStep(0), createStep(1)],
      contexts,
    });
    const runtime = createRuntime(async (input) => createResult(input));
    const collector = createEventCollector();
    const { processor } = createProcessor(fake.store, runtime, collector.publishEvent);

    const result = await processor(CONTEXT);

    expect(result.status).toBe('cancelled');
    expect(runtime.calls).toHaveLength(0);
    expect(fake.persistCalls).toHaveLength(0);
    expect(fake.steps.map((step) => step.status)).toEqual(['skipped', 'skipped']);
    expect(collector.events.at(-1)).toMatchObject({ type: 'workflow.cancelled' });
  });

  it('执行中暂停（工作流返回 paused）：步骤回滚 pending 且部分用量累加到批次账本', async () => {
    const contexts: Record<string, ChapterContextData> = {
      [CH1_ID]: createContext(CH1_ID, '第1章'),
      [CH2_ID]: createContext(CH2_ID, '第2章'),
    };
    const fake = createFakeStore({
      run: createRun({ status: 'running' }),
      steps: [createStep(0), createStep(1)],
      contexts,
    });
    const runtime = createRuntime(async (input, hooks) => {
      await hooks.onStageChange?.('writing');
      fake.run.pauseRequested = true;
      const decision = await hooks.shouldStop?.();
      expect(decision).toBe('pause');
      return createResult(input, {
        stoppedReason: 'paused',
        contentText: null,
        plannedOutline: null,
        extractedSummary: null,
        outputWordCount: 0,
        inputTokens: 40,
        outputTokens: 60,
        estimatedCostUsd: 0.004,
      });
    });
    const collector = createEventCollector();
    const { processor } = createProcessor(fake.store, runtime, collector.publishEvent);

    const result = await processor(CONTEXT);

    expect(result.status).toBe('paused');
    expect(fake.persistCalls).toHaveLength(0);
    expect(fake.steps[0]?.status).toBe('pending');
    expect(fake.steps[0]?.stage).toBe('idle');
    expect(fake.run.pauseReason).toBe('USER_PAUSED');
    // 已产生的部分费用绝不漏算
    expect(fake.run.spentCostUsd).toBeCloseTo(0.004, 6);
    expect(fake.run.totalInputTokens).toBe(40);
    expect(fake.run.totalOutputTokens).toBe(60);
    expect(collector.events.at(-1)).toMatchObject({
      type: 'workflow.paused',
      pauseReason: 'USER_PAUSED',
    });
  });

  it('单步上游异常：错误脱敏（绝不含明文 apiKey），保留前序已完成章节', async () => {
    const contexts: Record<string, ChapterContextData> = {
      [CH1_ID]: createContext(CH1_ID, '第1章'),
      [CH2_ID]: createContext(CH2_ID, '第2章'),
    };
    const fake = createFakeStore({
      run: createRun(),
      steps: [createStep(0), createStep(1)],
      contexts,
    });
    const runtime = createRuntime(async (input) => {
      if (input.chapter.id === CH2_ID) {
        throw new ModelGatewayError(
          `401 Unauthorized: invalid api key ${API_KEY} for upstream.`,
          { category: 'PROVIDER_AUTH_ERROR', statusCode: 401 },
        );
      }
      return createResult(input);
    });
    const collector = createEventCollector();
    const { processor } = createProcessor(fake.store, runtime, collector.publishEvent);

    const result = await processor(CONTEXT);

    expect(result.status).toBe('failed');
    expect(result.processedSteps).toBe(1);
    expect(result.completedSteps).toBe(1);
    expect(result.failedSteps).toBe(1);

    // 前序章节成果完整保留
    expect(fake.persistCalls).toHaveLength(1);
    expect(fake.steps[0]?.status).toBe('completed');
    expect(fake.steps[1]?.status).toBe('failed');

    // 错误码 / 错误摘要均脱敏
    expect(fake.run.errorCode).toBe(API_ERROR_CODES.UPSTREAM_AUTH_ERROR);
    expect(fake.run.errorMessage).toContain('[REDACTED]');
    expect(fake.run.errorMessage).not.toContain(API_KEY);

    const failedEvent = collector.events.at(-1);
    expect(failedEvent).toMatchObject({
      type: 'workflow.failed',
      status: 'failed',
      errorCode: API_ERROR_CODES.UPSTREAM_AUTH_ERROR,
      completedSteps: 1,
      failedSteps: 1,
    });
    expect(failedEvent?.errorMessage).not.toContain(API_KEY);
    expect(JSON.stringify(collector.events)).not.toContain(API_KEY);
    expect(JSON.stringify(fake.persistCalls)).not.toContain(API_KEY);
  });

  it('批次已处于终态（completed / cancelled）时安全返回，不再推进', async () => {
    const contexts: Record<string, ChapterContextData> = {
      [CH1_ID]: createContext(CH1_ID, '第1章'),
    };
    const fake = createFakeStore({
      run: createRun({ status: 'completed', completedSteps: 2 }),
      steps: [
        createStep(0, { status: 'completed' }),
        createStep(1, { status: 'completed' }),
      ],
      contexts,
    });
    const runtime = createRuntime(async (input) => createResult(input));
    const collector = createEventCollector();
    const { processor } = createProcessor(fake.store, runtime, collector.publishEvent);

    const result = await processor(CONTEXT);

    expect(result.status).toBe('completed');
    expect(result.processedSteps).toBe(0);
    expect(runtime.calls).toHaveLength(0);
    expect(collector.events).toHaveLength(0);
  });

  it('任务负载非法时抛出脱敏的 VALIDATION_ERROR', async () => {
    const fake = createFakeStore({
      run: createRun(),
      steps: [createStep(0)],
      contexts: {},
    });
    const runtime = createRuntime(async (input) => createResult(input));
    const collector = createEventCollector();
    const { processor } = createProcessor(fake.store, runtime, collector.publishEvent);

    await expect(processor({ ...CONTEXT, data: { runId: 'not-a-uuid' } })).rejects.toMatchObject({
      code: API_ERROR_CODES.VALIDATION_ERROR,
    });
  });
});
