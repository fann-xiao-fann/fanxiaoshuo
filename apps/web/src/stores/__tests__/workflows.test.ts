import type {
  WorkflowEvent,
  WorkflowRunConfig,
  WorkflowRunDetailDto,
  WorkflowRunSummaryDto,
  WorkflowStepDto,
} from '@fanxiaoshuo/shared';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/workflows', () => ({
  workflowsApi: {
    list: vi.fn(),
    createRun: vi.fn(),
    getRun: vi.fn(),
    pauseRun: vi.fn(),
    resumeRun: vi.fn(),
    cancelRun: vi.fn(),
    retryStep: vi.fn(),
    deleteRun: vi.fn(),
    eventsUrl: vi.fn(),
  },
}));

import { ApiClientError } from '@/api/errors';
import { workflowsApi } from '@/api/workflows';
import {
  WORKFLOW_FALLBACK_POLL_MS,
  WORKFLOW_REFRESH_DEBOUNCE_MS,
  parseWorkflowEventFrame,
  useWorkflowsStore,
} from '@/stores/workflows';

const RUN_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_RUN_ID = 'aaaaaaaa-2222-4222-8222-222222222222';
const BOOK_ID = 'bbbbbbbb-1111-4111-8111-111111111111';
const CHAPTER_1 = 'cccccccc-1111-4111-8111-111111111111';
const CHAPTER_2 = 'cccccccc-2222-4222-8222-222222222222';
const STEP_1 = 'dddddddd-1111-4111-8111-111111111111';
const STEP_2 = 'dddddddd-2222-4222-8222-222222222222';
const NOW = '2024-05-01T10:00:00.000Z';
const LATER = '2024-05-01T10:05:00.000Z';

const CONFIG: WorkflowRunConfig = {
  enableCritic: true,
  minPassScore: 75,
  maxReworkRounds: 1,
  enableSummary: true,
  maxContextTokens: 64_000,
  instruction: '',
};

