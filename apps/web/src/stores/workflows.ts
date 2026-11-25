import {
  WORKFLOW_SSE_EVENT_NAMES,
  isWorkflowTerminalStatus,
  workflowEventSchema,
  type CreateWorkflowRunInputPayload,
  type ResumeWorkflowRunInputPayload,
  type WorkflowEvent,
  type WorkflowRunDetailDto,
  type WorkflowRunStatus,
  type WorkflowRunSummaryDto,
  type WorkflowStepDto,
} from '@fanxiaoshuo/shared';
import { defineStore } from 'pinia';
import { describeError, isApiClientError, type FrontendErrorCode } from '@/api/errors';
import { workflowsApi } from '@/api/workflows';

/** SSE 实时连接状态（控制台顶部徽标与轮询兜底判定共用）。 */
export type WorkflowSseStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** SSE 断开或降级时的低频轮询间隔（活跃批次才会启动）。 */
export const WORKFLOW_FALLBACK_POLL_MS = 4_000;

/** 收到终态事件后补全 `criticIssues` / `outputWordCount` 等字段的防抖窗口。 */
export const WORKFLOW_REFRESH_DEBOUNCE_MS = 350;

/** 活跃批次：Worker 仍可能推进，需要轮询兜底。 */
const ACTIVE_RUN_STATUSES: readonly WorkflowRunStatus[] = ['queued', 'running'];

