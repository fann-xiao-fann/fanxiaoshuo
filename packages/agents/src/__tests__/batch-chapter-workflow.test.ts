import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { AgentRole, WorkflowRunConfig, WorkflowStepStage } from '@fanxiaoshuo/shared';
import {
  BATCH_CHAPTER_WORKFLOW_ID,
  BudgetExceededError,
  ModelGateway,
  createFanXiaoshuoRuntime,
  type BatchChapterWorkflowHooks,
  type BatchChapterWorkflowInput,
  type BatchChapterWorkflowStageMeta,
  type ResolvedModelConfig,
  type UsageLogRecordInput,
  type WorkflowRoleModelInput,
} from '../index.js';

/* -------------------------------------------------------------------------- */
/*                                   测试基线                                  */
/* -------------------------------------------------------------------------- */

const BASE_CONFIG: ResolvedModelConfig = {
  providerId: '33333333-3333-4333-8333-333333333333',
  providerName: 'mock-provider',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-batch-chapter-secret-abcdef',
  modelId: 'mock-model',
  displayName: 'Mock Model',
  inputPricePer1m: 0.15,
  outputPricePer1m: 0.6,
};

/** 单次 Mock 调用的 Token 用量（1000 in / 500 out → $0.00045）。 */
const CALL_INPUT_TOKENS = 1000;
const CALL_OUTPUT_TOKENS = 500;
const CALL_COST_USD = 0.00045;

const WORKFLOW_CONFIG: WorkflowRunConfig = {
  enableCritic: true,
  minPassScore: 75,
  maxReworkRounds: 2,
  enableSummary: true,
  maxContextTokens: 4_000,
  instruction: '',
};

const ROLE_MODEL: WorkflowRoleModelInput = {
  config: BASE_CONFIG,
  temperature: 0.7,
  maxOutputTokens: 4_096,
};

const FIRST_REVIEW_JSON = JSON.stringify({
  score: 60,
  passed: false,
  summary: '开场铺垫过长，人物口吻漂移',
  issues: ['前两段铺垫过长', '沈青梧说话太跳脱'],
  reworkGuidance: '压缩开场并把两处台词改成克制语气',
});

const SECOND_REVIEW_JSON = JSON.stringify({
  score: 88,
  passed: true,
  summary: '修改到位，钩子有效',
  issues: [],
  reworkGuidance: '',
});

const SUMMARY_JSON = JSON.stringify({
  summary: '沈青梧上山问剑，败于内门师兄之手，却悟出断剑第二式。',
  keyEvents: ['上山问剑', '败于内门师兄', '悟出断剑第二式'],
  charactersPresent: ['沈青梧'],
});

const OUTLINE_JSON = JSON.stringify({
  outline:
    '核心目标：沈青梧上山问剑并遭遇第一次败北\n主要冲突：内门师兄以境界压人\n推进节拍：上山 → 交锋 → 败北 → 悟招\n章末钩子：断剑在夜里自行鸣响',
});

