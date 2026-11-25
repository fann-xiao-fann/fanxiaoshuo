import type {
  ApiError,
  BookOutlineDto,
  BookDto,
  KnowledgeCardDto,
  KnowledgeCardListResponse,
  ToolboxRunDetail,
  ToolboxRunListResponse,
  ToolboxToolsResponse,
  UsageLogsResponse,
} from '@fanxiaoshuo/shared';
import { ModelGateway } from '@fanxiaoshuo/agents';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInMemoryStore,
  createTestServer,
  type InMemoryStore,
  type TestServerContext,
} from './helpers/in-memory.js';
import {
  bindRole,
  seedProviderAndModel,
  TEST_PROVIDER_API_KEY,
} from './helpers/ai-fixtures.js';
import { createBook } from './helpers/book-fixtures.js';

/* -------------------------------------------------------------------------- */
/*                                  Mock 模型                                  */
/* -------------------------------------------------------------------------- */

function mockUsage() {
  return {
    inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 500, text: 500, reasoning: 0 },
  };
}

/** 超长（118 字）但合法的结果条目标题，用于验证回写设定卡时的安全截断。 */
const LONG_TITLE = '深'.repeat(118);

/** 人物卡工具的标准 JSON 产出（含 2 条可直接回写的条目）。 */
const CHARACTER_OUTPUT = {
  overview: '围绕落魄医修设计两位核心人物，覆盖主角与反派。',
  items: [
    {
      title: '沈砚',
      summary: '背负血仇的落魄医修',
      content: '沈砚出身药王谷，一夜灭门后以游医身份潜行江湖，靠一手毒理反杀仇敌。',
      aliases: ['小砚', '沈医修'],
      tags: ['医修', '复仇'],
      suggestedCardCategory: 'character',
    },
    {
      title: LONG_TITLE,
      summary: '与主角同源的镜像反派',
      content: '同为药王谷遗孤，却选择以毒术掌控江湖。',
      aliases: [],
      tags: ['反派'],
      suggestedCardCategory: 'character',
    },
  ],
};

/** 书名简介工具的标准 JSON 产出（用于大纲回写）。 */
const PITCH_OUTPUT = {
  overview: '三套差异化立项方案，围绕药修复仇主线展开。',
  items: [
    {
      title: '药王遗孤',
      summary: '一本毒经，半部江湖',
      content: '灭门之夜他吞下师父留下的毒经，从此以毒证道。',
      aliases: ['毒经'],
      tags: ['古典仙侠', '复仇'],
      suggestedCardCategory: 'world',
    },
  ],
};

function createJsonModel(
  payload: unknown,
  onPrompt?: (prompt: string) => void,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doGenerate: async (options) => {
      onPrompt?.(JSON.stringify(options.prompt));
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        finishReason: { unified: 'stop', raw: 'stop' } as const,
        usage: mockUsage(),
        warnings: [],
      };
    },
  });
}

/** 上游鉴权失败模型（错误文本故意夹带明文 Key，用于验证脱敏）。 */
function createAuthFailureModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doGenerate: async () => {
      throw Object.assign(new Error(`Unauthorized: Bearer ${TEST_PROVIDER_API_KEY}`), {
        statusCode: 401,
      });
    },
  });
}

