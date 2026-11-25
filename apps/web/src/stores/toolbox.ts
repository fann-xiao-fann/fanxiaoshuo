import {
  PAGINATION,
  TOOLBOX_CATEGORIES,
  TOOLBOX_CATEGORY_LABELS,
  TOOLBOX_TOOL_DEFINITIONS,
  isToolboxToolId,
  validateToolboxInputs,
  type AgentRole,
  type ApplyToolboxCardRequestPayload,
  type ApplyToolboxOutlineRequestPayload,
  type BookOutlineDto,
  type KnowledgeCardDto,
  type ToolboxCategory,
  type ToolboxRunDetail,
  type ToolboxRunSummary,
  type ToolboxToolDefinition,
  type ToolboxToolDefinitionDto,
  type ToolboxToolId,
} from '@fanxiaoshuo/shared';
import { defineStore } from 'pinia';
import { describeError, isApiClientError, type FrontendErrorCode } from '@/api/errors';
import { toolboxApi, type ToolboxRunListQuery } from '@/api/toolbox';

/**
 * 创作工具盒 Pinia Store。
 *
 * 契约驱动：工具目录、字段默认值、输入校验与结果回写全部来自 `@fanxiaoshuo/shared`，
 * 前端不重复声明任何字段列表或分类文案。状态口径：
 * - 目录与服务端返回一致（加载失败时回退到共享冻结目录，保证离线也能渲染表单）；
 * - `formInputs` 在切换工具时按该工具 `fields[].defaultValue` 重建；
 * - 执行前必须先过 `validateToolboxInputs`，服务端校验是最后一道防线而非第一道。
 */

/** 这些错误码说明角色 / 模型前置条件未满足，需要引导用户去模型配置中心。 */
export const TOOLBOX_MODEL_SETUP_ERROR_CODES: readonly FrontendErrorCode[] = [
  'AGENT_ROLE_UNBOUND',
  'MODEL_DISABLED',
  'PROVIDER_DISABLED',
];

/** 表单值集合：文本 / 下拉为字符串，数量类为数字（空值统一用空串表示）。 */
export type ToolboxFormInputs = Record<string, string | number>;

/** 工具目录分组（左侧目录按 3 大分类渲染）。 */
export interface ToolboxToolGroup {
  category: ToolboxCategory;
  label: string;
  tools: ToolboxToolDefinitionDto[];
}

/**
 * 把冻结的共享目录复制成可变的 DTO 结构。
 *
 * `TOOLBOX_TOOL_DEFINITIONS` 是 `as const` 只读字面量，直接赋值给可变的 DTO 数组
 * 会因 `readonly` 修饰符不兼容而报错；这里做一次纯结构拷贝，既保住类型也不引入 `any`。
 */
function cloneToolDefinition(definition: ToolboxToolDefinition): ToolboxToolDefinitionDto {
  return {
    id: definition.id,
    name: definition.name,
    category: definition.category,
    summary: definition.summary,
    defaultRole: definition.defaultRole,
    supportsBookContext: definition.supportsBookContext,
    applyTargets: [...definition.applyTargets],
    defaultCardCategory: definition.defaultCardCategory,
    fields: definition.fields.map((field) => {
      const { options, ...rest } = field;
      return options === undefined
        ? { ...rest }
        : { ...rest, options: options.map((option) => ({ ...option })) };
    }),
  };
}

/** 只读目录 → 可变 DTO 列表（应用启动与测试共用的兜底数据源）。 */
export function createFallbackTools(): ToolboxToolDefinitionDto[] {
  return TOOLBOX_TOOL_DEFINITIONS.map((definition) => cloneToolDefinition(definition));
}

/** 启动时的默认工具 ID（目录第一项：书名与简介策划）。 */
const DEFAULT_TOOL_ID: ToolboxToolId = 'book-pitch';

/** 默认工具的表单初始值。 */
function initialFormInputs(): ToolboxFormInputs {
  const tool = createFallbackTools().find((item) => item.id === DEFAULT_TOOL_ID);
  return tool === undefined ? {} : buildDefaultInputs(tool);
}

/** 按工具字段定义生成表单初始值（`defaultValue` 优先，缺失时填空串）。 */
export function buildDefaultInputs(tool: ToolboxToolDefinitionDto): ToolboxFormInputs {
  const inputs: ToolboxFormInputs = {};
  for (const field of tool.fields) {
    inputs[field.key] = field.defaultValue ?? '';
  }
  return inputs;
}