function makeStep(overrides: Partial<WorkflowStepDto> = {}): WorkflowStepDto {
  return {
    id: STEP_1,
    runId: RUN_ID,
    chapterId: CHAPTER_1,
    stepIndex: 0,
    chapterTitleSnapshot: '第1章 夜行',
    status: 'pending',
    stage: 'idle',
    reworkCount: 0,
    criticScore: null,
    criticPassed: null,
    criticSummary: null,
    criticIssues: [],
    outputWordCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    backupRevisionId: null,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<WorkflowRunSummaryDto> = {}): WorkflowRunSummaryDto {
  return {
    id: RUN_ID,
    bookId: BOOK_ID,
    bookTitle: '长夜灯河',
    mode: 'full_pipeline',
    status: 'queued',
    config: CONFIG,
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<WorkflowRunDetailDto> = {}): WorkflowRunDetailDto {
  return {
    ...makeSummary(),
    steps: [
      makeStep(),
      makeStep({
        id: STEP_2,
        chapterId: CHAPTER_2,
        stepIndex: 1,
        chapterTitleSnapshot: '第2章 灯下',
      }),
    ],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    type: 'workflow.step_updated',
    runId: RUN_ID,
    bookId: BOOK_ID,
    status: 'running',
    timestamp: LATER,
    totalSteps: 2,
    completedSteps: 0,
    failedSteps: 0,
    spentCostUsd: 0,
    maxCostUsd: 5,
    pauseReason: null,
    stepId: null,
    chapterId: null,
    stepIndex: null,
    stepStatus: null,
    stepStage: null,
    criticScore: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

/** 最小 EventSource 替身：手动派发 `open` / `error` / 自定义事件帧。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.(new Event('open'));
  }

  emitError(): void {
    this.onerror?.(new Event('error'));
  }

  emit(type: string, data?: string): void {
    const event = { data } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as unknown as Event);
    }
  }
}

const listMock = vi.mocked(workflowsApi.list);
const createRunMock = vi.mocked(workflowsApi.createRun);
const getRunMock = vi.mocked(workflowsApi.getRun);
const pauseMock = vi.mocked(workflowsApi.pauseRun);
const resumeMock = vi.mocked(workflowsApi.resumeRun);
const cancelMock = vi.mocked(workflowsApi.cancelRun);
const retryMock = vi.mocked(workflowsApi.retryStep);
const deleteMock = vi.mocked(workflowsApi.deleteRun);
const eventsUrlMock = vi.mocked(workflowsApi.eventsUrl);

let store: ReturnType<typeof useWorkflowsStore>;

beforeEach(() => {
  setActivePinia(createPinia());
  store = useWorkflowsStore();
  eventsUrlMock.mockReturnValue('/api/v1/workflows/events');
  FakeEventSource.instances = [];
});

afterEach(() => {
  store.disconnectEvents();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useWorkflowsStore · 批次列表与创建', () => {
  it('加载批次列表并记录分页与筛选参数', async () => {
    listMock.mockResolvedValue({
      items: [makeSummary()],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    await store.loadRuns();

    expect(listMock).toHaveBeenCalledWith({
      bookId: undefined,
      status: undefined,
      page: 1,
      pageSize: 20,
    });
    expect(store.runs).toHaveLength(1);
    expect(store.total).toBe(1);
    expect(store.listLoading).toBe(false);
    expect(store.listError).toBeNull();
  });

  it('列表加载失败时收敛错误文案', async () => {
    listMock.mockRejectedValue(
      new ApiClientError('后端未启动', { code: 'NETWORK_ERROR', status: 0 }),
    );

    await expect(store.loadRuns()).rejects.toThrow('后端未启动');

    expect(store.listError).toBe('后端未启动');
    expect(store.listLoading).toBe(false);
    expect(store.runs).toHaveLength(0);
  });

  it('创建批次后自动选中并把摘要插入列表头部', async () => {
    createRunMock.mockResolvedValue(makeDetail());

    const created = await store.createRun({
      bookId: BOOK_ID,
      mode: 'full_pipeline',
      chapterIds: [CHAPTER_1, CHAPTER_2],
      maxCostUsd: 5,
    });

    expect(createRunMock).toHaveBeenCalledTimes(1);
    expect(created.id).toBe(RUN_ID);
    expect(store.selectedRunId).toBe(RUN_ID);
    expect(store.selectedRun?.id).toBe(RUN_ID);
    expect(store.selectedRun?.steps).toHaveLength(2);
    expect(store.runs[0]?.id).toBe(RUN_ID);
    expect(store.runs[0]).not.toHaveProperty('steps');
    expect(store.total).toBe(1);
    expect(store.creating).toBe(false);
    expect(store.createError).toBeNull();
    expect(store.createErrorCode).toBeNull();
  });

  it('创建失败时保留角色未绑定错误码以便引导去模型配置', async () => {
    createRunMock.mockRejectedValue(
      new ApiClientError('审稿角色尚未绑定模型', { code: 'AGENT_ROLE_UNBOUND', status: 409 }),
    );

    await expect(
      store.createRun({ bookId: BOOK_ID, mode: 'full_pipeline', chapterIds: [CHAPTER_1] }),
    ).rejects.toThrow('审稿角色尚未绑定模型');

    expect(store.createError).toBe('审稿角色尚未绑定模型');
    expect(store.createErrorCode).toBe('AGENT_ROLE_UNBOUND');
    expect(store.creating).toBe(false);
    expect(store.runs).toHaveLength(0);
    expect(store.selectedRunId).toBeNull();
  });
});

describe('useWorkflowsStore · 生命周期控制', () => {
  function seedSelection(): void {
    store.runs = [makeSummary({ status: 'running' })];
    store.total = 1;
    store.selectedRunId = RUN_ID;
    store.selectedRun = makeDetail({ status: 'running' });
  }

  it('暂停批次后同步详情与列表摘要', async () => {
    seedSelection();
    pauseMock.mockResolvedValue(makeDetail({ status: 'paused', pauseReason: 'USER_PAUSED' }));

    await store.pauseRun(RUN_ID);

    expect(pauseMock).toHaveBeenCalledWith(RUN_ID);
    expect(store.selectedRun?.status).toBe('paused');
    expect(store.selectedRun?.pauseReason).toBe('USER_PAUSED');
    expect(store.runs[0]?.status).toBe('paused');
    expect(store.mutating).toBe(false);
  });

  it('上调预算后续跑并记录新的预算上限', async () => {
    seedSelection();
    store.selectedRun = makeDetail({
      status: 'paused',
      pauseReason: 'BUDGET_EXCEEDED',
      maxCostUsd: 0.5,
      spentCostUsd: 0.5,
      completedSteps: 1,
    });
    resumeMock.mockResolvedValue(
      makeDetail({ status: 'running', maxCostUsd: 12, spentCostUsd: 0.5, completedSteps: 1 }),
    );

    await store.resumeRun(RUN_ID, { maxCostUsd: 12 });

    expect(resumeMock).toHaveBeenCalledWith(RUN_ID, { maxCostUsd: 12 });
    expect(store.selectedRun?.status).toBe('running');
    expect(store.selectedRun?.maxCostUsd).toBe(12);
    expect(store.selectedRun?.pauseReason).toBeNull();
    expect(store.runs[0]?.maxCostUsd).toBe(12);
  });

  it('取消批次后收敛为 cancelled', async () => {
    seedSelection();
    cancelMock.mockResolvedValue(
      makeDetail({ status: 'cancelled', finishedAt: LATER, completedSteps: 1 }),
    );

    await store.cancelRun(RUN_ID);

    expect(store.selectedRun?.status).toBe('cancelled');
    expect(store.selectedRun?.finishedAt).toBe(LATER);
    expect(store.runs[0]?.status).toBe('cancelled');
  });

  it('重试单个失败步骤并把该步重置为 pending', async () => {
    seedSelection();
    store.selectedRun = makeDetail({
      status: 'failed',
      steps: [makeStep({ status: 'failed', errorCode: 'UPSTREAM_ERROR' }), makeStep({ id: STEP_2 })],
    });
    retryMock.mockResolvedValue(
      makeDetail({
        status: 'queued',
        steps: [makeStep({ status: 'pending' }), makeStep({ id: STEP_2 })],
      }),
    );

    await store.retryStep(RUN_ID, STEP_1);

    expect(retryMock).toHaveBeenCalledWith(RUN_ID, STEP_1);
    expect(store.retryingStepId).toBeNull();
    expect(store.selectedRun?.steps[0]?.status).toBe('pending');
    expect(store.selectedRun?.status).toBe('queued');
  });

  it('删除终态批次后清空选中并维护总数', async () => {
    seedSelection();
    store.selectedRun = makeDetail({ status: 'completed', finishedAt: LATER });
    deleteMock.mockResolvedValue(undefined);

    await store.deleteRun(RUN_ID);

    expect(deleteMock).toHaveBeenCalledWith(RUN_ID);
    expect(store.runs).toHaveLength(0);
    expect(store.total).toBe(0);
    expect(store.selectedRunId).toBeNull();
    expect(store.selectedRun).toBeNull();
    expect(store.mutating).toBe(false);
  });
});

describe('useWorkflowsStore · 实时事件合并', () => {
  it('workflow-event 精准更新步骤阶段、审稿分与批次进度', () => {
    store.runs = [makeSummary({ status: 'running' })];
    store.selectedRunId = RUN_ID;
    store.selectedRun = makeDetail({ status: 'running' });

    store.applyWorkflowEvent(
      makeEvent({
        stepId: STEP_1,
        chapterId: CHAPTER_1,
        stepIndex: 0,
        stepStatus: 'completed',
        stepStage: 'reviewing',
        criticScore: 88,
        status: 'running',
        completedSteps: 1,
        spentCostUsd: 0.23,
        totalSteps: 2,
      }),
    );

    const step = store.selectedRun?.steps[0];
    expect(step?.status).toBe('completed');
    expect(step?.stage).toBe('reviewing');
    expect(step?.criticScore).toBe(88);
    expect(step?.criticPassed).toBe(true);
    expect(step?.finishedAt).toBe(LATER);
    expect(store.selectedRun?.completedSteps).toBe(1);
    expect(store.selectedRun?.spentCostUsd).toBeCloseTo(0.23);
    expect(store.runs[0]?.completedSteps).toBe(1);
    expect(store.runs[0]?.spentCostUsd).toBeCloseTo(0.23);
    // 步骤级事件不得污染批次级错误字段
    expect(store.runs[0]?.errorCode).toBeNull();
  });

  it('步骤级事件只在选中批次上合并，且忽略未选中批次的详情', () => {
    store.runs = [makeSummary({ status: 'running' })];
    store.selectedRunId = RUN_ID;
    store.selectedRun = makeDetail({ status: 'running' });

    store.applyWorkflowEvent(
      makeEvent({
        runId: OTHER_RUN_ID,
        stepId: STEP_1,
        stepStatus: 'failed',
        stepStage: 'writing',
        errorCode: 'UPSTREAM_TIMEOUT',
      }),
    );

    expect(store.selectedRun?.steps[0]?.status).toBe('pending');
    expect(store.selectedRun?.errorCode).toBeNull();
  });

  it('预算熔断暂停事件收敛 pauseReason 并在防抖后补全详情', async () => {
    vi.useFakeTimers();
    store.runs = [makeSummary({ status: 'running' })];
    store.selectedRunId = RUN_ID;
    store.selectedRun = makeDetail({ status: 'running' });
    getRunMock.mockResolvedValue(
      makeDetail({
        status: 'paused',
        pauseReason: 'BUDGET_EXCEEDED',
        maxCostUsd: 0.2,
        spentCostUsd: 0.2,
        completedSteps: 1,
      }),
    );
    listMock.mockResolvedValue({
      items: [makeSummary({ status: 'paused', pauseReason: 'BUDGET_EXCEEDED' })],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    store.applyWorkflowEvent(
      makeEvent({
        type: 'workflow.paused',
        status: 'paused',
        pauseReason: 'BUDGET_EXCEEDED',
        completedSteps: 1,
        spentCostUsd: 0.2,
        maxCostUsd: 0.2,
      }),
    );

    expect(store.selectedRun?.status).toBe('paused');
    expect(store.selectedRun?.pauseReason).toBe('BUDGET_EXCEEDED');
    expect(store.selectedRun?.spentCostUsd).toBeCloseTo(0.2);
    expect(store.runs[0]?.pauseReason).toBe('BUDGET_EXCEEDED');
    expect(getRunMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WORKFLOW_REFRESH_DEBOUNCE_MS + 20);

    expect(getRunMock).toHaveBeenCalledWith(RUN_ID);
    expect(listMock).toHaveBeenCalled();
    expect(store.selectedRun?.steps).toHaveLength(2);
  });

  it('截获非法 SSE 载荷并丢弃', () => {
    const valid = new Event('workflow-event');
    Object.defineProperty(valid, 'data', { value: JSON.stringify(makeEvent()) });
    expect(parseWorkflowEventFrame(valid)?.runId).toBe(RUN_ID);

    const broken = new Event('workflow-event');
    Object.defineProperty(broken, 'data', { value: '{not-json' });
    expect(parseWorkflowEventFrame(broken)).toBeNull();

    const schemaMismatch = new Event('workflow-event');
    Object.defineProperty(schemaMismatch, 'data', { value: JSON.stringify({ type: 'nope' }) });
    expect(parseWorkflowEventFrame(schemaMismatch)).toBeNull();
  });
});

describe('useWorkflowsStore · SSE 订阅与轮询兜底', () => {
  it('连接事件流并应用 workflow-event 帧', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    store.runs = [makeSummary({ status: 'running' })];
    store.selectedRunId = RUN_ID;
    store.selectedRun = makeDetail({ status: 'running' });

    store.connectEvents();

    expect(store.sseStatus).toBe('connecting');
    const source = FakeEventSource.instances.at(-1);
    expect(source?.url).toBe('/api/v1/workflows/events');

    source?.emitOpen();
    expect(store.sseStatus).toBe('connected');

    source?.emit('ready');
    source?.emit(
      'workflow-event',
      JSON.stringify(
        makeEvent({
          stepId: STEP_2,
          chapterId: CHAPTER_2,
          stepIndex: 1,
          stepStatus: 'running',
          stepStage: 'writing',
        }),
      ),
    );

    expect(store.selectedRun?.steps[1]?.stage).toBe('writing');

    // 非法帧不得破坏本地状态
    source?.emit('workflow-event', 'bad-json');
    source?.emit('workflow-event', JSON.stringify({ type: 'nope' }));
    expect(store.selectedRun?.steps[1]?.stage).toBe('writing');

    store.disconnectEvents();
    expect(source?.closed).toBe(true);
    expect(store.sseStatus).toBe('disconnected');
  });

  it('SSE 降级时对活跃批次启用低频轮询并在离开时彻底清理', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    listMock.mockResolvedValue({
      items: [makeSummary({ status: 'running' })],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    getRunMock.mockResolvedValue(makeDetail({ status: 'running' }));

    await store.loadRuns();
    store.connectEvents();

    const source = FakeEventSource.instances.at(-1);
    source?.emitError();
    expect(store.sseStatus).toBe('error');

    listMock.mockClear();
    await vi.advanceTimersByTimeAsync(WORKFLOW_FALLBACK_POLL_MS + 20);
    expect(listMock).toHaveBeenCalledTimes(1);

    store.disconnectEvents();
    expect(store.sseStatus).toBe('disconnected');

    listMock.mockClear();
    await vi.advanceTimersByTimeAsync(WORKFLOW_FALLBACK_POLL_MS * 2);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('环境不支持 EventSource 时直接降级为轮询', () => {
    vi.stubGlobal('EventSource', undefined);
    store.runs = [makeSummary({ status: 'running' })];
    store.connectEvents();

    expect(store.sseStatus).toBe('error');
    store.disconnectEvents();
  });
});
