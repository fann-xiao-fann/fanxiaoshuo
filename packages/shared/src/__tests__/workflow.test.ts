import { describe, expect, it } from 'vitest';
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
  WORKFLOW_EVENT_TYPES,
  WORKFLOW_MODES,
  WORKFLOW_MODE_LABELS,
  WORKFLOW_PAUSE_REASONS,
  WORKFLOW_PAUSE_REASON_LABELS,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_RUN_STATUS_LABELS,
  WORKFLOW_SSE_EVENT_NAMES,
  WORKFLOW_STATUS_TO_EVENT_TYPE,
  WORKFLOW_STEP_STAGES,
  WORKFLOW_STEP_STATUSES,
  WORKFLOW_STEP_STATUS_LABELS,
  WORKFLOW_STEP_STAGE_LABELS,
  WORKFLOW_TERMINAL_STATUSES,
  isWorkflowTerminalStatus,
  workflowEventTypeSchema,
  workflowModeSchema,
  workflowPauseReasonSchema,
  workflowRunStatusSchema,
  workflowStepStageSchema,
  workflowStepStatusSchema,
} from '../constants/workflows.js';
import {
  autoCreateChaptersConfigSchema,
  createWorkflowRunSchema,
  resumeWorkflowRunSchema,
  workflowEventSchema,
  workflowJobPayloadSchema,
  workflowRunConfigSchema,
  workflowRunDetailDtoSchema,
  workflowRunListQuerySchema,
  workflowRunListResponseSchema,
  workflowRunSummaryDtoSchema,
  workflowStepDtoSchema,
} from '../schemas/workflow.js';

const TS = '2025-06-07T08:09:10.000Z';
const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const STEP_ID = '33333333-3333-4333-8333-333333333333';
const CHAPTER_ID = '44444444-4444-4444-8444-444444444444';
const CHAPTER_ID_2 = '55555555-5555-4555-8555-555555555555';
const VOLUME_ID = '66666666-6666-4666-8666-666666666666';

const stepFixture = {
  id: STEP_ID,
  runId: RUN_ID,
  chapterId: CHAPTER_ID,
  stepIndex: 0,
  chapterTitleSnapshot: '第1章 初入宗门',
  status: 'completed',
  stage: 'done',
  reworkCount: 1,
  criticScore: 82,
  criticPassed: true,
  criticSummary: '节奏稳健，人物口吻统一',
  criticIssues: ['章末钩子略弱'],
  outputWordCount: 3120,
  inputTokens: 4200,
  outputTokens: 3800,
  estimatedCostUsd: 0.0123,
  backupRevisionId: null,
  errorCode: null,
  errorMessage: null,
  startedAt: TS,
  finishedAt: TS,
  createdAt: TS,
  updatedAt: TS,
};

const summaryFixture = {
  id: RUN_ID,
  bookId: BOOK_ID,
  bookTitle: '凡人问道录',
  mode: 'full_pipeline',
  status: 'running',
  config: {},
  totalSteps: 3,
  completedSteps: 1,
  failedSteps: 0,
  maxCostUsd: 5,
  spentCostUsd: 0.0123,
  totalInputTokens: 4200,
  totalOutputTokens: 3800,
  pauseRequested: false,
  cancelRequested: false,
  pauseReason: null,
  errorCode: null,
  errorMessage: null,
  startedAt: TS,
  finishedAt: null,
  createdAt: TS,
  updatedAt: TS,
};

