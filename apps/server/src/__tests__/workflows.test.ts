import {
  WORKFLOW_SSE_EVENT_NAMES,
  workflowEventSchema,
  type ApiError,
  type WorkflowEvent,
  type WorkflowRunDetailDto,
  type WorkflowRunListResponse,
} from '@fanxiaoshuo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServerContext } from './helpers/in-memory.js';
import { bindRole, seedProviderAndModel } from './helpers/ai-fixtures.js';
import { createBook, createChapter, createVolume } from './helpers/book-fixtures.js';
import type { WorkflowRunRecord, WorkflowStepRecord } from '../repositories/types.js';

/**
 * Change 4 Wave 3A：`/api/v1/workflows` 批量流水线集成测试。
 *
 * 全部通过 `app.inject()` 覆盖（SSE 端点使用真实监听端口 + `fetch` 流式读取），
 * 无 Docker / PostgreSQL / Redis 依赖。
 */

const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 绑定全部 4 个写书角色（默认 mock 模型）。 */
async function bindAllRoles(context: TestServerContext): Promise<string> {
  const seeded = await seedProviderAndModel(context);
  for (const role of ['showrunner', 'writer', 'critic', 'lorekeeper'] as const) {
    await bindRole(context, role, seeded.modelId);
  }
  return seeded.modelId;
}

/** 直接改写内存批次（模拟 Worker 推进后的状态）。 */
function patchRun(
  context: TestServerContext,
  runId: string,
  patch: Partial<WorkflowRunRecord>,
): void {
  const state = context.store.state.workflowRuns;
  const current = state.get(runId);
  if (!current) {
    throw new Error(`批次不存在：${runId}`);
  }
  state.set(runId, { ...current, ...patch });
}

/** 直接改写内存步骤（模拟 Worker 推进后的状态）。 */
function patchStep(
  context: TestServerContext,
  runId: string,
  stepId: string,
  patch: Partial<WorkflowStepRecord>,
): void {
  const steps = context.store.state.workflowSteps.get(runId);
  if (!steps) {
    throw new Error(`批次步骤不存在：${runId}`);
  }
  context.store.state.workflowSteps.set(
    runId,
    steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)),
  );
}

/** 读取内存中完整批次状态（含有序步骤，保留 Date 类型）。 */
function readRun(
  context: TestServerContext,
  runId: string,
): WorkflowRunRecord & { steps: WorkflowStepRecord[] } {
  const run = context.store.state.workflowRuns.get(runId);
  if (!run) {
    throw new Error(`批次不存在：${runId}`);
  }
  return { ...run, steps: [...(context.store.state.workflowSteps.get(runId) ?? [])] };
}

