import type {
  BookOutlineDto,
  KnowledgeCardDto,
  ToolboxRunDetail,
  ToolboxRunSummary,
} from '@fanxiaoshuo/shared';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/toolbox', () => ({
  toolboxApi: {
    listTools: vi.fn(),
    listRuns: vi.fn(),
    runTool: vi.fn(),
    getRun: vi.fn(),
    deleteRun: vi.fn(),
    applyCard: vi.fn(),
    applyOutline: vi.fn(),
  },
}));

import { ApiClientError } from '@/api/errors';
import { toolboxApi } from '@/api/toolbox';
import { createFallbackTools, useToolboxStore } from '@/stores/toolbox';

const RUN_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const BOOK_ID = 'bbbbbbbb-1111-4111-8111-111111111111';
const CARD_ID = 'cccccccc-1111-4111-8111-111111111111';
const NOW = '2024-05-01T10:00:00.000Z';

function makeDetail(overrides: Partial<ToolboxRunDetail> = {}): ToolboxRunDetail {
  return {
    id: RUN_ID,
    toolId: 'character-designer',
    toolName: '立体人物卡生成',
    bookId: BOOK_ID,
    role: 'lorekeeper',
    status: 'completed',
    overview: '围绕主角弧光给出两张可直接入册的人物卡。',
    itemCount: 1,
    modelRef: 'mock-endpoint/gpt-4o-mini',
    inputTokens: 128,
    outputTokens: 512,
    estimatedCostUsd: 0.0012,
    latencyMs: 2_400,
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    inputs: { rolePosition: '主角', archetype: '落魄医修', count: 1 },
    output: {
      overview: '围绕主角弧光给出两张可直接入册的人物卡。',
      items: [
        {
          title: '沈砚',
          summary: '被逐出师门的落魄医修，靠残卷翻盘。',
          content: '沈砚，二十四岁，曾为太医署最年轻的医官……',
          aliases: ['小砚'],
          tags: ['主角', '医修'],
          suggestedCardCategory: 'character',
        },
      ],
    },
    ...overrides,
  };
}

function toSummary(detail: ToolboxRunDetail): ToolboxRunSummary {
  const { inputs, output, ...summary } = detail;
  void inputs;
  void output;
  return summary;
}