/** 上游限流模型。 */
function createRateLimitModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doGenerate: async () => {
      throw Object.assign(new Error('Rate limit exceeded, please retry later.'), {
        statusCode: 429,
      });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*                                 测试脚手架                                  */
/* -------------------------------------------------------------------------- */

interface ToolboxContext {
  readonly context: TestServerContext;
  readonly store: InMemoryStore;
}

async function createToolboxContext(model: MockLanguageModelV4): Promise<ToolboxContext> {
  const store = createInMemoryStore();
  const gateway = new ModelGateway({
    createLanguageModel: () => model,
    usageLogger: async (record) => {
      await store.usageLogs.insert(record);
    },
  });
  const context = await createTestServer({ store, gateway });
  return { context, store };
}

/** 绑定全部 4 个写书角色到同一模型（工具默认角色各不相同）。 */
async function seedAllRoles(context: TestServerContext): Promise<string> {
  const seeded = await seedProviderAndModel(context);
  for (const role of ['showrunner', 'lorekeeper', 'writer', 'critic'] as const) {
    await bindRole(context, role, seeded.modelId);
  }
  return seeded.modelRef;
}

let active: { app: TestServerContext['app'] } | null = null;

afterEach(async () => {
  if (active) {
    await active.app.close();
    active = null;
  }
});

async function bootstrap(model: MockLanguageModelV4): Promise<ToolboxContext> {
  const toolboxContext = await createToolboxContext(model);
  active = { app: toolboxContext.context.app };
  return toolboxContext;
}

/** 直接通过仓储读取运行历史（与 HTTP 断言互相印证）。 */
function runRecords(store: InMemoryStore) {
  return [...store.state.toolboxRuns.values()];
}

function usageLogs(store: InMemoryStore) {
  return store.state.logs;
}

/* -------------------------------------------------------------------------- */
/*                                工具目录与校验                                */
/* -------------------------------------------------------------------------- */

describe('创作工具盒 · 工具目录与输入校验', () => {
  it('GET /toolbox/tools 返回全部 6 个内置工具与动态表单字段', async () => {
    const { context } = await bootstrap(createJsonModel(CHARACTER_OUTPUT));

    const response = await context.app.inject({ method: 'GET', url: '/api/v1/toolbox/tools' });

    expect(response.statusCode).toBe(200);
    const body = response.json<ToolboxToolsResponse>();
    expect(body.tools).toHaveLength(6);
    expect(body.tools.map((tool) => tool.id)).toEqual([
      'book-pitch',
      'character-designer',
      'world-faction-builder',
      'golden-finger-designer',
      'plot-hook-brainstorm',
      'text-polish-diagnose',
    ]);

    const character = body.tools.find((tool) => tool.id === 'character-designer');
    expect(character?.name).toBe('立体人物卡生成');
    expect(character?.defaultRole).toBe('lorekeeper');
    expect(character?.applyTargets).toEqual(['knowledge_card']);
    expect(character?.fields.map((field) => field.key)).toContain('archetype');

    const categoryCount = new Set(body.tools.map((tool) => tool.category));
    expect([...categoryCount].sort()).toEqual(['drafting', 'planning', 'worldbuilding']);
  });

  it('未知 toolId 返回 404 TOOLBOX_TOOL_NOT_FOUND 且不产生历史记录', async () => {
    const { context, store } = await bootstrap(createJsonModel(CHARACTER_OUTPUT));
    await seedAllRoles(context);

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: { toolId: 'unknown-tool', inputs: {} },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<ApiError>().code).toBe('TOOLBOX_TOOL_NOT_FOUND');
    expect(runRecords(store)).toHaveLength(0);
    expect(usageLogs(store)).toHaveLength(0);
  });

  it('缺少必填字段返回 400 VALIDATION_ERROR（携带 details）且不落库', async () => {
    const { context, store } = await bootstrap(createJsonModel(CHARACTER_OUTPUT));
    await seedAllRoles(context);

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: { toolId: 'character-designer', inputs: { rolePosition: '主角' } },
    });

    expect(response.statusCode).toBe(400);
    const error = response.json<ApiError>();
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details?.some((issue) => issue.path === 'inputs.archetype')).toBe(true);
    expect(runRecords(store)).toHaveLength(0);
    expect(usageLogs(store)).toHaveLength(0);
  });

  it('目标角色未绑定模型时返回 409 AGENT_ROLE_UNBOUND 且不落库', async () => {
    const { context, store } = await bootstrap(createJsonModel(CHARACTER_OUTPUT));

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: {
        toolId: 'character-designer',
        inputs: { rolePosition: '主角', archetype: '落魄医修' },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<ApiError>().code).toBe('AGENT_ROLE_UNBOUND');
    expect(runRecords(store)).toHaveLength(0);
    expect(usageLogs(store)).toHaveLength(0);
  });

  it('关联书籍不存在时执行返回 404 BOOK_NOT_FOUND 且不落库', async () => {
    const { context, store } = await bootstrap(createJsonModel(CHARACTER_OUTPUT));
    await seedAllRoles(context);

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: {
        toolId: 'character-designer',
        bookId: '11111111-1111-4111-8111-111111111111',
        inputs: { rolePosition: '主角', archetype: '落魄医修' },
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<ApiError>().code).toBe('BOOK_NOT_FOUND');
    expect(runRecords(store)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                          同步执行与 Book Bible 注入                          */
/* -------------------------------------------------------------------------- */

describe('创作工具盒 · 同步执行与计量落盘', () => {
  it('关联作品执行人物卡工具：注入 Book Bible 上下文、落盘 toolbox-run 用量并返回 201 详情', async () => {
    const prompts: string[] = [];
    const { context, store } = await bootstrap(
      createJsonModel(CHARACTER_OUTPUT, (prompt) => prompts.push(prompt)),
    );
    const modelRef = await seedAllRoles(context);

    const book = await createBook(context.app, {
      title: '长夜行舟',
      genre: '古典仙侠',
      synopsis: '灭门遗孤以毒证道。',
    });
    await context.app.inject({
      method: 'PUT',
      url: `/api/v1/books/${book.id}/outline`,
      payload: {
        mainPlot: '沈砚复仇主线',
        worldSetting: '药王谷与毒宗对立的江湖',
        styleGuide: '冷峻克制',
        endingPlan: '以毒止杀',
      },
    });
    await context.app.inject({
      method: 'POST',
      url: `/api/v1/books/${book.id}/cards`,
      payload: {
        category: 'faction',
        title: '药王谷',
        summary: '主角师门，已覆灭',
        content: '药王谷以医毒双修闻名。',
        pinned: true,
      },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: {
        toolId: 'character-designer',
        bookId: book.id,
        inputs: { rolePosition: '主角', archetype: '落魄医修', count: 2 },
      },
    });

    expect(response.statusCode).toBe(201);
    const detail = response.json<ToolboxRunDetail>();
    expect(detail.toolId).toBe('character-designer');
    expect(detail.toolName).toBe('立体人物卡生成');
    expect(detail.bookId).toBe(book.id);
    expect(detail.role).toBe('lorekeeper');
    expect(detail.status).toBe('completed');
    expect(detail.overview).toBe(CHARACTER_OUTPUT.overview);
    expect(detail.itemCount).toBe(2);
    expect(detail.output?.items[0]?.title).toBe('沈砚');
    expect(detail.inputs).toMatchObject({ rolePosition: '主角', archetype: '落魄医修', count: 2 });
    expect(detail.modelRef).toBe(modelRef);
    expect(detail.inputTokens).toBe(1000);
    expect(detail.outputTokens).toBe(500);
    expect(detail.estimatedCostUsd).toBeGreaterThan(0);
    expect(detail.errorCode).toBeNull();

    // Book Bible 上下文已注入 Prompt（作品名 / 总大纲 / 置顶设定卡）。
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('长夜行舟');
    expect(prompts[0]).toContain('沈砚复仇主线');
    expect(prompts[0]).toContain('药王谷');

    // 用量日志以 `toolbox-run` 场景落盘。
    const logs = usageLogs(store);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.scene).toBe('toolbox-run');
    expect(logs[0]?.status).toBe('success');
    expect(logs[0]?.inputTokens).toBe(1000);

    const usageResponse = await context.app.inject({
      method: 'GET',
      url: '/api/v1/usage-logs?scene=toolbox-run',
    });
    expect(usageResponse.statusCode).toBe(200);
    expect(usageResponse.json<UsageLogsResponse>().items).toHaveLength(1);

    // 历史记录持久化完整详情。
    const stored = runRecords(store);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('completed');
    expect(stored[0]?.bookId).toBe(book.id);
  });

  it('上游鉴权失败：写入脱敏 failed 历史并返回 502，响应与历史均不含明文 Key', async () => {
    const { context, store } = await bootstrap(createAuthFailureModel());
    await seedAllRoles(context);

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: { toolId: 'text-polish-diagnose', inputs: { excerpt: '夜风穿城而过。', focus: '综合诊断与节奏' } },
    });

    expect(response.statusCode).toBe(502);
    const error = response.json<ApiError>();
    expect(error.code).toBe('UPSTREAM_AUTH_ERROR');
    expect(response.body).not.toContain(TEST_PROVIDER_API_KEY);

    const stored = runRecords(store);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('failed');
    expect(stored[0]?.output).toBeNull();
    expect(stored[0]?.errorCode).toBe('UPSTREAM_AUTH_ERROR');
    expect(stored[0]?.errorMessage ?? '').not.toContain(TEST_PROVIDER_API_KEY);
    expect(JSON.stringify(stored[0])).not.toContain(TEST_PROVIDER_API_KEY);

    // 失败也经统一网关落盘 `toolbox-run` 用量日志（error 状态）。
    const logs = usageLogs(store);
    expect(logs.map((log) => log.status)).toEqual(['error']);
    expect(logs[0]?.scene).toBe('toolbox-run');
  });

  it('上游限流失败：返回 429 并保留 failed 历史', async () => {
    const { context, store } = await bootstrap(createRateLimitModel());
    await seedAllRoles(context);

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: { toolId: 'plot-hook-brainstorm', inputs: { currentSituation: '主角初入宗门', conflictType: '危机升级' } },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json<ApiError>().code).toBe('UPSTREAM_RATE_LIMIT');
    expect(runRecords(store)).toHaveLength(1);
    expect(runRecords(store)[0]?.status).toBe('failed');
  });
});