describe('Change 4 批量流水线领域常量', () => {
  it('运行模式共 3 种且中文展示名完整', () => {
    expect(WORKFLOW_MODES).toEqual(['outline_only', 'write_chapters', 'full_pipeline']);
    expect(Object.keys(WORKFLOW_MODE_LABELS)).toHaveLength(WORKFLOW_MODES.length);
    expect(WORKFLOW_MODE_LABELS.outline_only).toBe('仅拆细纲');
    expect(WORKFLOW_MODE_LABELS.write_chapters).toBe('批量成文');
    expect(WORKFLOW_MODE_LABELS.full_pipeline).toBe('全链路生产');

    for (const mode of WORKFLOW_MODES) {
      expect(workflowModeSchema.safeParse(mode).success).toBe(true);
    }
    expect(workflowModeSchema.safeParse('rewrite_all').success).toBe(false);
  });

  it('运行状态共 6 种且中文展示名完整', () => {
    expect(WORKFLOW_RUN_STATUSES).toEqual([
      'queued',
      'running',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(Object.keys(WORKFLOW_RUN_STATUS_LABELS)).toHaveLength(WORKFLOW_RUN_STATUSES.length);
    expect(WORKFLOW_RUN_STATUS_LABELS.queued).toBe('排队中');
    expect(WORKFLOW_RUN_STATUS_LABELS.running).toBe('运行中');
    expect(WORKFLOW_RUN_STATUS_LABELS.paused).toBe('已暂停');
    expect(WORKFLOW_RUN_STATUS_LABELS.completed).toBe('已完成');
    expect(WORKFLOW_RUN_STATUS_LABELS.failed).toBe('已失败');
    expect(WORKFLOW_RUN_STATUS_LABELS.cancelled).toBe('已取消');

    for (const status of WORKFLOW_RUN_STATUSES) {
      expect(workflowRunStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(workflowRunStatusSchema.safeParse('waiting').success).toBe(false);
  });

  it('终态判定仅覆盖 completed / failed / cancelled', () => {
    expect(WORKFLOW_TERMINAL_STATUSES).toEqual(['completed', 'failed', 'cancelled']);
    expect(WORKFLOW_RUN_STATUSES.filter((status) => isWorkflowTerminalStatus(status))).toEqual([
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(isWorkflowTerminalStatus('queued')).toBe(false);
    expect(isWorkflowTerminalStatus('running')).toBe(false);
    expect(isWorkflowTerminalStatus('paused')).toBe(false);
  });

  it('步骤状态共 5 种且中文展示名完整', () => {
    expect(WORKFLOW_STEP_STATUSES).toEqual([
      'pending',
      'running',
      'completed',
      'failed',
      'skipped',
    ]);
    expect(Object.keys(WORKFLOW_STEP_STATUS_LABELS)).toHaveLength(WORKFLOW_STEP_STATUSES.length);
    expect(WORKFLOW_STEP_STATUS_LABELS.pending).toBe('待执行');
    expect(WORKFLOW_STEP_STATUS_LABELS.running).toBe('执行中');
    expect(WORKFLOW_STEP_STATUS_LABELS.completed).toBe('已完成');
    expect(WORKFLOW_STEP_STATUS_LABELS.failed).toBe('失败');
    expect(WORKFLOW_STEP_STATUS_LABELS.skipped).toBe('已跳过');

    for (const status of WORKFLOW_STEP_STATUSES) {
      expect(workflowStepStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(workflowStepStatusSchema.safeParse('reworking').success).toBe(false);
  });

  it('步骤阶段共 7 种且中文展示名完整', () => {
    expect(WORKFLOW_STEP_STAGES).toEqual([
      'idle',
      'planning',
      'writing',
      'reviewing',
      'reworking',
      'summarizing',
      'done',
    ]);
    expect(Object.keys(WORKFLOW_STEP_STAGE_LABELS)).toHaveLength(WORKFLOW_STEP_STAGES.length);
    expect(WORKFLOW_STEP_STAGE_LABELS.planning).toBe('规划细纲');
    expect(WORKFLOW_STEP_STAGE_LABELS.writing).toBe('撰写正文');
    expect(WORKFLOW_STEP_STAGE_LABELS.reviewing).toBe('审稿质检');
    expect(WORKFLOW_STEP_STAGE_LABELS.reworking).toBe('按意见返工');
    expect(WORKFLOW_STEP_STAGE_LABELS.summarizing).toBe('提炼摘要');

    for (const stage of WORKFLOW_STEP_STAGES) {
      expect(workflowStepStageSchema.safeParse(stage).success).toBe(true);
    }
    expect(workflowStepStageSchema.safeParse('cancelled').success).toBe(false);
  });

  it('暂停原因共 2 种且中文展示名完整', () => {
    expect(WORKFLOW_PAUSE_REASONS).toEqual(['USER_PAUSED', 'BUDGET_EXCEEDED']);
    expect(Object.keys(WORKFLOW_PAUSE_REASON_LABELS)).toHaveLength(WORKFLOW_PAUSE_REASONS.length);
    expect(WORKFLOW_PAUSE_REASON_LABELS.USER_PAUSED).toBe('手动暂停');
    expect(WORKFLOW_PAUSE_REASON_LABELS.BUDGET_EXCEEDED).toBe('触及预算上限');

    for (const reason of WORKFLOW_PAUSE_REASONS) {
      expect(workflowPauseReasonSchema.safeParse(reason).success).toBe(true);
    }
    expect(workflowPauseReasonSchema.safeParse('USER_CANCELLED').success).toBe(false);
  });

  it('事件类型共 7 种且与批次状态映射自洽', () => {
    expect(WORKFLOW_EVENT_TYPES).toEqual([
      'workflow.queued',
      'workflow.running',
      'workflow.step_updated',
      'workflow.paused',
      'workflow.completed',
      'workflow.failed',
      'workflow.cancelled',
    ]);

    for (const type of WORKFLOW_EVENT_TYPES) {
      expect(workflowEventTypeSchema.safeParse(type).success).toBe(true);
    }
    expect(workflowEventTypeSchema.safeParse('workflow.retried').success).toBe(false);

    // 每个批次状态都能映射到合法事件类型（步骤级事件不在映射内）
    for (const status of WORKFLOW_RUN_STATUSES) {
      const type = WORKFLOW_STATUS_TO_EVENT_TYPE[status];
      expect(WORKFLOW_EVENT_TYPES).toContain(type);
      expect(workflowEventTypeSchema.safeParse(type).success).toBe(true);
    }
    expect(Object.values(WORKFLOW_STATUS_TO_EVENT_TYPE)).not.toContain('workflow.step_updated');
  });

  it('SSE 帧名与设计文档一致', () => {
    expect(WORKFLOW_SSE_EVENT_NAMES.ready).toBe('ready');
    expect(WORKFLOW_SSE_EVENT_NAMES.workflowEvent).toBe('workflow-event');
    expect(WORKFLOW_SSE_EVENT_NAMES.ping).toBe('ping');
  });

  it('预算 / 返工 / 章节数常量与设计文档一致', () => {
    expect(DEFAULT_WORKFLOW_MIN_PASS_SCORE).toBe(75);
    expect(DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS).toBe(1);
    expect(MAX_WORKFLOW_REWORK_ROUNDS).toBe(3);
    expect(DEFAULT_WORKFLOW_MAX_COST_USD).toBe(5);
    expect(MIN_WORKFLOW_MAX_COST_USD).toBe(0.0001);
    expect(MAX_WORKFLOW_MAX_COST_USD).toBe(500);
    expect(MAX_WORKFLOW_CHAPTERS_PER_RUN).toBe(50);

    expect(DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS).toBeLessThanOrEqual(MAX_WORKFLOW_REWORK_ROUNDS);
    expect(MIN_WORKFLOW_MAX_COST_USD).toBeLessThanOrEqual(DEFAULT_WORKFLOW_MAX_COST_USD);
    expect(DEFAULT_WORKFLOW_MAX_COST_USD).toBeLessThanOrEqual(MAX_WORKFLOW_MAX_COST_USD);
  });
});

describe('autoCreateChaptersConfigSchema', () => {
  it('默认不指定分卷且标题前缀为「第」', () => {
    const parsed = autoCreateChaptersConfigSchema.parse({ count: 3 });
    expect(parsed.volumeId).toBeNull();
    expect(parsed.titlePrefix).toBe('第');
    expect(parsed.count).toBe(3);
  });

  it('接受指定分卷并裁剪标题前缀空白', () => {
    const parsed = autoCreateChaptersConfigSchema.parse({
      volumeId: VOLUME_ID,
      count: 1,
      titlePrefix: '  卷一·第  ',
    });
    expect(parsed.volumeId).toBe(VOLUME_ID);
    expect(parsed.titlePrefix).toBe('卷一·第');
  });

  it('拒绝越界数量、超长前缀与未知字段', () => {
    expect(autoCreateChaptersConfigSchema.safeParse({ count: 0 }).success).toBe(false);
    expect(autoCreateChaptersConfigSchema.safeParse({ count: 1.5 }).success).toBe(false);
    expect(
      autoCreateChaptersConfigSchema.safeParse({ count: MAX_WORKFLOW_CHAPTERS_PER_RUN + 1 }).success,
    ).toBe(false);
    expect(
      autoCreateChaptersConfigSchema.safeParse({ count: MAX_WORKFLOW_CHAPTERS_PER_RUN }).success,
    ).toBe(true);
    expect(
      autoCreateChaptersConfigSchema.safeParse({ count: 1, titlePrefix: 'x'.repeat(61) }).success,
    ).toBe(false);
    expect(
      autoCreateChaptersConfigSchema.safeParse({ count: 1, volumeId: 'not-a-uuid' }).success,
    ).toBe(false);
    expect(autoCreateChaptersConfigSchema.safeParse({ count: 1, extra: true }).success).toBe(false);
  });
});

describe('workflowRunConfigSchema', () => {
  it('空对象即可得到完整默认配置', () => {
    const parsed = workflowRunConfigSchema.parse({});
    expect(parsed.enableCritic).toBe(true);
    expect(parsed.minPassScore).toBe(DEFAULT_WORKFLOW_MIN_PASS_SCORE);
    expect(parsed.maxReworkRounds).toBe(DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS);
    expect(parsed.enableSummary).toBe(true);
    expect(parsed.targetWords).toBeUndefined();
    expect(parsed.maxContextTokens).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
    expect(parsed.instruction).toBe('');
  });

  it('接受自定义配置并裁剪指令空白', () => {
    const parsed = workflowRunConfigSchema.parse({
      enableCritic: false,
      minPassScore: 60,
      maxReworkRounds: MAX_WORKFLOW_REWORK_ROUNDS,
      enableSummary: false,
      targetWords: 3500,
      maxContextTokens: MIN_MAX_CONTEXT_TOKENS,
      instruction: '  保持冷峻克制的中文网文语感  ',
    });
    expect(parsed.enableCritic).toBe(false);
    expect(parsed.enableSummary).toBe(false);
    expect(parsed.maxReworkRounds).toBe(MAX_WORKFLOW_REWORK_ROUNDS);
    expect(parsed.targetWords).toBe(3500);
    expect(parsed.maxContextTokens).toBe(MIN_MAX_CONTEXT_TOKENS);
    expect(parsed.instruction).toBe('保持冷峻克制的中文网文语感');
  });

  it('拒绝越界的审稿分与返工轮数', () => {
    expect(workflowRunConfigSchema.safeParse({ minPassScore: 0 }).success).toBe(false);
    expect(workflowRunConfigSchema.safeParse({ minPassScore: 101 }).success).toBe(false);
    expect(workflowRunConfigSchema.safeParse({ minPassScore: 100 }).success).toBe(true);
    expect(workflowRunConfigSchema.safeParse({ maxReworkRounds: -1 }).success).toBe(false);
    expect(
      workflowRunConfigSchema.safeParse({ maxReworkRounds: MAX_WORKFLOW_REWORK_ROUNDS + 1 }).success,
    ).toBe(false);
    expect(workflowRunConfigSchema.safeParse({ maxReworkRounds: 0 }).success).toBe(true);
  });

  it('拒绝越界的目标字数与上下文预算', () => {
    expect(workflowRunConfigSchema.safeParse({ targetWords: 99 }).success).toBe(false);
    expect(workflowRunConfigSchema.safeParse({ targetWords: 100 }).success).toBe(true);
    expect(workflowRunConfigSchema.safeParse({ targetWords: 10_001 }).success).toBe(false);
    expect(
      workflowRunConfigSchema.safeParse({ maxContextTokens: MIN_MAX_CONTEXT_TOKENS - 1 }).success,
    ).toBe(false);
    expect(
      workflowRunConfigSchema.safeParse({ maxContextTokens: MAX_MAX_CONTEXT_TOKENS + 1 }).success,
    ).toBe(false);
    expect(
      workflowRunConfigSchema.safeParse({ maxContextTokens: MAX_MAX_CONTEXT_TOKENS }).success,
    ).toBe(true);
    expect(
      workflowRunConfigSchema.safeParse({ instruction: 'x'.repeat(MAX_AI_INSTRUCTION_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it('拒绝未知字段（strictObject 防止契约漂移）', () => {
    expect(workflowRunConfigSchema.safeParse({ enableCritic: true, extra: 1 }).success).toBe(false);
  });
});

describe('createWorkflowRunSchema', () => {
  it('勾选已有章节时套用全部默认值', () => {
    const parsed = createWorkflowRunSchema.parse({
      bookId: BOOK_ID,
      mode: 'write_chapters',
      chapterIds: [CHAPTER_ID, CHAPTER_ID_2],
    });

    expect(parsed.bookId).toBe(BOOK_ID);
    expect(parsed.mode).toBe('write_chapters');
    expect(parsed.chapterIds).toEqual([CHAPTER_ID, CHAPTER_ID_2]);
    expect(parsed.autoCreateChapters).toBeUndefined();
    expect(parsed.maxCostUsd).toBe(DEFAULT_WORKFLOW_MAX_COST_USD);
    expect(parsed.enableCritic).toBe(true);
    expect(parsed.minPassScore).toBe(DEFAULT_WORKFLOW_MIN_PASS_SCORE);
    expect(parsed.maxReworkRounds).toBe(DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS);
    expect(parsed.enableSummary).toBe(true);
    expect(parsed.maxContextTokens).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
    expect(parsed.instruction).toBe('');
  });

  it('自动建章时套用嵌套默认值', () => {
    const parsed = createWorkflowRunSchema.parse({
      bookId: BOOK_ID,
      mode: 'outline_only',
      autoCreateChapters: { count: 2 },
      maxCostUsd: null,
    });

    expect(parsed.chapterIds).toBeUndefined();
    expect(parsed.autoCreateChapters).toEqual({
      volumeId: null,
      count: 2,
      titlePrefix: '第',
    });
    expect(parsed.maxCostUsd).toBeNull();
  });

  it('chapterIds 与 autoCreateChapters 必须且只能二选一', () => {
    const both = createWorkflowRunSchema.safeParse({
      bookId: BOOK_ID,
      mode: 'full_pipeline',
      chapterIds: [CHAPTER_ID],
      autoCreateChapters: { count: 1 },
    });
    expect(both.success).toBe(false);

    const neither = createWorkflowRunSchema.safeParse({
      bookId: BOOK_ID,
      mode: 'full_pipeline',
    });
    expect(neither.success).toBe(false);
    if (!neither.success) {
      expect(neither.error.issues.some((issue) => issue.path.includes('chapterIds'))).toBe(true);
    }
  });

  it('chapterIds 不允许重复', () => {
    const duplicated = createWorkflowRunSchema.safeParse({
      bookId: BOOK_ID,
      mode: 'write_chapters',
      chapterIds: [CHAPTER_ID, CHAPTER_ID],
    });
    expect(duplicated.success).toBe(false);
    if (!duplicated.success) {
      const issue = duplicated.error.issues.find((item) => item.path[0] === 'chapterIds');
      expect(issue?.message).toContain('重复');
      expect(issue?.path).toEqual(['chapterIds', 1]);
    }
  });

  it('chapterIds 数量受 MAX_WORKFLOW_CHAPTERS_PER_RUN 约束', () => {
    const makeIds = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      );

    expect(
      createWorkflowRunSchema.safeParse({
        bookId: BOOK_ID,
        mode: 'write_chapters',
        chapterIds: makeIds(MAX_WORKFLOW_CHAPTERS_PER_RUN),
      }).success,
    ).toBe(true);
    expect(
      createWorkflowRunSchema.safeParse({
        bookId: BOOK_ID,
        mode: 'write_chapters',
        chapterIds: makeIds(MAX_WORKFLOW_CHAPTERS_PER_RUN + 1),
      }).success,
    ).toBe(false);
    expect(
      createWorkflowRunSchema.safeParse({
        bookId: BOOK_ID,
        mode: 'write_chapters',
        chapterIds: [],
      }).success,
    ).toBe(false);
  });

  it('预算上限边界与可空语义', () => {
    const base = { bookId: BOOK_ID, mode: 'write_chapters', chapterIds: [CHAPTER_ID] };

    expect(createWorkflowRunSchema.safeParse({ ...base, maxCostUsd: null }).success).toBe(true);
    expect(createWorkflowRunSchema.safeParse({ ...base, maxCostUsd: MIN_WORKFLOW_MAX_COST_USD }).success).toBe(
      true,
    );
    expect(createWorkflowRunSchema.safeParse({ ...base, maxCostUsd: MAX_WORKFLOW_MAX_COST_USD }).success).toBe(
      true,
    );
    expect(createWorkflowRunSchema.safeParse({ ...base, maxCostUsd: 0 }).success).toBe(false);
    expect(createWorkflowRunSchema.safeParse({ ...base, maxCostUsd: MAX_WORKFLOW_MAX_COST_USD + 1 }).success).toBe(
      false,
    );
    expect(createWorkflowRunSchema.safeParse({ ...base, maxCostUsd: '5' }).success).toBe(false);
  });

  it('拒绝未知模式、非法 UUID 与未知字段', () => {
    expect(
      createWorkflowRunSchema.safeParse({
        bookId: BOOK_ID,
        mode: 'auto',
        chapterIds: [CHAPTER_ID],
      }).success,
    ).toBe(false);
    expect(
      createWorkflowRunSchema.safeParse({
        bookId: 'book-1',
        mode: 'write_chapters',
        chapterIds: [CHAPTER_ID],
      }).success,
    ).toBe(false);
    expect(
      createWorkflowRunSchema.safeParse({
        bookId: BOOK_ID,
        mode: 'write_chapters',
        chapterIds: [CHAPTER_ID],
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('内联配置字段可覆盖默认值', () => {
    const parsed = createWorkflowRunSchema.parse({
      bookId: BOOK_ID,
      mode: 'full_pipeline',
      autoCreateChapters: { count: 1, volumeId: VOLUME_ID },
      enableCritic: false,
      minPassScore: 90,
      maxReworkRounds: 0,
      enableSummary: false,
      targetWords: 4000,
      maxContextTokens: 16_000,
      instruction: '多写对话',
    });

    expect(parsed.enableCritic).toBe(false);
    expect(parsed.minPassScore).toBe(90);
    expect(parsed.maxReworkRounds).toBe(0);
    expect(parsed.enableSummary).toBe(false);
    expect(parsed.targetWords).toBe(4000);
    expect(parsed.maxContextTokens).toBe(16_000);
    expect(parsed.instruction).toBe('多写对话');
  });
});

describe('resumeWorkflowRunSchema', () => {
  it('空对象表示保持原预算上限', () => {
    const parsed = resumeWorkflowRunSchema.parse({});
    expect(parsed.maxCostUsd).toBeUndefined();
  });

  it('支持上调预算与解除上限', () => {
    expect(resumeWorkflowRunSchema.parse({ maxCostUsd: 20 }).maxCostUsd).toBe(20);
    expect(resumeWorkflowRunSchema.parse({ maxCostUsd: null }).maxCostUsd).toBeNull();
    expect(
      resumeWorkflowRunSchema.safeParse({ maxCostUsd: MIN_WORKFLOW_MAX_COST_USD }).success,
    ).toBe(true);
  });

  it('拒绝越界预算与未知字段', () => {
    expect(resumeWorkflowRunSchema.safeParse({ maxCostUsd: 0 }).success).toBe(false);
    expect(
      resumeWorkflowRunSchema.safeParse({ maxCostUsd: MAX_WORKFLOW_MAX_COST_USD + 1 }).success,
    ).toBe(false);
    expect(resumeWorkflowRunSchema.safeParse({ budget: 10 }).success).toBe(false);
  });
});

describe('workflowStepDtoSchema', () => {
  it('接受完整步骤 DTO', () => {
    const parsed = workflowStepDtoSchema.parse(stepFixture);
    expect(parsed.id).toBe(STEP_ID);
    expect(parsed.status).toBe('completed');
    expect(parsed.stage).toBe('done');
    expect(parsed.criticPassed).toBe(true);
    expect(parsed.criticIssues).toEqual(['章末钩子略弱']);
  });

  it('拒绝未知字段与越界字段', () => {
    expect(workflowStepDtoSchema.safeParse({ ...stepFixture, extra: 1 }).success).toBe(false);
    expect(workflowStepDtoSchema.safeParse({ ...stepFixture, criticScore: 101 }).success).toBe(false);
    expect(workflowStepDtoSchema.safeParse({ ...stepFixture, criticScore: -1 }).success).toBe(false);
    expect(workflowStepDtoSchema.safeParse({ ...stepFixture, stepIndex: -1 }).success).toBe(false);
    expect(
      workflowStepDtoSchema.safeParse({ ...stepFixture, criticIssues: ['x'.repeat(501)] }).success,
    ).toBe(false);
    expect(
      workflowStepDtoSchema.safeParse({ ...stepFixture, chapterTitleSnapshot: '' }).success,
    ).toBe(false);
    expect(
      workflowStepDtoSchema.safeParse({ ...stepFixture, errorCode: 'WHATEVER' }).success,
    ).toBe(false);
  });

  it('允许未审稿 / 未写回的 null 字段', () => {
    const parsed = workflowStepDtoSchema.parse({
      ...stepFixture,
      status: 'pending',
      stage: 'idle',
      criticScore: null,
      criticPassed: null,
      criticSummary: null,
      criticIssues: [],
      backupRevisionId: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(parsed.criticScore).toBeNull();
    expect(parsed.criticPassed).toBeNull();
    expect(parsed.startedAt).toBeNull();
  });
});

describe('workflowRunSummaryDtoSchema / workflowRunDetailDtoSchema', () => {
  it('摘要 DTO 为缺失的配置字段补齐默认值', () => {
    const parsed = workflowRunSummaryDtoSchema.parse(summaryFixture);
    expect(parsed.config.enableCritic).toBe(true);
    expect(parsed.config.minPassScore).toBe(DEFAULT_WORKFLOW_MIN_PASS_SCORE);
    expect(parsed.config.maxReworkRounds).toBe(DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS);
    expect(parsed.config.enableSummary).toBe(true);
    expect(parsed.config.maxContextTokens).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
    expect(parsed.maxCostUsd).toBe(5);
    expect(parsed.pauseReason).toBeNull();
  });

  it('摘要 DTO 拒绝未知字段与越界计数', () => {
    expect(workflowRunSummaryDtoSchema.safeParse({ ...summaryFixture, extra: 1 }).success).toBe(false);
    expect(workflowRunSummaryDtoSchema.safeParse({ ...summaryFixture, totalSteps: -1 }).success).toBe(
      false,
    );
    expect(workflowRunSummaryDtoSchema.safeParse({ ...summaryFixture, bookTitle: '' }).success).toBe(
      false,
    );
    expect(
      workflowRunSummaryDtoSchema.safeParse({ ...summaryFixture, status: 'waiting' }).success,
    ).toBe(false);
    expect(
      workflowRunSummaryDtoSchema.safeParse({ ...summaryFixture, pauseReason: 'OTHER' }).success,
    ).toBe(false);
  });

  it('详情 DTO = 摘要字段 + 有序步骤列表', () => {
    const parsed = workflowRunDetailDtoSchema.parse({
      ...summaryFixture,
      steps: [stepFixture, { ...stepFixture, id: CHAPTER_ID_2, stepIndex: 1 }],
    });
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[1]?.stepIndex).toBe(1);
    expect(parsed.config.enableCritic).toBe(true);
  });

  it('详情 DTO 拒绝缺少 steps 或 steps 非数组', () => {
    expect(workflowRunDetailDtoSchema.safeParse(summaryFixture).success).toBe(false);
    expect(
      workflowRunDetailDtoSchema.safeParse({ ...summaryFixture, steps: 'nope' }).success,
    ).toBe(false);
  });
});

describe('workflowRunListQuerySchema', () => {
  it('空查询串套用分页默认值', () => {
    const parsed = workflowRunListQuerySchema.parse({});
    expect(parsed.page).toBe(PAGINATION.defaultPage);
    expect(parsed.pageSize).toBe(PAGINATION.defaultPageSize);
    expect(parsed.bookId).toBeUndefined();
    expect(parsed.status).toBeUndefined();
  });

  it('兼容 Fastify 的空字符串筛选参数', () => {
    const parsed = workflowRunListQuerySchema.parse({ bookId: '', status: '' });
    expect(parsed.bookId).toBeUndefined();
    expect(parsed.status).toBeUndefined();
    expect(parsed.page).toBe(PAGINATION.defaultPage);
  });

  it('兼容数字字符串分页参数', () => {
    const parsed = workflowRunListQuerySchema.parse({
      bookId: BOOK_ID,
      status: 'paused',
      page: '2',
      pageSize: '50',
    });
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(50);
    expect(parsed.status).toBe('paused');
    expect(parsed.bookId).toBe(BOOK_ID);
  });

  it('拒绝越界分页、非法状态与未知查询参数', () => {
    expect(workflowRunListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(workflowRunListQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(
      workflowRunListQuerySchema.safeParse({ pageSize: String(PAGINATION.maxPageSize) }).success,
    ).toBe(true);
    expect(workflowRunListQuerySchema.safeParse({ status: 'done' }).success).toBe(false);
    expect(workflowRunListQuerySchema.safeParse({ bookId: 'book-1' }).success).toBe(false);
    expect(workflowRunListQuerySchema.safeParse({ runId: RUN_ID }).success).toBe(false);
  });
});

describe('workflowRunListResponseSchema', () => {
  it('接受分页响应', () => {
    const parsed = workflowRunListResponseSchema.parse({
      items: [summaryFixture],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.total).toBe(1);
  });

  it('拒绝负 total 与非法分页', () => {
    expect(
      workflowRunListResponseSchema.safeParse({ items: [], total: -1, page: 1, pageSize: 20 })
        .success,
    ).toBe(false);
    expect(
      workflowRunListResponseSchema.safeParse({ items: [], total: 0, page: 0, pageSize: 20 }).success,
    ).toBe(false);
    expect(
      workflowRunListResponseSchema.safeParse({ items: [], total: 0, page: 1, pageSize: 0 }).success,
    ).toBe(false);
    expect(
      workflowRunListResponseSchema.safeParse({ items: [], total: 0, page: 1, pageSize: 20, extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe('workflowJobPayloadSchema', () => {
  it('仅承载 runId', () => {
    expect(workflowJobPayloadSchema.parse({ runId: RUN_ID }).runId).toBe(RUN_ID);
  });

  it('拒绝缺失 runId、非法 UUID 与冗余负载', () => {
    expect(workflowJobPayloadSchema.safeParse({}).success).toBe(false);
    expect(workflowJobPayloadSchema.safeParse({ runId: 'run-1' }).success).toBe(false);
    expect(workflowJobPayloadSchema.safeParse({ runId: RUN_ID, mode: 'write_chapters' }).success).toBe(
      false,
    );
  });
});

describe('workflowEventSchema', () => {
  const baseEvent = {
    type: 'workflow.running',
    runId: RUN_ID,
    bookId: BOOK_ID,
    status: 'running',
    timestamp: TS,
    totalSteps: 3,
    completedSteps: 1,
    failedSteps: 0,
    spentCostUsd: 0.0123,
    maxCostUsd: 5,
  };

  it('批次级事件为步骤字段补齐 null 默认值', () => {
    const parsed = workflowEventSchema.parse(baseEvent);
    expect(parsed.pauseReason).toBeNull();
    expect(parsed.stepId).toBeNull();
    expect(parsed.chapterId).toBeNull();
    expect(parsed.stepIndex).toBeNull();
    expect(parsed.stepStatus).toBeNull();
    expect(parsed.stepStage).toBeNull();
    expect(parsed.criticScore).toBeNull();
    expect(parsed.errorCode).toBeNull();
    expect(parsed.errorMessage).toBeNull();
  });

  it('步骤级事件填充步骤字段', () => {
    const parsed = workflowEventSchema.parse({
      ...baseEvent,
      type: 'workflow.step_updated',
      stepId: STEP_ID,
      chapterId: CHAPTER_ID,
      stepIndex: 0,
      stepStatus: 'running',
      stepStage: 'reviewing',
      criticScore: 68,
    });
    expect(parsed.type).toBe('workflow.step_updated');
    expect(parsed.stepId).toBe(STEP_ID);
    expect(parsed.stepStage).toBe('reviewing');
    expect(parsed.criticScore).toBe(68);
  });

  it('预算熔断暂停事件允许 maxCostUsd 为 null 并携带原因', () => {
    const parsed = workflowEventSchema.parse({
      ...baseEvent,
      type: 'workflow.paused',
      status: 'paused',
      maxCostUsd: null,
      pauseReason: 'BUDGET_EXCEEDED',
    });
    expect(parsed.pauseReason).toBe('BUDGET_EXCEEDED');
    expect(parsed.maxCostUsd).toBeNull();
  });

  it('拒绝非法事件类型、非法状态、越界评分与未知字段', () => {
    expect(workflowEventSchema.safeParse({ ...baseEvent, type: 'workflow.retry' }).success).toBe(false);
    expect(workflowEventSchema.safeParse({ ...baseEvent, status: 'waiting' }).success).toBe(false);
    expect(workflowEventSchema.safeParse({ ...baseEvent, criticScore: 101 }).success).toBe(false);
    expect(workflowEventSchema.safeParse({ ...baseEvent, completedSteps: -1 }).success).toBe(false);
    expect(workflowEventSchema.safeParse({ ...baseEvent, extra: 1 }).success).toBe(false);
    expect(workflowEventSchema.safeParse({ ...baseEvent, runId: 'run-1' }).success).toBe(false);
  });
});