/** 校验明细 → 字段级错误（`inputs.xxx` 投影为 `xxx`，供表单行内提示）。 */
function toFieldErrors(
  issues: ReadonlyArray<{ path: string; message: string }>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.startsWith('inputs.') ? issue.path.slice('inputs.'.length) : issue.path;
    if (!(key in errors)) {
      errors[key] = issue.message;
    }
  }
  return errors;
}

/** 详情 DTO 去掉 `inputs` / `output` 后的历史摘要。 */
function toRunSummary(detail: ToolboxRunDetail): ToolboxRunSummary {
  const { inputs, output, ...summary } = detail;
  void inputs;
  void output;
  return summary;
}

interface ToolboxState {
  /* 工具目录 */
  tools: ToolboxToolDefinitionDto[];
  toolsLoading: boolean;
  toolsError: string | null;

  /* 当前工具与表单 */
  selectedToolId: ToolboxToolId;
  selectedBookId: string | null;
  roleOverride: AgentRole | null;
  formInputs: ToolboxFormInputs;
  fieldErrors: Record<string, string>;

  /* 执行态 */
  running: boolean;
  activeRun: ToolboxRunDetail | null;
  error: string | null;
  errorCode: FrontendErrorCode | null;

  /* 历史记录 */
  runs: ToolboxRunSummary[];
  totalRuns: number;
  page: number;
  pageSize: number;
  historyToolFilter: ToolboxToolId | null;
  historyBookFilter: string | null;
  historyLoading: boolean;
  historyError: string | null;
  detailLoading: boolean;
  deletingRunId: string | null;

  /* 回写态 */
  applying: boolean;
}