/* -------------------------------------------------------------------------- */
/*                              历史列表与删除                                 */
/* -------------------------------------------------------------------------- */

describe('创作工具盒 · 历史列表、详情与删除', () => {
  it('历史列表支持分页与 toolId / bookId / status 筛选，详情可回看', async () => {
    const { context } = await bootstrap(createJsonModel(CHARACTER_OUTPUT));
    await seedAllRoles(context);
    const book = await createBook(context.app, { title: '长夜行舟' });

    const first = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: {
        toolId: 'character-designer',
        bookId: book.id,
        inputs: { rolePosition: '主角', archetype: '落魄医修' },
      },
    });
    expect(first.statusCode).toBe(201);

    const second = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: { toolId: 'plot-hook-brainstorm', inputs: { currentSituation: '主角初入宗门', conflictType: '危机升级' } },
    });
    expect(second.statusCode).toBe(201);

    const third = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: { toolId: 'text-polish-diagnose', inputs: { excerpt: '夜风穿城而过。', focus: '综合诊断与节奏' } },
    });
    expect(third.statusCode).toBe(201);

    const listResponse = await context.app.inject({
      method: 'GET',
      url: '/api/v1/toolbox/runs?page=1&pageSize=2',
    });
    expect(listResponse.statusCode).toBe(200);
    const list = listResponse.json<ToolboxRunListResponse>();
    expect(list.total).toBe(3);
    expect(list.page).toBe(1);
    expect(list.pageSize).toBe(2);
    expect(list.items).toHaveLength(2);
    // 倒序：最后创建的 text-polish-diagnose 在最前。
    expect(list.items[0]?.toolId).toBe('text-polish-diagnose');
    expect(list.items[0]?.toolName).toBe('片段文本质检与润色建议');
    expect(list.items[0]?.itemCount).toBe(2);
    expect(list.items[0]?.overview).toBe(CHARACTER_OUTPUT.overview);

    const secondPage = await context.app.inject({
      method: 'GET',
      url: '/api/v1/toolbox/runs?page=2&pageSize=2',
    });
    expect(secondPage.json<ToolboxRunListResponse>().items).toHaveLength(1);

    const byTool = await context.app.inject({
      method: 'GET',
      url: '/api/v1/toolbox/runs?toolId=plot-hook-brainstorm',
    });
    const byToolBody = byTool.json<ToolboxRunListResponse>();
    expect(byToolBody.total).toBe(1);
    expect(byToolBody.items[0]?.toolId).toBe('plot-hook-brainstorm');

    const byBook = await context.app.inject({
      method: 'GET',
      url: `/api/v1/toolbox/runs?bookId=${book.id}`,
    });
    expect(byBook.json<ToolboxRunListResponse>().total).toBe(1);

    const byStatus = await context.app.inject({
      method: 'GET',
      url: '/api/v1/toolbox/runs?status=failed',
    });
    expect(byStatus.json<ToolboxRunListResponse>().total).toBe(0);

    const detailId = list.items[0]?.id ?? '';
    const detailResponse = await context.app.inject({
      method: 'GET',
      url: `/api/v1/toolbox/runs/${detailId}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json<ToolboxRunDetail>();
    expect(detail.id).toBe(detailId);
    expect(detail.inputs['excerpt']).toBe('夜风穿城而过。');
    expect(detail.output?.items).toHaveLength(2);

    const missing = await context.app.inject({
      method: 'GET',
      url: '/api/v1/toolbox/runs/11111111-1111-4111-8111-111111111111',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiError>().code).toBe('TOOLBOX_RUN_NOT_FOUND');
  });

  it('删除历史返回 204 且不影响已保存的设定卡', async () => {
    const { context, store } = await bootstrap(createJsonModel(CHARACTER_OUTPUT));
    await seedAllRoles(context);
    const book = await createBook(context.app, { title: '长夜行舟' });

    const runResponse = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: {
        toolId: 'character-designer',
        bookId: book.id,
        inputs: { rolePosition: '主角', archetype: '落魄医修' },
      },
    });
    const run = runResponse.json<ToolboxRunDetail>();

    const applyResponse = await context.app.inject({
      method: 'POST',
      url: `/api/v1/toolbox/runs/${run.id}/apply-card`,
      payload: { bookId: book.id, itemIndex: 0 },
    });
    expect(applyResponse.statusCode).toBe(201);

    const deleteResponse = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/toolbox/runs/${run.id}`,
    });
    expect(deleteResponse.statusCode).toBe(204);
    expect(runRecords(store).some((record) => record.id === run.id)).toBe(false);

    const gone = await context.app.inject({
      method: 'GET',
      url: `/api/v1/toolbox/runs/${run.id}`,
    });
    expect(gone.statusCode).toBe(404);

    const cardsResponse = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/cards`,
    });
    const cards = cardsResponse.json<KnowledgeCardListResponse>();
    expect(cards.total).toBe(1);
    expect(cards.items[0]?.title).toBe('沈砚');

    const deleteAgain = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/toolbox/runs/${run.id}`,
    });
    expect(deleteAgain.statusCode).toBe(404);
    expect(deleteAgain.json<ApiError>().code).toBe('TOOLBOX_RUN_NOT_FOUND');
  });
});