/** 按调用顺序返回预设文本的 Mock 模型。 */
function createScriptedModel(texts: readonly string[]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doGenerate: async () => {
      const text = texts[Math.min(index, texts.length - 1)] ?? '';
      index += 1;
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop', raw: 'stop' } as const,
        usage: {
          inputTokens: {
            total: CALL_INPUT_TOKENS,
            noCache: CALL_INPUT_TOKENS,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: { total: CALL_OUTPUT_TOKENS, text: CALL_OUTPUT_TOKENS, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

interface MockModels {
  readonly showrunner?: MockLanguageModelV4;
  readonly writer?: MockLanguageModelV4;
  readonly critic?: MockLanguageModelV4;
  readonly lorekeeper?: MockLanguageModelV4;
}

interface Harness {
  readonly runtime: ReturnType<typeof createFanXiaoshuoRuntime>;
  readonly records: UsageLogRecordInput[];
}

function createHarness(): Harness {
  const records: UsageLogRecordInput[] = [];

  const gateway = new ModelGateway({
    usageLogger: (record) => {
      records.push(record);
    },
    createLanguageModel: () => {
      throw new Error('测试不应直接构造上游模型：请通过 languageModelOverrides 注入 Mock 模型');
    },
  });

  // 用钩子统一注入 Mock 模型，避免每个用例重复拼装。
  const runtime = createFanXiaoshuoRuntime({ gateway });
  return { runtime, records };
}

function withOverrides(
  hooks: BatchChapterWorkflowHooks,
  models: MockModels,
): BatchChapterWorkflowHooks {
  const overrides: Partial<Record<AgentRole, MockLanguageModelV4>> = {};
  for (const [role, model] of Object.entries(models)) {
    if (model) overrides[role as AgentRole] = model;
  }
  return { ...hooks, languageModelOverrides: overrides };
}

function buildInput(
  mode: BatchChapterWorkflowInput['mode'],
  overrides: Partial<BatchChapterWorkflowInput> = {},
): BatchChapterWorkflowInput {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    mode,
    book: { title: '断剑问天', genre: '东方玄幻', targetChapterWords: 2_000 },
    bookOutline: {
      mainPlot: '少年持断剑北上问道',
      worldSetting: '九州灵气衰微',
      styleGuide: '冷峻克制',
      endingPlan: '剑归九州',
    },
    cards: [],
    recentSummaries: [],
    prevChapter: null,
    chapter: {
      id: '22222222-2222-4222-8222-222222222222',
      title: '第二章 问剑',
      contentText: '',
      outline: '旧细纲：上山问剑',
    },
    config: WORKFLOW_CONFIG,
    models: {
      showrunner: ROLE_MODEL,
      writer: ROLE_MODEL,
      critic: ROLE_MODEL,
      lorekeeper: ROLE_MODEL,
    },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*                                    用例                                     */
/* -------------------------------------------------------------------------- */

describe(`Mastra 单章批量工作流（${BATCH_CHAPTER_WORKFLOW_ID}）`, () => {
  it('outline_only 仅执行 showrunner 拆细纲，不写作、不审稿、不提炼摘要', async () => {
    const showrunner = createScriptedModel([OUTLINE_JSON]);
    const { runtime, records } = createHarness();

    const stages: WorkflowStepStage[] = [];
    const result = await runtime.runBatchChapterWorkflow(
      buildInput('outline_only'),
      withOverrides(
        {
          onStageChange: (stage) => {
            stages.push(stage);
          },
        },
        { showrunner },
      ),
    );

    expect(result.workflowId).toBe(BATCH_CHAPTER_WORKFLOW_ID);
    expect(result.mastraRunId.length).toBeGreaterThan(0);
    expect(result.stoppedReason).toBeNull();
    expect(result.plannedOutline).toContain('核心目标：沈青梧上山问剑');
    expect(result.contentText).toBeNull();
    expect(result.outputWordCount).toBe(0);
    expect(result.reworkCount).toBe(0);
    expect(result.criticReview).toBeNull();
    expect(result.extractedSummary).toBeNull();
    expect(result.inputTokens).toBe(CALL_INPUT_TOKENS);
    expect(result.outputTokens).toBe(CALL_OUTPUT_TOKENS);
    expect(result.estimatedCostUsd).toBeCloseTo(CALL_COST_USD, 8);

    expect(stages).toEqual(['planning', 'done']);
    expect(showrunner.doGenerateCalls).toHaveLength(1);
    expect(records.map((record) => record.scene)).toEqual(['outline-plan']);
    expect(records[0]?.role).toBe('showrunner');
  });

  it('full_pipeline 串起细纲→成文→审稿不通过→返工 1 轮→复审通过→摘要提炼', async () => {
    const showrunner = createScriptedModel([OUTLINE_JSON]);
    const writer = createScriptedModel([
      '初稿：沈青梧提剑上山，山风灌满衣袖。',
      '修订稿：沈青梧提剑上山，只说了三个字——「我来问剑。」',
    ]);
    const critic = createScriptedModel([FIRST_REVIEW_JSON, SECOND_REVIEW_JSON]);
    const lorekeeper = createScriptedModel([SUMMARY_JSON]);
    const { runtime, records } = createHarness();

    const stages: WorkflowStepStage[] = [];
    const stageMetas: (BatchChapterWorkflowStageMeta | undefined)[] = [];

    const result = await runtime.runBatchChapterWorkflow(
      buildInput('full_pipeline'),
      withOverrides(
        {
          onStageChange: (stage, meta) => {
            stages.push(stage);
            stageMetas.push(meta);
          },
        },
        { showrunner, writer, critic, lorekeeper },
      ),
    );

    // 阶段顺序完整覆盖规划 / 成文 / 审稿 / 返工 / 复审 / 摘要 / 完成
    expect(stages).toEqual([
      'planning',
      'writing',
      'reviewing',
      'reworking',
      'reviewing',
      'summarizing',
      'done',
    ]);
    const reworkMetaIndex = stages.indexOf('reworking');
    expect(stageMetas[reworkMetaIndex]).toEqual({ reworkCount: 1, criticScore: 60 });

    expect(result.stoppedReason).toBeNull();
    expect(result.reworkCount).toBe(1);
    expect(result.criticReview).toEqual({
      score: 88,
      passed: true,
      summary: '修改到位，钩子有效',
      issues: [],
      reworkGuidance: '',
    });
    expect(result.contentText).toContain('我来问剑');
    expect(result.outputWordCount).toBeGreaterThan(0);
    expect(result.extractedSummary).toEqual({
      summary: '沈青梧上山问剑，败于内门师兄之手，却悟出断剑第二式。',
      keyEvents: ['上山问剑', '败于内门师兄', '悟出断剑第二式'],
      charactersPresent: ['沈青梧'],
    });
    expect(result.plannedOutline).toContain('章末钩子：断剑在夜里自行鸣响');

    // Token 与费用精确累加：共 6 次调用（细纲 1 + 初稿 1 + 审稿 2 + 返工 1 + 摘要 1）
    expect(showrunner.doGenerateCalls).toHaveLength(1);
    expect(writer.doGenerateCalls).toHaveLength(2);
    expect(critic.doGenerateCalls).toHaveLength(2);
    expect(lorekeeper.doGenerateCalls).toHaveLength(1);
    expect(result.inputTokens).toBe(CALL_INPUT_TOKENS * 6);
    expect(result.outputTokens).toBe(CALL_OUTPUT_TOKENS * 6);
    expect(result.estimatedCostUsd).toBeCloseTo(CALL_COST_USD * 6, 8);

    expect(records.map((record) => record.scene)).toEqual([
      'outline-plan',
      'chapter-write',
      'chapter-review',
      'chapter-write',
      'chapter-review',
      'lore-extract',
    ]);
    expect(records.map((record) => record.role)).toEqual([
      'showrunner',
      'writer',
      'critic',
      'writer',
      'critic',
      'lorekeeper',
    ]);
  });

  it('累计费用触及 maxCostUsd 时抛出 BudgetExceededError（不被包成 INTERNAL_ERROR）', async () => {
    const showrunner = createScriptedModel([OUTLINE_JSON]);
    const writer = createScriptedModel(['初稿正文']);
    const { runtime } = createHarness();

    const input = buildInput('full_pipeline', {
      budget: { maxCostUsd: 0.0001, spentCostUsd: 0 },
    });

    let caught: unknown;
    try {
      await runtime.runBatchChapterWorkflow(
        input,
        withOverrides({}, { showrunner, writer }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BudgetExceededError);
    const budgetError = caught as BudgetExceededError;
    expect(budgetError.code).toBe('BUDGET_EXCEEDED');
    expect(budgetError.runId).toBe(input.runId);
    expect(budgetError.maxCostUsd).toBe(0.0001);
    expect(budgetError.spentCostUsd).toBeCloseTo(CALL_COST_USD, 8);
    // 第一次细纲调用成功，第二次（写作）调用前被熔断，绝不产生第三次调用。
    expect(showrunner.doGenerateCalls).toHaveLength(1);
    expect(writer.doGenerateCalls).toHaveLength(0);
  });

  it('shouldStop 返回 pause 时安全提前返回 paused，不发起任何模型调用', async () => {
    const showrunner = createScriptedModel([OUTLINE_JSON]);
    const { runtime, records } = createHarness();

    const stages: WorkflowStepStage[] = [];
    const result = await runtime.runBatchChapterWorkflow(
      buildInput('full_pipeline'),
      withOverrides(
        {
          shouldStop: () => 'pause',
          onStageChange: (stage) => {
            stages.push(stage);
          },
        },
        { showrunner },
      ),
    );

    expect(result.stoppedReason).toBe('paused');
    expect(result.contentText).toBeNull();
    expect(result.plannedOutline).toBeNull();
    expect(result.reworkCount).toBe(0);
    expect(result.criticReview).toBeNull();
    expect(result.extractedSummary).toBeNull();
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.estimatedCostUsd).toBe(0);

    expect(stages).toEqual([]);
    expect(showrunner.doGenerateCalls).toHaveLength(0);
    expect(records).toHaveLength(0);
  });
});