function makeCard(): KnowledgeCardDto {
  return {
    id: CARD_ID,
    bookId: BOOK_ID,
    category: 'character',
    title: '沈砚',
    summary: '被逐出师门的落魄医修。',
    content: '沈砚，二十四岁……',
    aliases: ['小砚'],
    tags: ['主角'],
    pinned: true,
    sortOrder: 0,
    hasEmbedding: false,
    embeddingModelRef: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeOutline(): BookOutlineDto {
  return {
    bookId: BOOK_ID,
    mainPlot: '沈砚逆袭主线',
    worldSetting: '',
    styleGuide: '',
    endingPlan: '',
    updatedAt: NOW,
  };
}

function mockHistory(items: ToolboxRunSummary[] = [], total = items.length): void {
  vi.mocked(toolboxApi.listRuns).mockResolvedValue({
    items,
    total,
    page: 1,
    pageSize: 20,
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(toolboxApi.listTools).mockResolvedValue({ tools: createFallbackTools() });
  vi.mocked(toolboxApi.deleteRun).mockResolvedValue(undefined);
  mockHistory();
});

describe('创作工具盒 Store', () => {
  it('加载 6 个内置工具目录，并按工具字段默认值初始化表单', async () => {
    const store = useToolboxStore();

    await store.loadTools();

    expect(store.tools).toHaveLength(6);
    expect(store.toolsError).toBeNull();
    expect(store.toolGroups.map((group) => group.category)).toEqual([
      'planning',
      'worldbuilding',
      'drafting',
    ]);
    expect(store.selectedToolId).toBe('book-pitch');
    // 书名与简介策划：下拉默认取「男频爽文」，数量默认 3
    expect(store.formInputs.audience).toBe('男频爽文');
    expect(store.formInputs.count).toBe(3);
    expect(store.currentRole).toBe('showrunner');

    store.selectTool('character-designer');

    expect(store.selectedTool?.name).toBe('立体人物卡生成');
    expect(store.currentRole).toBe('lorekeeper');
    // 切换工具后表单按该工具字段默认值重建（未定义默认值的字段为空串）
    expect(store.formInputs).toEqual({
      rolePosition: '主角',
      archetype: '',
      backgroundHint: '',
      count: 1,
    });
    expect(store.activeRun).toBeNull();
  });

  it('工具目录加载失败时回退到共享冻结目录', async () => {
    const store = useToolboxStore();
    vi.mocked(toolboxApi.listTools).mockRejectedValue(
      new ApiClientError('无法连接后端服务', { code: 'NETWORK_ERROR', status: 0 }),
    );

    await store.loadTools();

    expect(store.tools).toHaveLength(6);
    expect(store.toolsError).toContain('无法连接后端服务');
  });

  it('前端即时校验拦截空必填项与越界数量，不发起模型调用', async () => {
    const store = useToolboxStore();
    store.selectTool('book-pitch');

    const blocked = await store.executeCurrentTool();

    expect(blocked).toBeNull();
    expect(store.errorCode).toBe('VALIDATION_ERROR');
    expect(store.fieldErrors.genre).toBeDefined();
    expect(store.fieldErrors.coreHook).toBeDefined();
    expect(toolboxApi.runTool).not.toHaveBeenCalled();

    store.setFormInput('genre', '都市异能');
    store.setFormInput('coreHook', '主角能读取死者最后一分钟的记忆');
    store.setFormInput('count', 99);

    expect(await store.executeCurrentTool()).toBeNull();
    expect(store.error).toContain('不能大于 5');
    expect(toolboxApi.runTool).not.toHaveBeenCalled();
  });

  it('执行成功后写入 activeRun 并刷新历史列表', async () => {
    const store = useToolboxStore();
    const detail = makeDetail();
    vi.mocked(toolboxApi.runTool).mockResolvedValue(detail);
    mockHistory([toSummary(detail)], 1);

    store.selectTool('character-designer');
    store.setBookContext(BOOK_ID);
    store.setFormInput('archetype', '落魄医修');

    const run = await store.executeCurrentTool();

    expect(run).toEqual(detail);
    expect(store.running).toBe(false);
    expect(store.error).toBeNull();
    expect(store.activeRun).toEqual(detail);
    expect(toolboxApi.runTool).toHaveBeenCalledWith({
      toolId: 'character-designer',
      bookId: BOOK_ID,
      inputs: { rolePosition: '主角', archetype: '落魄医修', count: 1 },
    });
    expect(toolboxApi.listRuns).toHaveBeenCalledTimes(1);
    expect(store.runs).toHaveLength(1);
    expect(store.totalRuns).toBe(1);
    expect(store.page).toBe(1);
  });

  it('角色未绑定模型时把 409 错误收敛到状态并标记需配置模型', async () => {
    const store = useToolboxStore();
    vi.mocked(toolboxApi.runTool).mockRejectedValue(
      new ApiClientError('总编策划尚未绑定可用模型', {
        code: 'AGENT_ROLE_UNBOUND',
        status: 409,
      }),
    );

    store.selectTool('book-pitch');
    store.setFormInput('genre', '古典仙侠');
    store.setFormInput('coreHook', '主角以残破剑冢重铸剑域');

    const run = await store.executeCurrentTool();

    expect(run).toBeNull();
    expect(store.running).toBe(false);
    expect(store.error).toContain('总编策划尚未绑定可用模型');
    expect(store.errorCode).toBe('AGENT_ROLE_UNBOUND');
    expect(store.needsModelSetup).toBe(true);
    expect(store.activeRun).toBeNull();
    // 失败时仍会静默刷新一次历史（服务端会落盘 failed 记录）
    expect(toolboxApi.listRuns).toHaveBeenCalledTimes(1);
  });

  it('上游限流错误同样收敛为可展示的错误码', async () => {
    const store = useToolboxStore();
    vi.mocked(toolboxApi.runTool).mockRejectedValue(
      new ApiClientError('上游服务限流，请稍后重试', {
        code: 'UPSTREAM_RATE_LIMIT',
        status: 429,
      }),
    );

    store.selectTool('book-pitch');
    store.setFormInput('genre', '无限流悬疑');
    store.setFormInput('coreHook', '每层副本都在重演同一场谋杀');

    expect(await store.executeCurrentTool()).toBeNull();
    expect(store.errorCode).toBe('UPSTREAM_RATE_LIMIT');
    expect(store.needsModelSetup).toBe(false);
  });

  it('支持回看历史运行并同步工具、表单与结果卡片', async () => {
    const store = useToolboxStore();
    const detail = makeDetail();
    vi.mocked(toolboxApi.getRun).mockResolvedValue(detail);
    mockHistory([toSummary(detail)], 1);

    await store.loadHistory();
    expect(store.runs).toHaveLength(1);

    const viewed = await store.openHistoryRun(RUN_ID);

    expect(viewed).toEqual(detail);
    expect(store.detailLoading).toBe(false);
    expect(store.activeRun).toEqual(detail);
    expect(store.selectedToolId).toBe('character-designer');
    expect(store.formInputs.rolePosition).toBe('主角');
    expect(store.formInputs.archetype).toBe('落魄医修');
    // 归一化输入未包含的字段回退到工具默认值
    expect(store.formInputs.backgroundHint).toBe('');
  });

  it('删除历史记录会清理列表与当前结果，但不影响已回写数据', async () => {
    const store = useToolboxStore();
    const detail = makeDetail();
    vi.mocked(toolboxApi.getRun).mockResolvedValue(detail);
    mockHistory([toSummary(detail)], 1);

    await store.loadHistory();
    await store.openHistoryRun(RUN_ID);

    const removed = await store.deleteHistoryRun(RUN_ID);

    expect(removed).toBe(true);
    expect(toolboxApi.deleteRun).toHaveBeenCalledWith(RUN_ID);
    expect(store.runs).toHaveLength(0);
    expect(store.totalRuns).toBe(0);
    expect(store.activeRun).toBeNull();
    expect(store.deletingRunId).toBeNull();
  });

  it('一键回写设定卡与全书总大纲，失败时收敛错误', async () => {
    const store = useToolboxStore();
    const card = makeCard();
    const outline = makeOutline();
    vi.mocked(toolboxApi.applyCard).mockResolvedValue(card);
    vi.mocked(toolboxApi.applyOutline).mockResolvedValue(outline);

    const cardResult = await store.applyItemToCard(RUN_ID, {
      bookId: BOOK_ID,
      itemIndex: 0,
      category: 'character',
      title: '沈砚',
      pinned: true,
    });

    expect(cardResult).toEqual(card);
    expect(toolboxApi.applyCard).toHaveBeenCalledWith(RUN_ID, {
      bookId: BOOK_ID,
      itemIndex: 0,
      category: 'character',
      title: '沈砚',
      pinned: true,
    });
    expect(store.applying).toBe(false);

    const outlineResult = await store.applyItemToOutline(RUN_ID, {
      bookId: BOOK_ID,
      itemIndex: 0,
      field: 'mainPlot',
      mode: 'append',
    });

    expect(outlineResult).toEqual(outline);
    expect(toolboxApi.applyOutline).toHaveBeenCalledWith(RUN_ID, {
      bookId: BOOK_ID,
      itemIndex: 0,
      field: 'mainPlot',
      mode: 'append',
    });

    vi.mocked(toolboxApi.applyCard).mockRejectedValue(
      new ApiClientError('条目索引越界', { code: 'TOOLBOX_ITEM_OUT_OF_RANGE', status: 400 }),
    );

    expect(
      await store.applyItemToCard(RUN_ID, { bookId: BOOK_ID, itemIndex: 3 }),
    ).toBeNull();
    expect(store.errorCode).toBe('TOOLBOX_ITEM_OUT_OF_RANGE');
    expect(store.applying).toBe(false);
  });

  it('按工具与作品筛选历史时把筛选条件透传给接口', async () => {
    const store = useToolboxStore();

    store.setHistoryToolFilter('plot-hook-brainstorm');
    store.setHistoryBookFilter(BOOK_ID);
    await store.loadHistory();

    expect(toolboxApi.listRuns).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      toolId: 'plot-hook-brainstorm',
      bookId: BOOK_ID,
    });
  });
});