/* -------------------------------------------------------------------------- */
/*                                一键回写                                     */
/* -------------------------------------------------------------------------- */

describe('创作工具盒 · 一键回写 Book Bible', () => {
  it('apply-card 支持自定义分类 / 置顶与超长标题安全截断，并可在设定卡列表查到', async () => {
    const { context } = await bootstrap(createJsonModel(CHARACTER_OUTPUT));
    await seedAllRoles(context);
    const book = await createBook(context.app, { title: '长夜行舟' });

    const runResponse = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: {
        toolId: 'character-designer',
        bookId: book.id,
        inputs: { rolePosition: '主角', archetype: '落魄医修' },
      },
    });
    const run = runResponse.json<ToolboxRunDetail>();

    const overridden = await context.app.inject({
      method: 'POST',
      url: `/api/v1/toolbox/runs/${run.id}/apply-card`,
      payload: { bookId: book.id, itemIndex: 0, category: 'faction', pinned: true },
    });
    expect(overridden.statusCode).toBe(201);
    const overriddenCard = overridden.json<KnowledgeCardDto>();
    expect(overriddenCard.category).toBe('faction');
    expect(overriddenCard.pinned).toBe(true);
    expect(overriddenCard.title).toBe('沈砚');
    expect(overriddenCard.summary).toBe('背负血仇的落魄医修');
    expect(overriddenCard.aliases).toEqual(['小砚', '沈医修']);
    expect(overriddenCard.tags).toEqual(['医修', '复仇']);
    expect(overriddenCard.bookId).toBe(book.id);

    // 超长标题（118 字）必须安全截断为 100 字而不是整条失败。
    const truncated = await context.app.inject({
      method: 'POST',
      url: `/api/v1/toolbox/runs/${run.id}/apply-card`,
      payload: { bookId: book.id, itemIndex: 1, title: `${LONG_TITLE}（自定义后缀）` },
    });
    expect(truncated.statusCode).toBe(201);
    expect(truncated.json<KnowledgeCardDto>().title).toHaveLength(100);

    const cardsResponse = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/cards`,
    });
    const cards = cardsResponse.json<KnowledgeCardListResponse>();
    expect(cards.total).toBe(2);
    expect(cards.items[0]?.pinned).toBe(true);
  });

  it('apply-outline 的 append 保留原内容与其余 3 个字段，replace 直接覆盖', async () => {
    const { context } = await bootstrap(createJsonModel(PITCH_OUTPUT));
    await seedAllRoles(context);
    const book = await createBook(context.app, { title: '长夜行舟' });

    await context.app.inject({
      method: 'PUT',
      url: `/api/v1/books/${book.id}/outline`,
      payload: {
        mainPlot: '原有主线',
        worldSetting: '原有世界观',
        styleGuide: '原有文风',
        endingPlan: '原有结局',
      },
    });

    const runResponse = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: {
        toolId: 'book-pitch',
        bookId: book.id,
        inputs: { genre: '古典仙侠', coreHook: '药修复仇', audience: '男频爽文' },
      },
    });
    expect(runResponse.statusCode).toBe(201);
    const run = runResponse.json<ToolboxRunDetail>();

    const appendResponse = await context.app.inject({
      method: 'POST',
      url: `/api/v1/toolbox/runs/${run.id}/apply-outline`,
      payload: { bookId: book.id, itemIndex: 0, field: 'mainPlot', mode: 'append' },
    });
    expect(appendResponse.statusCode).toBe(200);
    const appended = appendResponse.json<BookOutlineDto>();
    expect(appended.mainPlot.startsWith('原有主线')).toBe(true);
    expect(appended.mainPlot).toContain('【药王遗孤】');
    expect(appended.mainPlot).toContain('一本毒经，半部江湖');
    expect(appended.mainPlot).toContain('\n\n');
    // 其余 3 个字段原样保留。
    expect(appended.worldSetting).toBe('原有世界观');
    expect(appended.styleGuide).toBe('原有文风');
    expect(appended.endingPlan).toBe('原有结局');

    const replaceResponse = await context.app.inject({
      method: 'POST',
      url: `/api/v1/toolbox/runs/${run.id}/apply-outline`,
      payload: { bookId: book.id, itemIndex: 0, field: 'mainPlot', mode: 'replace' },
    });
    expect(replaceResponse.statusCode).toBe(200);
    const replaced = replaceResponse.json<BookOutlineDto>();
    expect(replaced.mainPlot).not.toContain('原有主线');
    expect(replaced.mainPlot).toBe(appended.mainPlot.split('\n\n').slice(1).join('\n\n'));
    expect(replaced.worldSetting).toBe('原有世界观');

    const missingOutlineBook = await createBook(context.app, { title: '无大纲新书' });
    const freshResponse = await context.app.inject({
      method: 'POST',
      url: `/api/v1/toolbox/runs/${run.id}/apply-outline`,
      payload: {
        bookId: missingOutlineBook.id,
        itemIndex: 0,
        field: 'worldSetting',
        mode: 'append',
      },
    });
    expect(freshResponse.statusCode).toBe(200);
    const fresh = freshResponse.json<BookOutlineDto>();
    expect(fresh.worldSetting.startsWith('【药王遗孤】')).toBe(true);
    expect(fresh.mainPlot).toBe('');
    expect(fresh.styleGuide).toBe('');
  });

  it('失败运行或越界 itemIndex 回写返回 400 TOOLBOX_ITEM_OUT_OF_RANGE', async () => {
    const { context } = await bootstrap(createAuthFailureModel());
    await seedAllRoles(context);
    const book = await createBook(context.app, { title: '长夜行舟' });

    const failedRun = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: {
        toolId: 'character-designer',
        bookId: book.id,
        inputs: { rolePosition: '主角', archetype: '落魄医修' },
      },
    });
    expect(failedRun.statusCode).toBe(502);

    const failedList = await context.app.inject({
      method: 'GET',
      url: '/api/v1/toolbox/runs?status=failed',
    });
    const failedId = failedList.json<ToolboxRunListResponse>().items[0]?.id ?? '';

    const onFailed = await context.app.inject({
      method: 'POST',
      url: `/api/v1/toolbox/runs/${failedId}/apply-card`,
      payload: { bookId: book.id, itemIndex: 0 },
    });
    expect(onFailed.statusCode).toBe(400);
    expect(onFailed.json<ApiError>().code).toBe('TOOLBOX_ITEM_OUT_OF_RANGE');

    const onFailedOutline = await context.app.inject({
      method: 'POST',
      url: `/api/v1/toolbox/runs/${failedId}/apply-outline`,
      payload: { bookId: book.id, itemIndex: 0, field: 'mainPlot', mode: 'append' },
    });
    expect(onFailedOutline.statusCode).toBe(400);
    expect(onFailedOutline.json<ApiError>().code).toBe('TOOLBOX_ITEM_OUT_OF_RANGE');
  });

  it('已完成运行但 itemIndex 越界返回 400 TOOLBOX_ITEM_OUT_OF_RANGE', async () => {
    const { context } = await bootstrap(createJsonModel(CHARACTER_OUTPUT));
    await seedAllRoles(context);
    const book = await createBook(context.app, { title: '长夜行舟' });

    const runResponse = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: {
        toolId: 'character-designer',
        bookId: book.id,
        inputs: { rolePosition: '主角', archetype: '落魄医修' },
      },
    });
    const run = runResponse.json<ToolboxRunDetail>();

    const outOfRange = await context.app.inject({
      method: 'POST',
      url: `/api/v1/toolbox/runs/${run.id}/apply-card`,
      payload: { bookId: book.id, itemIndex: 5 },
    });
    expect(outOfRange.statusCode).toBe(400);
    expect(outOfRange.json<ApiError>().code).toBe('TOOLBOX_ITEM_OUT_OF_RANGE');

    const missingRun = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs/11111111-1111-4111-8111-111111111111/apply-card',
      payload: { bookId: book.id, itemIndex: 0 },
    });
    expect(missingRun.statusCode).toBe(404);
    expect(missingRun.json<ApiError>().code).toBe('TOOLBOX_RUN_NOT_FOUND');
  });
});

/* -------------------------------------------------------------------------- */
/*                              书籍引用与删书行为                              */
/* -------------------------------------------------------------------------- */

describe('创作工具盒 · 书籍关联约束', () => {
  it('关联到回收站书籍执行返回 404，回写目标书籍非活跃同样拒绝', async () => {
    const { context } = await bootstrap(createJsonModel(CHARACTER_OUTPUT));
    await seedAllRoles(context);
    const book: BookDto = await createBook(context.app, { title: '长夜行舟' });

    const runResponse = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: {
        toolId: 'character-designer',
        bookId: book.id,
        inputs: { rolePosition: '主角', archetype: '落魄医修' },
      },
    });
    const run = runResponse.json<ToolboxRunDetail>();

    // 软删除书籍后：历史仍可回看，但回写目标书籍必须活跃。
    const deleteBook = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${book.id}`,
    });
    expect(deleteBook.statusCode).toBe(204);

    const detail = await context.app.inject({
      method: 'GET',
      url: `/api/v1/toolbox/runs/${run.id}`,
    });
    expect(detail.statusCode).toBe(200);

    const applyToTrashedBook = await context.app.inject({
      method: 'POST',
      url: `/api/v1/toolbox/runs/${run.id}/apply-card`,
      payload: { bookId: book.id, itemIndex: 0 },
    });
    expect(applyToTrashedBook.statusCode).toBe(404);
    expect(applyToTrashedBook.json<ApiError>().code).toBe('BOOK_NOT_FOUND');

    const runOnTrashed = await context.app.inject({
      method: 'POST',
      url: '/api/v1/toolbox/runs',
      payload: {
        toolId: 'character-designer',
        bookId: book.id,
        inputs: { rolePosition: '主角', archetype: '落魄医修' },
      },
    });
    expect(runOnTrashed.statusCode).toBe(404);
    expect(runOnTrashed.json<ApiError>().code).toBe('BOOK_NOT_FOUND');
  });
});