export const useToolboxStore = defineStore('fx-toolbox', {
  state: (): ToolboxState => ({
    tools: createFallbackTools(),
    toolsLoading: false,
    toolsError: null,

    selectedToolId: DEFAULT_TOOL_ID,
    selectedBookId: null,
    roleOverride: null,
    formInputs: initialFormInputs(),
    fieldErrors: {},

    running: false,
    activeRun: null,
    error: null,
    errorCode: null,

    runs: [],
    totalRuns: 0,
    page: PAGINATION.defaultPage,
    pageSize: PAGINATION.defaultPageSize,
    historyToolFilter: null,
    historyBookFilter: null,
    historyLoading: false,
    historyError: null,
    detailLoading: false,
    deletingRunId: null,

    applying: false,
  }),

  getters: {
    /** 当前选中工具的完整声明式定义。 */
    selectedTool(state): ToolboxToolDefinitionDto | undefined {
      return state.tools.find((tool) => tool.id === state.selectedToolId);
    },

    /** 左侧目录：按 `planning → worldbuilding → drafting` 顺序分组。 */
    toolGroups(state): ToolboxToolGroup[] {
      return TOOLBOX_CATEGORIES.map((category) => ({
        category,
        label: TOOLBOX_CATEGORY_LABELS[category],
        tools: state.tools.filter((tool) => tool.category === category),
      })).filter((group) => group.tools.length > 0);
    },

    /** 实际执行角色：显式覆盖优先，否则取工具推荐角色。 */
    currentRole(state): AgentRole | null {
      if (state.roleOverride !== null) {
        return state.roleOverride;
      }
      return state.tools.find((tool) => tool.id === state.selectedToolId)?.defaultRole ?? null;
    },

    /** 是否因角色未绑定 / 模型停用而失败（展示「去配置模型」引导）。 */
    needsModelSetup(state): boolean {
      return state.errorCode !== null && TOOLBOX_MODEL_SETUP_ERROR_CODES.includes(state.errorCode);
    },

    /** 当前工具是否支持「存为设定卡」。 */
    canApplyCard(state): boolean {
      const tool = state.tools.find((item) => item.id === state.selectedToolId);
      return tool?.applyTargets.includes('knowledge_card') ?? false;
    },

    /** 当前工具是否支持「写入全书大纲」。 */
    canApplyOutline(state): boolean {
      const tool = state.tools.find((item) => item.id === state.selectedToolId);
      return tool?.applyTargets.includes('book_outline') ?? false;
    },

    totalPages(state): number {
      if (state.pageSize <= 0) {
        return 1;
      }
      return Math.max(1, Math.ceil(state.totalRuns / state.pageSize));
    },

    isHistoryEmpty(state): boolean {
      return !state.historyLoading && state.runs.length === 0;
    },
  },

  actions: {
    /* ------------------------------------------------------------------ */
    /*                              工具目录                              */
    /* ------------------------------------------------------------------ */

    async loadTools(): Promise<void> {
      this.toolsLoading = true;
      this.toolsError = null;
      try {
        const response = await toolboxApi.listTools();
        this.tools = response.tools.map((tool) => cloneToolDefinition(tool));
        // 当前选中的工具若已不在目录中，回退到第一个工具并重建表单
        const exists = this.tools.some((tool) => tool.id === this.selectedToolId);
        if (!exists && this.tools[0] !== undefined) {
          this.selectTool(this.tools[0].id);
        }
      } catch (error) {
        // 目录加载失败保留共享冻结目录兜底，表单仍可渲染
        this.toolsError = describeError(error);
      } finally {
        this.toolsLoading = false;
      }
    },

    /** 切换工具：按新工具的字段默认值重建表单并清空上一条结果。 */
    selectTool(toolId: ToolboxToolId): void {
      if (!isToolboxToolId(toolId)) {
        return;
      }
      this.selectedToolId = toolId;
      const tool = this.tools.find((item) => item.id === toolId) ?? createFallbackTools().find(
        (item) => item.id === toolId,
      );
      this.formInputs = tool === undefined ? {} : buildDefaultInputs(tool);
      this.fieldErrors = {};
      this.activeRun = null;
      this.error = null;
      this.errorCode = null;
    },

    setBookContext(bookId: string | null): void {
      this.selectedBookId = bookId;
      this.historyBookFilter = null;
    },

    setRoleOverride(role: AgentRole | null): void {
      this.roleOverride = role;
    },

    setFormInput(key: string, value: string | number): void {
      this.formInputs = { ...this.formInputs, [key]: value };
      if (key in this.fieldErrors) {
        const next = { ...this.fieldErrors };
        delete next[key];
        this.fieldErrors = next;
      }
    },

    clearError(): void {
      this.error = null;
      this.errorCode = null;
    },

    /* ------------------------------------------------------------------ */
    /*                                执行                                */
    /* ------------------------------------------------------------------ */

    /**
     * 执行当前工具：先做前端即时校验（拦截空必填项 / 越界数量 / 非法选项），
     * 通过后调用同步 REST 接口，并把结果写入 `activeRun` 与历史列表。
     *
     * 返回 `null` 表示本次执行未产出结果，失败原因见 `error` / `errorCode`
     * （上游异常或角色未绑定等服务端错误一律收敛到状态，不向视图层抛出）。
     */
    async executeCurrentTool(): Promise<ToolboxRunDetail | null> {
      const tool = this.selectedTool;
      if (tool === undefined) {
        this.error = '工具目录尚未就绪，请稍后重试。';
        this.errorCode = null;
        return null;
      }

      this.error = null;
      this.errorCode = null;
      this.fieldErrors = {};

      const validation = validateToolboxInputs(tool.id, this.formInputs);
      if (!validation.ok) {
        this.error = validation.issues.map((issue) => issue.message).join('；');
        this.errorCode = 'VALIDATION_ERROR';
        this.fieldErrors = toFieldErrors(validation.issues);
        return null;
      }

      this.running = true;
      try {
        const detail = await toolboxApi.runTool({
          toolId: tool.id,
          bookId: this.selectedBookId,
          ...(this.roleOverride === null ? {} : { role: this.roleOverride }),
          inputs: validation.data,
        });
        this.activeRun = detail;
        this.upsertRunSummary(toRunSummary(detail));
        this.page = PAGINATION.defaultPage;
        await this.refreshHistoryQuietly();
        return detail;
      } catch (error) {
        this.error = describeError(error);
        this.errorCode = isApiClientError(error) ? error.code : null;
        // 上游失败时服务端仍会落盘 `failed` 记录，静默刷新历史以展示留痕
        await this.refreshHistoryQuietly();
        return null;
      } finally {
        this.running = false;
      }
    },

    clearActiveRun(): void {
      this.activeRun = null;
      this.fieldErrors = {};
      this.error = null;
      this.errorCode = null;
    },

    /* ------------------------------------------------------------------ */
    /*                              历史记录                              */
    /* ------------------------------------------------------------------ */

    async loadHistory(): Promise<void> {
      this.historyLoading = true;
      this.historyError = null;
      try {
        const query: ToolboxRunListQuery = {
          page: this.page,
          pageSize: this.pageSize,
          ...(this.historyToolFilter === null ? {} : { toolId: this.historyToolFilter }),
          ...(this.historyBookFilter === null ? {} : { bookId: this.historyBookFilter }),
        };
        const response = await toolboxApi.listRuns(query);
        this.runs = response.items;
        this.totalRuns = response.total;
        this.page = response.page;
        this.pageSize = response.pageSize;
      } catch (error) {
        this.historyError = describeError(error);
        throw error;
      } finally {
        this.historyLoading = false;
      }
    },

    async refreshHistoryQuietly(): Promise<void> {
      try {
        await this.loadHistory();
      } catch {
        /* 历史刷新失败不影响本次执行结果的展示 */
      }
    },

    setHistoryToolFilter(toolId: ToolboxToolId | null): void {
      this.historyToolFilter = toolId;
      this.page = PAGINATION.defaultPage;
    },

    setHistoryBookFilter(bookId: string | null): void {
      this.historyBookFilter = bookId;
      this.page = PAGINATION.defaultPage;
    },

    async goToHistoryPage(page: number): Promise<void> {
      if (page < 1 || page === this.page) {
        return;
      }
      this.page = page;
      await this.loadHistory();
    },

    /** 回看历史运行：同步切换工具与表单值，并展示该次运行的结果卡片。 */
    async openHistoryRun(runId: string): Promise<ToolboxRunDetail | null> {
      this.detailLoading = true;
      this.error = null;
      this.errorCode = null;
      try {
        const detail = await toolboxApi.getRun(runId);
        this.activeRun = detail;
        const tool =
          this.tools.find((item) => item.id === detail.toolId) ??
          createFallbackTools().find((item) => item.id === detail.toolId);
        this.selectedToolId = detail.toolId;
        this.formInputs =
          tool === undefined
            ? { ...detail.inputs }
            : { ...buildDefaultInputs(tool), ...detail.inputs };
        this.fieldErrors = {};
        this.upsertRunSummary(toRunSummary(detail));
        return detail;
      } catch (error) {
        this.error = describeError(error);
        this.errorCode = isApiClientError(error) ? error.code : null;
        return null;
      } finally {
        this.detailLoading = false;
      }
    },

    /** 删除历史记录；不触碰已回写到 Book Bible 的设定卡与总大纲。 */
    async deleteHistoryRun(runId: string): Promise<boolean> {
      this.deletingRunId = runId;
      this.error = null;
      this.errorCode = null;
      try {
        await toolboxApi.deleteRun(runId);
        this.runs = this.runs.filter((run) => run.id !== runId);
        this.totalRuns = Math.max(0, this.totalRuns - 1);
        if (this.activeRun !== null && this.activeRun.id === runId) {
          this.activeRun = null;
        }
        if (this.runs.length === 0 && this.page > 1) {
          this.page -= 1;
          await this.refreshHistoryQuietly();
        }
        return true;
      } catch (error) {
        this.error = describeError(error);
        this.errorCode = isApiClientError(error) ? error.code : null;
        return false;
      } finally {
        this.deletingRunId = null;
      }
    },

    /* ------------------------------------------------------------------ */
    /*                                回写                                */
    /* ------------------------------------------------------------------ */

    /** 把结果条目一键存为设定卡（失败收敛到状态，返回 `null`）。 */
    async applyItemToCard(
      runId: string,
      payload: ApplyToolboxCardRequestPayload,
    ): Promise<KnowledgeCardDto | null> {
      this.applying = true;
      this.error = null;
      this.errorCode = null;
      try {
        return await toolboxApi.applyCard(runId, payload);
      } catch (error) {
        this.error = describeError(error);
        this.errorCode = isApiClientError(error) ? error.code : null;
        return null;
      } finally {
        this.applying = false;
      }
    },

    /** 把结果条目一键写入全书总大纲（失败收敛到状态，返回 `null`）。 */
    async applyItemToOutline(
      runId: string,
      payload: ApplyToolboxOutlineRequestPayload,
    ): Promise<BookOutlineDto | null> {
      this.applying = true;
      this.error = null;
      this.errorCode = null;
      try {
        return await toolboxApi.applyOutline(runId, payload);
      } catch (error) {
        this.error = describeError(error);
        this.errorCode = isApiClientError(error) ? error.code : null;
        return null;
      } finally {
        this.applying = false;
      }
    },

    /* ------------------------------------------------------------------ */
    /*                                内部                                */
    /* ------------------------------------------------------------------ */

    /** 同步历史列表中的对应摘要（不存在时按创建时间插入头部）。 */
    upsertRunSummary(summary: ToolboxRunSummary): void {
      const exists = this.runs.some((run) => run.id === summary.id);
      if (exists) {
        this.runs = this.runs.map((run) => (run.id === summary.id ? summary : run));
        return;
      }
      this.runs = [summary, ...this.runs];
      this.totalRuns += 1;
    },
  },
});