describe('/api/v1/workflows/runs 创建与查询', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('选定已有章节创建 full_pipeline 批次：201 + 入队 + 广播 workflow.queued', async () => {
    context = await createTestServer();
    const modelId = await bindAllRoles(context);
    expect(modelId).toBeTruthy();

    const book = await createBook(context.app, { title: '长夜行舟' });
    const volume = await createVolume(context.app, book.id, { title: '第一卷' });
    const first = await createChapter(context.app, book.id, {
      title: '第一章 启程',
      volumeId: volume.id,
    });
    const second = await createChapter(context.app, book.id, {
      title: '第二章 夜谈',
      volumeId: volume.id,
    });

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/runs',
      payload: {
        bookId: book.id,
        mode: 'full_pipeline',
        chapterIds: [first.id, second.id],
        maxCostUsd: 3.5,
        minPassScore: 80,
        maxReworkRounds: 2,
        instruction: '保持冷峻克制的文风。',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<WorkflowRunDetailDto>();
    expect(body.bookId).toBe(book.id);
    expect(body.bookTitle).toBe('长夜行舟');
    expect(body.mode).toBe('full_pipeline');
    expect(body.status).toBe('queued');
    expect(body.totalSteps).toBe(2);
    expect(body.completedSteps).toBe(0);
    expect(body.failedSteps).toBe(0);
    expect(body.maxCostUsd).toBe(3.5);
    expect(body.spentCostUsd).toBe(0);
    expect(body.pauseRequested).toBe(false);
    expect(body.cancelRequested).toBe(false);
    expect(body.config).toMatchObject({
      enableCritic: true,
      enableSummary: true,
      minPassScore: 80,
      maxReworkRounds: 2,
      instruction: '保持冷峻克制的文风。',
    });
    // strictObject：config 不得混入 bookId / mode / chapterIds 等非配置字段
    expect(Object.keys(body.config).sort()).toEqual([
      'enableCritic',
      'enableSummary',
      'instruction',
      'maxContextTokens',
      'maxReworkRounds',
      'minPassScore',
    ]);

    expect(body.steps).toHaveLength(2);
    expect(body.steps.map((step) => step.stepIndex)).toEqual([0, 1]);
    expect(body.steps.map((step) => step.chapterId)).toEqual([first.id, second.id]);
    expect(body.steps.map((step) => step.chapterTitleSnapshot)).toEqual([
      '第一章 启程',
      '第二章 夜谈',
    ]);
    expect(body.steps.every((step) => step.status === 'pending')).toBe(true);
    expect(body.steps.every((step) => step.stage === 'idle')).toBe(true);
    expect(body.steps.every((step) => step.criticScore === null)).toBe(true);
    expect(body.steps.every((step) => step.criticIssues.length === 0)).toBe(true);

    expect(context.workflowQueue.enqueued).toEqual([body.id]);
    expect(context.workflowEventBus.published).toHaveLength(1);
    expect(context.workflowEventBus.published[0]).toMatchObject({
      type: 'workflow.queued',
      runId: body.id,
      bookId: book.id,
      status: 'queued',
      totalSteps: 2,
      spentCostUsd: 0,
      maxCostUsd: 3.5,
    });
  });

  it('必需角色未绑定模型时 409 拒绝，且不残留孤立批次', async () => {
    context = await createTestServer();
    const book = await createBook(context.app, { title: '未绑定的世界' });
    const chapter = await createChapter(context.app, book.id, { title: '第一章' });

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/runs',
      payload: {
        bookId: book.id,
        mode: 'full_pipeline',
        chapterIds: [chapter.id],
        enableCritic: true,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<ApiError>().code).toBe('AGENT_ROLE_UNBOUND');
    expect(context.store.state.workflowRuns.size).toBe(0);
    expect(context.store.state.workflowSteps.size).toBe(0);
    expect(context.workflowQueue.enqueued).toHaveLength(0);
  });

  it('关闭审稿与摘要时仅要求 showrunner + writer', async () => {
    context = await createTestServer();
    const seeded = await seedProviderAndModel(context);
    await bindRole(context, 'showrunner', seeded.modelId);
    await bindRole(context, 'writer', seeded.modelId);

    const book = await createBook(context.app, { title: '极简管线' });
    const chapter = await createChapter(context.app, book.id, { title: '第一章' });

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/runs',
      payload: {
        bookId: book.id,
        mode: 'full_pipeline',
        chapterIds: [chapter.id],
        enableCritic: false,
        enableSummary: false,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<WorkflowRunDetailDto>();
    expect(body.config.enableCritic).toBe(false);
    expect(body.config.enableSummary).toBe(false);
  });

  it('autoCreateChapters 自动建章（分卷 + 标题前缀）并生成有序步骤', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const book = await createBook(context.app, { title: '自动建章' });
    const volume = await createVolume(context.app, book.id, { title: '第一卷' });
    // 书内已有 1 章 → 自动建章应从第 2 章开始编号
    await createChapter(context.app, book.id, { title: '第一章', volumeId: volume.id });

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/runs',
      payload: {
        bookId: book.id,
        mode: 'write_chapters',
        autoCreateChapters: { volumeId: volume.id, count: 3, titlePrefix: '第' },
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<WorkflowRunDetailDto>();
    expect(body.totalSteps).toBe(3);
    expect(body.steps.map((step) => step.chapterTitleSnapshot)).toEqual([
      '第2章',
      '第3章',
      '第4章',
    ]);

    const created = context.store.state.chapters;
    for (const step of body.steps) {
      const chapter = created.get(step.chapterId);
      expect(chapter).toBeDefined();
      expect(chapter?.bookId).toBe(book.id);
      expect(chapter?.volumeId).toBe(volume.id);
      expect(chapter?.status).toBe('outline');
    }
  });

  it('autoCreateChapters 支持非「第」前缀的标题拼接', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const book = await createBook(context.app, { title: '前缀拼接' });

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/runs',
      payload: {
        bookId: book.id,
        mode: 'write_chapters',
        enableCritic: false,
        enableSummary: false,
        autoCreateChapters: { count: 2, titlePrefix: '外传' },
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<WorkflowRunDetailDto>();
    expect(body.steps.map((step) => step.chapterTitleSnapshot)).toEqual(['外传 1', '外传 2']);
  });

  it('书籍不存在 / 章节跨书 / 分卷跨书分别返回 404 与 409', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const first = await createBook(context.app, { title: '甲书' });
    const second = await createBook(context.app, { title: '乙书' });
    const foreignChapter = await createChapter(context.app, second.id, { title: '乙书第一章' });
    const foreignVolume = await createVolume(context.app, second.id, { title: '乙卷' });

    const missingBook = await context.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/runs',
      payload: { bookId: UNKNOWN_ID, mode: 'outline_only', chapterIds: [foreignChapter.id] },
    });
    expect(missingBook.statusCode).toBe(404);
    expect(missingBook.json<ApiError>().code).toBe('BOOK_NOT_FOUND');

    const crossBookChapter = await context.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/runs',
      payload: { bookId: first.id, mode: 'outline_only', chapterIds: [foreignChapter.id] },
    });
    expect(crossBookChapter.statusCode).toBe(409);
    expect(crossBookChapter.json<ApiError>().code).toBe('CONFLICT');

    const crossBookVolume = await context.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/runs',
      payload: {
        bookId: first.id,
        mode: 'write_chapters',
        autoCreateChapters: { volumeId: foreignVolume.id, count: 1 },
      },
    });
    expect(crossBookVolume.statusCode).toBe(409);
    expect(crossBookVolume.json<ApiError>().code).toBe('CONFLICT');
  });

  it('列表支持状态筛选与分页，详情步骤按 stepIndex 升序', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const book = await createBook(context.app, { title: '分页之书' });
    const first = await createChapter(context.app, book.id, { title: '第一章' });
    const second = await createChapter(context.app, book.id, { title: '第二章' });

    const createdIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/workflows/runs',
        payload: {
          bookId: book.id,
          mode: 'outline_only',
          chapterIds: [second.id, first.id],
        },
      });
      expect(response.statusCode).toBe(201);
      createdIds.push(response.json<WorkflowRunDetailDto>().id);
    }
    // 第 2 个批次置为 paused 以验证状态筛选
    patchRun(context, createdIds[1] as string, { status: 'paused' });

    const all = await context.app.inject({ method: 'GET', url: '/api/v1/workflows/runs' });
    expect(all.statusCode).toBe(200);
    const allBody = all.json<WorkflowRunListResponse>();
    expect(allBody.total).toBe(3);
    expect(allBody.page).toBe(1);
    expect(allBody.pageSize).toBe(20);
    // createdAt DESC：最后创建的批次排在最前
    expect(allBody.items[0]?.id).toBe(createdIds[2]);
    expect(allBody.items.every((item) => item.bookTitle === '分页之书')).toBe(true);

    const paged = await context.app.inject({
      method: 'GET',
      url: '/api/v1/workflows/runs?page=2&pageSize=2',
    });
    const pagedBody = paged.json<WorkflowRunListResponse>();
    expect(pagedBody.total).toBe(3);
    expect(pagedBody.page).toBe(2);
    expect(pagedBody.items).toHaveLength(1);

    const paused = await context.app.inject({
      method: 'GET',
      url: '/api/v1/workflows/runs?status=paused',
    });
    const pausedBody = paused.json<WorkflowRunListResponse>();
    expect(pausedBody.total).toBe(1);
    expect(pausedBody.items[0]?.id).toBe(createdIds[1]);

    const emptyStatus = await context.app.inject({
      method: 'GET',
      url: '/api/v1/workflows/runs?status=&bookId=',
    });
    expect(emptyStatus.statusCode).toBe(200);
    expect(emptyStatus.json<WorkflowRunListResponse>().total).toBe(3);

    const detail = await context.app.inject({
      method: 'GET',
      url: `/api/v1/workflows/runs/${createdIds[0]}`,
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json<WorkflowRunDetailDto>();
    expect(detailBody.steps.map((step) => step.chapterId)).toEqual([second.id, first.id]);
    expect(detailBody.steps.map((step) => step.stepIndex)).toEqual([0, 1]);

    const missing = await context.app.inject({
      method: 'GET',
      url: `/api/v1/workflows/runs/${UNKNOWN_ID}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiError>().code).toBe('WORKFLOW_RUN_NOT_FOUND');
  });
});

describe('/api/v1/workflows/runs 生命周期控制', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  async function createRun(
    serverContext: TestServerContext,
    overrides: Record<string, unknown> = {},
  ): Promise<WorkflowRunDetailDto> {
    const book = await createBook(serverContext.app, { title: '控制台之书' });
    const first = await createChapter(serverContext.app, book.id, { title: '第一章' });
    const second = await createChapter(serverContext.app, book.id, { title: '第二章' });
    const response = await serverContext.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/runs',
      payload: {
        bookId: book.id,
        mode: 'write_chapters',
        chapterIds: [first.id, second.id],
        ...overrides,
      },
    });
    if (response.statusCode !== 201) {
      throw new Error(`创建批次失败：${response.statusCode} ${response.body}`);
    }
    return response.json<WorkflowRunDetailDto>();
  }

  it('pause：queued 立即转 paused 并广播 workflow.paused', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const run = await createRun(context);

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/pause`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<WorkflowRunDetailDto>();
    expect(body.status).toBe('paused');
    expect(body.pauseReason).toBe('USER_PAUSED');
    expect(body.pauseRequested).toBe(false);
    expect(context.workflowEventBus.published.at(-1)).toMatchObject({
      type: 'workflow.paused',
      runId: run.id,
      pauseReason: 'USER_PAUSED',
    });
  });

  it('pause：running 仅置 pauseRequested，不广播暂停事件', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const run = await createRun(context);
    patchRun(context, run.id, { status: 'running' });
    const before = context.workflowEventBus.published.length;

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/pause`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<WorkflowRunDetailDto>();
    expect(body.status).toBe('running');
    expect(body.pauseRequested).toBe(true);
    expect(body.pauseReason).toBeNull();
    expect(context.workflowEventBus.published).toHaveLength(before);
  });

  it('pause：终态批次返回 409 WORKFLOW_INVALID_STATE', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const run = await createRun(context);
    patchRun(context, run.id, { status: 'completed' });

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/pause`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<ApiError>().code).toBe('WORKFLOW_INVALID_STATE');
  });

  it('resume：未上调预算时 402 BUDGET_EXCEEDED，上调后重置失败步骤并重新入队', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const run = await createRun(context, { maxCostUsd: 1 });
    const steps = readRun(context, run.id).steps;

    patchRun(context, run.id, {
      status: 'paused',
      pauseReason: 'BUDGET_EXCEEDED',
      spentCostUsd: 1,
      completedSteps: 1,
      failedSteps: 1,
      finishedAt: new Date('2025-01-02T00:00:00.000Z'),
    });
    patchStep(context, run.id, steps[0]!.id, { status: 'completed', stage: 'done' });
    patchStep(context, run.id, steps[1]!.id, {
      status: 'failed',
      stage: 'writing',
      errorCode: 'UPSTREAM_ERROR',
      errorMessage: '上游 500',
      finishedAt: new Date('2025-01-02T00:00:00.000Z'),
    });

    const blocked = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/resume`,
      payload: {},
    });
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json<ApiError>().code).toBe('BUDGET_EXCEEDED');

    const before = context.workflowQueue.enqueued.length;
    const resumed = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/resume`,
      payload: { maxCostUsd: 8 },
    });

    expect(resumed.statusCode).toBe(200);
    const body = resumed.json<WorkflowRunDetailDto>();
    expect(body.status).toBe('queued');
    expect(body.maxCostUsd).toBe(8);
    expect(body.pauseReason).toBeNull();
    expect(body.failedSteps).toBe(0);
    expect(body.finishedAt).toBeNull();
    // completed 步骤原样保留（断点续跑不重复消耗 Token）
    expect(body.steps[0]?.status).toBe('completed');
    expect(body.steps[0]?.stage).toBe('done');
    // failed 步骤重置为 pending
    expect(body.steps[1]?.status).toBe('pending');
    expect(body.steps[1]?.stage).toBe('idle');
    expect(body.steps[1]?.errorCode).toBeNull();
    expect(body.steps[1]?.errorMessage).toBeNull();
    expect(body.steps[1]?.finishedAt).toBeNull();

    expect(context.workflowQueue.enqueued).toHaveLength(before + 1);
    expect(context.workflowEventBus.published.at(-1)).toMatchObject({
      type: 'workflow.queued',
      runId: run.id,
    });
  });

  it('resume：非 paused / failed 状态返回 409', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const run = await createRun(context);

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/resume`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<ApiError>().code).toBe('WORKFLOW_INVALID_STATE');
  });

  it('resume：角色模型被解绑后拒绝续跑', async () => {
    context = await createTestServer();
    const seeded = await seedProviderAndModel(context);
    await bindRole(context, 'writer', seeded.modelId);
    const run = await createRun(context, { enableCritic: false, enableSummary: false });

    // 删除角色绑定：内存态直接清理
    context.store.state.roles.delete('writer');
    patchRun(context, run.id, { status: 'paused' });

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/resume`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<ApiError>().code).toBe('AGENT_ROLE_UNBOUND');
  });

  it('cancel：queued 批次立即收敛 cancelled 且未完成步骤置 skipped', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const run = await createRun(context);
    const steps = readRun(context, run.id).steps;
    patchStep(context, run.id, steps[0]!.id, { status: 'completed', stage: 'done' });

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/cancel`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<WorkflowRunDetailDto>();
    expect(body.status).toBe('cancelled');
    expect(body.cancelRequested).toBe(true);
    expect(body.finishedAt).not.toBeNull();
    expect(body.steps[0]?.status).toBe('completed');
    expect(body.steps[1]?.status).toBe('skipped');
    expect(context.workflowEventBus.published.at(-1)).toMatchObject({
      type: 'workflow.cancelled',
      runId: run.id,
    });
  });

  it('cancel：running 批次仅置 cancelRequested；终态批次 409', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const run = await createRun(context);
    patchRun(context, run.id, { status: 'running' });

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/cancel`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<WorkflowRunDetailDto>();
    expect(body.status).toBe('running');
    expect(body.cancelRequested).toBe(true);

    patchRun(context, run.id, { status: 'completed' });
    const terminal = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/cancel`,
    });
    expect(terminal.statusCode).toBe(409);
    expect(terminal.json<ApiError>().code).toBe('WORKFLOW_INVALID_STATE');
  });

  it('retryStep：仅重置失败步骤、递减 failedSteps 并重新入队', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const run = await createRun(context);
    const steps = readRun(context, run.id).steps;
    patchRun(context, run.id, {
      status: 'failed',
      failedSteps: 1,
      errorCode: 'UPSTREAM_ERROR',
      errorMessage: '上游失败',
      finishedAt: new Date('2025-01-02T00:00:00.000Z'),
    });
    patchStep(context, run.id, steps[0]!.id, { status: 'completed', stage: 'done' });
    patchStep(context, run.id, steps[1]!.id, {
      status: 'failed',
      stage: 'reviewing',
      errorCode: 'UPSTREAM_ERROR',
      errorMessage: '上游失败',
      finishedAt: new Date('2025-01-02T00:00:00.000Z'),
    });

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/steps/${steps[1]!.id}/retry`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<WorkflowRunDetailDto>();
    expect(body.status).toBe('queued');
    expect(body.failedSteps).toBe(0);
    expect(body.errorCode).toBeNull();
    expect(body.errorMessage).toBeNull();
    expect(body.finishedAt).toBeNull();
    expect(body.steps[0]?.status).toBe('completed');
    expect(body.steps[1]?.status).toBe('pending');
    expect(body.steps[1]?.stage).toBe('idle');
    expect(body.steps[1]?.errorCode).toBeNull();
    expect(context.workflowQueue.enqueued).toHaveLength(2);
  });

  it('retryStep：步骤不存在 404、状态不合法 409', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const run = await createRun(context);
    const steps = readRun(context, run.id).steps;

    const missingStep = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/steps/${UNKNOWN_ID}/retry`,
    });
    expect(missingStep.statusCode).toBe(404);
    expect(missingStep.json<ApiError>().code).toBe('WORKFLOW_STEP_NOT_FOUND');

    patchRun(context, run.id, { status: 'failed' });
    const notFailedStep = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/steps/${steps[0]!.id}/retry`,
    });
    expect(notFailedStep.statusCode).toBe(409);
    expect(notFailedStep.json<ApiError>().code).toBe('WORKFLOW_INVALID_STATE');

    patchRun(context, run.id, { status: 'running' });
    patchStep(context, run.id, steps[0]!.id, { status: 'failed' });
    const notFailedRun = await context.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/${run.id}/steps/${steps[0]!.id}/retry`,
    });
    expect(notFailedRun.statusCode).toBe(409);
    expect(notFailedRun.json<ApiError>().code).toBe('WORKFLOW_INVALID_STATE');
  });

  it('delete：终态批次 204，活跃批次 409 WORKFLOW_RUN_ACTIVE，不存在 404', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const active = await createRun(context);

    const blocked = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/workflows/runs/${active.id}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<ApiError>().code).toBe('WORKFLOW_RUN_ACTIVE');

    patchRun(context, active.id, { status: 'cancelled' });
    const removed = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/workflows/runs/${active.id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe('');
    expect(context.store.state.workflowRuns.has(active.id)).toBe(false);
    expect(context.store.state.workflowSteps.has(active.id)).toBe(false);

    const missing = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/workflows/runs/${UNKNOWN_ID}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiError>().code).toBe('WORKFLOW_RUN_NOT_FOUND');
  });

  it('入队失败时返回 503 QUEUE_UNAVAILABLE（批次已落盘可续跑）', async () => {
    context = await createTestServer();
    await bindAllRoles(context);
    const book = await createBook(context.app, { title: '队列抖动' });
    const chapter = await createChapter(context.app, book.id, { title: '第一章' });
    context.workflowQueue.failNext = new Error('redis down');

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/runs',
      payload: { bookId: book.id, mode: 'outline_only', chapterIds: [chapter.id] },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<ApiError>().code).toBe('QUEUE_UNAVAILABLE');
    expect(context.store.state.workflowRuns.size).toBe(1);
  });
});

describe('GET /api/v1/workflows/events (SSE)', () => {
  let context: TestServerContext | null = null;
  let abortController: AbortController | null = null;

  afterEach(async () => {
    abortController?.abort();
    await context?.app.close();
    context = null;
    abortController = null;
  });

  function makeEvent(overrides: Partial<WorkflowEvent> & { runId: string }): WorkflowEvent {
    return workflowEventSchema.parse({
      type: 'workflow.step_updated',
      bookId: UNKNOWN_ID,
      status: 'running',
      timestamp: new Date('2025-01-01T00:00:05.000Z').toISOString(),
      totalSteps: 2,
      completedSteps: 1,
      failedSteps: 0,
      spentCostUsd: 0.12,
      maxCostUsd: 5,
      ...overrides,
    });
  }

  it('握手 ready 帧 → 按 runId 过滤转发 → 心跳 → 断开退订', async () => {
    context = await createTestServer({ sseHeartbeatMs: 40 });
    const baseUrl = await context.app.listen({ host: '127.0.0.1', port: 0 });
    const targetRunId = '22222222-2222-4222-8222-222222222222';
    const otherRunId = '33333333-3333-4333-8333-333333333333';

    abortController = new AbortController();
    const response = await fetch(
      `${baseUrl}/api/v1/workflows/events?runId=${targetRunId}`,
      { headers: { accept: 'text/event-stream' }, signal: abortController.signal },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    expect(response.body).not.toBeNull();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const readChunk = async (marker: string): Promise<{ done: boolean; value?: Uint8Array }> => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`SSE 读取超时（等待 ${marker}）`)), 2_000);
      });
      try {
        return await Promise.race([reader.read(), timeout]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    };

    const readUntil = async (marker: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!buffer.includes(marker)) {
        if (Date.now() > deadline) {
          throw new Error(`等待 SSE 片段超时：${marker}；当前缓冲：${buffer}`);
        }
        const chunk = await readChunk(marker);
        if (chunk.done) {
          throw new Error(`SSE 连接提前结束（等待 ${marker}）`);
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };

    await readUntil(`event: ${WORKFLOW_SSE_EVENT_NAMES.ready}`);
    await readUntil('fanxiaoshuo:events:workflows');
    await readUntil(targetRunId);

    context.workflowEventBus.emit(makeEvent({ runId: otherRunId, spentCostUsd: 9.99 }));
    context.workflowEventBus.emit(
      makeEvent({
        runId: targetRunId,
        stepId: '44444444-4444-4444-8444-444444444444',
        chapterId: UNKNOWN_ID,
        stepIndex: 1,
        stepStatus: 'running',
        stepStage: 'reviewing',
        criticScore: 82,
      }),
    );

    await readUntil(`event: ${WORKFLOW_SSE_EVENT_NAMES.workflowEvent}`);
    await readUntil('"stepStage":"reviewing"');
    await readUntil('"criticScore":82');
    // 非目标批次的事件必须被过滤掉
    expect(buffer).not.toContain(otherRunId);

    await readUntil(`event: ${WORKFLOW_SSE_EVENT_NAMES.ping}`);
    expect(context.workflowEventBus.handlers.size).toBe(1);

    await reader.cancel().catch(() => undefined);
    abortController.abort();
    const releaseDeadline = Date.now() + 3_000;
    while (context.workflowEventBus.handlers.size > 0 && Date.now() < releaseDeadline) {
      await delay(25);
    }

    expect(context.workflowEventBus.handlers.size).toBe(0);
    expect(context.workflowEventBus.unsubscribeCount).toBeGreaterThanOrEqual(1);
  });

  it('非法 runId 查询参数返回 400', async () => {
    context = await createTestServer();
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/workflows/events?runId=not-a-uuid',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ApiError>().code).toBe('VALIDATION_ERROR');
  });
});