function isActiveStatus(status: WorkflowRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

/** 详情 DTO 去掉有序步骤后的摘要（用于同步左侧批次列表）。 */
function toSummary(detail: WorkflowRunDetailDto): WorkflowRunSummaryDto {
  const { steps, ...summary } = detail;
  void steps;
  return summary;
}

/** 把批次级事件字段合并进摘要 / 详情公共字段。 */
function mergeRunEvent(
  run: WorkflowRunSummaryDto,
  event: WorkflowEvent,
): WorkflowRunSummaryDto {
  const isRunLevelEvent = event.stepId === null;
  return {
    ...run,
    status: event.status,
    totalSteps: event.totalSteps,
    completedSteps: event.completedSteps,
    failedSteps: event.failedSteps,
    spentCostUsd: event.spentCostUsd,
    maxCostUsd: event.maxCostUsd,
    pauseReason: event.pauseReason,
    // 步骤级事件的 errorCode 属于该章节，不得污染批次级错误
    errorCode: isRunLevelEvent ? event.errorCode : run.errorCode,
    errorMessage: isRunLevelEvent ? event.errorMessage : run.errorMessage,
    startedAt: run.startedAt ?? (event.status === 'queued' ? null : event.timestamp),
    finishedAt:
      run.finishedAt ?? (isWorkflowTerminalStatus(event.status) ? event.timestamp : null),
  };
}

/** 把步骤级事件字段合并进单章步骤（事件缺省字段保留本地旧值）。 */
function mergeStepEvent(
  step: WorkflowStepDto,
  event: WorkflowEvent,
  minPassScore: number,
): WorkflowStepDto {
  const nextStatus = event.stepStatus ?? step.status;
  const criticScore = event.criticScore ?? step.criticScore;
  return {
    ...step,
    status: nextStatus,
    stage: event.stepStage ?? step.stage,
    criticScore,
    criticPassed:
      event.criticScore === null ? step.criticPassed : event.criticScore >= minPassScore,
    errorCode: event.errorCode ?? step.errorCode,
    errorMessage: event.errorMessage ?? step.errorMessage,
    startedAt: step.startedAt ?? (nextStatus === 'running' ? event.timestamp : null),
    finishedAt:
      step.finishedAt ??
      (nextStatus === 'completed' || nextStatus === 'failed' ? event.timestamp : null),
  };
}

interface WorkflowsState {
  /* 批次列表 */
  runs: WorkflowRunSummaryDto[];
  total: number;
  page: number;
  pageSize: number;
  bookIdFilter: string | null;
  statusFilter: WorkflowRunStatus | null;
  listLoading: boolean;
  listError: string | null;

  /* 当前选中批次详情 */
  selectedRunId: string | null;
  selectedRun: WorkflowRunDetailDto | null;
  detailLoading: boolean;
  detailError: string | null;

  /* 控制操作 */
  creating: boolean;
  createError: string | null;
  /** 创建失败的错误码（`AGENT_ROLE_UNBOUND` 等），供弹窗引导跳转 /models */
  createErrorCode: FrontendErrorCode | null;
  mutating: boolean;
  retryingStepId: string | null;

  /* 实时连接 */
  sseStatus: WorkflowSseStatus;
  /** 页面是否请求过订阅（避免未进入控制台就开始轮询） */
  eventsRequested: boolean;
}

/** 模块级单例：同一时刻只允许一个控制台连接事件流（与工作区自动保存同风格）。 */
let eventsSource: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function clearRefreshTimer(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function closeEventSource(): void {
  if (eventsSource !== null) {
    eventsSource.close();
    eventsSource = null;
  }
}

function clearPollTimer(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export const useWorkflowsStore = defineStore('fx-workflows', {
  state: (): WorkflowsState => ({
    runs: [],
    total: 0,
    page: 1,
    pageSize: 20,
    bookIdFilter: null,
    statusFilter: null,
    listLoading: false,
    listError: null,

    selectedRunId: null,
    selectedRun: null,
    detailLoading: false,
    detailError: null,

    creating: false,
    createError: null,
    createErrorCode: null,
    mutating: false,
    retryingStepId: null,

    sseStatus: 'disconnected',
    eventsRequested: false,
  }),

  getters: {
    /** 是否存在仍需 Worker 推进的批次（决定是否启用轮询兜底）。 */
    hasActiveRuns(state): boolean {
      if (state.runs.some((run) => isActiveStatus(run.status))) {
        return true;
      }
      return state.selectedRun !== null && isActiveStatus(state.selectedRun.status);
    },
    runById(state) {
      return (runId: string): WorkflowRunSummaryDto | undefined =>
        state.runs.find((run) => run.id === runId);
    },
    totalPages(state): number {
      if (state.pageSize <= 0) {
        return 1;
      }
      return Math.max(1, Math.ceil(state.total / state.pageSize));
    },
  },

  actions: {
    /* ------------------------------------------------------------------ */
    /*                              批次列表                              */
    /* ------------------------------------------------------------------ */

    async loadRuns(): Promise<void> {
      this.listLoading = true;
      this.listError = null;
      try {
        const response = await workflowsApi.list({
          bookId: this.bookIdFilter ?? undefined,
          status: this.statusFilter ?? undefined,
          page: this.page,
          pageSize: this.pageSize,
        });
        this.runs = response.items;
        this.total = response.total;
        this.page = response.page;
        this.pageSize = response.pageSize;
      } catch (error) {
        this.listError = describeError(error);
        throw error;
      } finally {
        this.listLoading = false;
        this.syncFallbackPolling();
      }
    },

    setStatusFilter(status: WorkflowRunStatus | null): void {
      this.statusFilter = status;
      this.page = 1;
    },

    setBookFilter(bookId: string | null): void {
      this.bookIdFilter = bookId;
      this.page = 1;
    },

    async goToPage(page: number): Promise<void> {
      if (page < 1 || page === this.page) {
        return;
      }
      this.page = page;
      await this.loadRuns();
    },

    /* ------------------------------------------------------------------ */
    /*                              批次详情                              */
    /* ------------------------------------------------------------------ */

    async selectRun(runId: string): Promise<void> {
      this.selectedRunId = runId;
      this.selectedRun = null;
      this.detailError = null;
      await this.refreshSelectedRun();
    },

    async refreshSelectedRun(): Promise<void> {
      const runId = this.selectedRunId;
      if (runId === null) {
        return;
      }
      this.detailLoading = true;
      this.detailError = null;
      try {
        const detail = await workflowsApi.getRun(runId);
        if (this.selectedRunId !== runId) {
          return;
        }
        this.selectedRun = detail;
        this.syncRunSummary(detail);
      } catch (error) {
        // 轮询兜底会反复调用本方法，错误只落到 detailError，不向调用方抛出
        this.detailError = describeError(error);
      } finally {
        this.detailLoading = false;
        this.syncFallbackPolling();
      }
    },

    /* ------------------------------------------------------------------ */
    /*                              控制操作                              */
    /* ------------------------------------------------------------------ */

    async createRun(payload: CreateWorkflowRunInputPayload): Promise<WorkflowRunDetailDto> {
      this.creating = true;
      this.createError = null;
      this.createErrorCode = null;
      try {
        const created = await workflowsApi.createRun(payload);
        this.selectedRunId = created.id;
        this.selectedRun = created;
        this.detailError = null;
        this.upsertRunSummary(toSummary(created));
        return created;
      } catch (error) {
        this.createError = describeError(error);
        this.createErrorCode = isApiClientError(error) ? error.code : null;
        throw error;
      } finally {
        this.creating = false;
        this.syncFallbackPolling();
      }
    },

    async pauseRun(runId: string): Promise<void> {
      await this.runMutation(() => workflowsApi.pauseRun(runId));
    },

    async resumeRun(
      runId: string,
      payload: ResumeWorkflowRunInputPayload = {},
    ): Promise<void> {
      await this.runMutation(() => workflowsApi.resumeRun(runId, payload));
    },

    async cancelRun(runId: string): Promise<void> {
      await this.runMutation(() => workflowsApi.cancelRun(runId));
    },

    async retryStep(runId: string, stepId: string): Promise<void> {
      this.retryingStepId = stepId;
      try {
        await this.runMutation(() => workflowsApi.retryStep(runId, stepId));
      } finally {
        this.retryingStepId = null;
      }
    },

    async deleteRun(runId: string): Promise<void> {
      this.mutating = true;
      try {
        await workflowsApi.deleteRun(runId);
        this.runs = this.runs.filter((run) => run.id !== runId);
        this.total = Math.max(0, this.total - 1);
        if (this.selectedRunId === runId) {
          this.selectedRunId = null;
          this.selectedRun = null;
          this.detailError = null;
        }
      } finally {
        this.mutating = false;
        this.syncFallbackPolling();
      }
    },

    /* ------------------------------------------------------------------ */
    /*                              实时事件                              */
    /* ------------------------------------------------------------------ */

    applyWorkflowEvent(event: WorkflowEvent): void {
      const knownRun = this.runs.some((run) => run.id === event.runId);
      this.runs = this.runs.map((run) =>
        run.id === event.runId ? mergeRunEvent(run, event) : run,
      );

      const selected = this.selectedRun;
      let touchedSelection = false;
      if (selected !== null && selected.id === event.runId) {
        const merged = mergeRunEvent(selected, event);
        const steps =
          event.stepId === null
            ? selected.steps
            : selected.steps.map((step) =>
                step.id === event.stepId
                  ? mergeStepEvent(step, event, selected.config.minPassScore)
                  : step,
              );
        this.selectedRun = { ...merged, steps };
        touchedSelection = true;
      }

      // 终态 / 暂停 / 步骤收敛时补全 `criticIssues` 等实时事件未携带的字段
      const stepSettled = event.stepStatus === 'completed' || event.stepStatus === 'failed';
      const runSettled = event.status === 'paused' || isWorkflowTerminalStatus(event.status);
      if (!knownRun || (touchedSelection && (stepSettled || runSettled))) {
        this.scheduleRefresh();
      }

      this.syncFallbackPolling();
    },

    /** 防抖刷新：合并同一批次连续多条事件，只发一次补全请求。 */
    scheduleRefresh(): void {
      clearRefreshTimer();
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void this.refreshSelectedRun();
        void this.loadRuns().catch(() => {
          /* 兜底刷新失败保持本地状态，等待下一次事件或轮询 */
        });
      }, WORKFLOW_REFRESH_DEBOUNCE_MS);
    },

    connectEvents(): void {
      this.eventsRequested = true;
      if (eventsSource !== null) {
        return;
      }
      if (typeof EventSource === 'undefined') {
        this.sseStatus = 'error';
        this.syncFallbackPolling();
        return;
      }

      this.sseStatus = 'connecting';
      const source = new EventSource(workflowsApi.eventsUrl());
      eventsSource = source;

      source.onopen = () => {
        this.sseStatus = 'connected';
        this.syncFallbackPolling();
      };
      source.onerror = () => {
        // 浏览器 EventSource 会自动重连，这里降级为轮询兜底直到恢复
        this.sseStatus = 'error';
        this.syncFallbackPolling();
      };
      source.addEventListener(WORKFLOW_SSE_EVENT_NAMES.ready, () => {
        this.sseStatus = 'connected';
        this.syncFallbackPolling();
      });
      source.addEventListener(WORKFLOW_SSE_EVENT_NAMES.workflowEvent, (event) => {
        const parsed = parseWorkflowEventFrame(event);
        if (parsed === null) {
          return;
        }
        this.applyWorkflowEvent(parsed);
      });

      this.syncFallbackPolling();
    },

    disconnectEvents(): void {
      closeEventSource();
      clearPollTimer();
      clearRefreshTimer();
      this.eventsRequested = false;
      this.sseStatus = 'disconnected';
    },

    /* ------------------------------------------------------------------ */
    /*                                内部                                */
    /* ------------------------------------------------------------------ */

    /** 统一控制操作包装：置 `mutating`、应用最新详情、同步列表摘要。 */
    async runMutation(request: () => Promise<WorkflowRunDetailDto>): Promise<void> {
      this.mutating = true;
      try {
        const detail = await request();
        if (this.selectedRunId === detail.id) {
          this.selectedRun = detail;
          this.detailError = null;
        }
        this.syncRunSummary(detail);
      } finally {
        this.mutating = false;
        this.syncFallbackPolling();
      }
    },

    /** 同步左侧列表中的对应摘要（不存在时按创建时间插入头部）。 */
    syncRunSummary(detail: WorkflowRunDetailDto): void {
      const summary = toSummary(detail);
      const index = this.runs.findIndex((run) => run.id === detail.id);
      if (index >= 0) {
        this.runs = this.runs.map((run) => (run.id === detail.id ? summary : run));
        return;
      }
      this.runs = [summary, ...this.runs];
      this.total += 1;
    },

    upsertRunSummary(summary: WorkflowRunSummaryDto): void {
      const index = this.runs.findIndex((run) => run.id === summary.id);
      if (index >= 0) {
        this.runs = this.runs.map((run) => (run.id === summary.id ? summary : run));
        return;
      }
      this.runs = [summary, ...this.runs];
      this.total += 1;
    },

    /** SSE 已连上时关闭轮询；断开且存在活跃批次时保持低频轮询。 */
    syncFallbackPolling(): void {
      const shouldPoll =
        this.eventsRequested && this.sseStatus !== 'connected' && this.hasActiveRuns;
      if (!shouldPoll) {
        clearPollTimer();
        return;
      }
      if (pollTimer !== null) {
        return;
      }
      pollTimer = setInterval(() => {
        void this.loadRuns().catch(() => {
          /* 轮询失败等待下一轮 */
        });
        if (this.selectedRunId !== null) {
          void this.refreshSelectedRun();
        }
      }, WORKFLOW_FALLBACK_POLL_MS);
    },
  },
});

/** SSE `workflow-event` 帧严格解析：非法或非 JSON 载荷一律丢弃（等待下一条）。 */
export function parseWorkflowEventFrame(event: Event): WorkflowEvent | null {
  if (!('data' in event)) {
    return null;
  }
  const data = (event as MessageEvent<unknown>).data;
  if (typeof data !== 'string' || data.length === 0) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  const parsed = workflowEventSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
