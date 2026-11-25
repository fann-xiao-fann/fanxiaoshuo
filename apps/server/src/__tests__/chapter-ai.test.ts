import type {
  AiContextPreviewResponse,
  AiStreamDoneEvent,
  AiStreamErrorEvent,
  AiStreamStartEvent,
  ApiError,
  ApplyAiChapterContentResponse,
  ChapterRevisionDetail,
  ChapterRevisionListResponse,
  RestoreChapterRevisionResponse,
} from '@fanxiaoshuo/shared';
import { countNovelWords } from '@fanxiaoshuo/shared';
import { ModelGateway } from '@fanxiaoshuo/agents';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServerContext } from './helpers/in-memory.js';
import {
  bindRole,
  seedProviderAndModel,
  TEST_PROVIDER_API_KEY,
} from './helpers/ai-fixtures.js';
import {
  createBook,
  createChapter,
  createVolume,
  getChapter,
  saveChapterContent,
} from './helpers/book-fixtures.js';

/* -------------------------------------------------------------------------- */
/*                                  Mock 模型                                  */
/* -------------------------------------------------------------------------- */

function mockUsage() {
  return {
    inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 500, text: 500, reasoning: 0 },
  };
}

function chunkArray(chunks: readonly string[]) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: 'text-1' },
    ...chunks.map((delta) => ({ type: 'text-delta' as const, id: 'text-1', delta })),
    { type: 'text-end' as const, id: 'text-1' },
    {
      type: 'finish' as const,
      finishReason: { unified: 'stop', raw: 'stop' } as const,
      usage: mockUsage(),
    },
  ];
}

/** 正常流式模型：`stream-start` → 逐块 delta → finish。 */
function createStreamModel(chunks: readonly string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doStream: { stream: convertArrayToReadableStream(chunkArray(chunks)) },
  });
}

/** 上游鉴权失败模型（消息故意夹带明文 Key，用于验证脱敏）。 */
function createUpstreamFailureModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doStream: {
      stream: convertArrayToReadableStream([
        { type: 'stream-start' as const, warnings: [] },
        {
          type: 'error' as const,
          error: Object.assign(new Error(`Unauthorized: Bearer ${TEST_PROVIDER_API_KEY}`), {
            statusCode: 401,
          }),
        },
      ]),
    },
  });
}

/** 慢速流式模型（用于验证客户端中止后调用 `close()` 清理）。 */
function createDelayedStreamModel(): MockLanguageModelV4 {
  let step = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (step === 0) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
      } else if (step === 1) {
        controller.enqueue({ type: 'text-start', id: 'text-1' });
      } else if (step <= 6) {
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta: `第${step - 1}段。` });
      } else {
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: mockUsage(),
        });
        controller.close();
      }
      step += 1;
    },
  });

  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doStream: { stream },
  });
}

/** 包装网关以统计 `close()` 调用次数（验证中止清理）。 */
function withCloseSpy(gateway: ModelGateway): { gateway: ModelGateway; closeCalls: () => number } {
  const original = gateway.streamText.bind(gateway);
  let closeCalls = 0;
  gateway.streamText = (params) => {
    const stream = original(params);
    return {
      ...stream,
      close: () => {
        closeCalls += 1;
        stream.close();
      },
    };
  };
  return { gateway, closeCalls: () => closeCalls };
}

/* -------------------------------------------------------------------------- */
/*                                  SSE 工具                                   */
/* -------------------------------------------------------------------------- */

interface SseFrame {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

function parseSseFrames(raw: string): SseFrame[] {
  return raw
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLines = lines.filter((line) => line.startsWith('data: '));
      if (!eventLine || dataLines.length === 0) {
        throw new Error(`非法 SSE 帧：${block}`);
      }
      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(
          dataLines.map((line) => line.slice('data: '.length)).join('\n'),
        ) as Record<string, unknown>,
      };
    });
}

async function readAllSse(response: Response): Promise<string> {
  expect(response.body).not.toBeNull();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待条件成立（避免异步落盘日志带来的竞态）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(20);
  }
  throw new Error('等待条件超时');
}

/* -------------------------------------------------------------------------- */
/*                                 测试夹具                                    */
/* -------------------------------------------------------------------------- */

/** 创建一个「第一卷两章 + 第二卷一章 + 未分卷一章」的阅读序列。 */
async function seedReadingOrder(context: TestServerContext) {
  const book = await createBook(context.app, { title: '长夜行舟', targetChapterWords: 2000 });
  const volumeOne = await createVolume(context.app, book.id, { title: '第一卷' });
  const volumeTwo = await createVolume(context.app, book.id, { title: '第二卷' });
  const first = await createChapter(context.app, book.id, {
    title: '第一章 启程',
    volumeId: volumeOne.id,
  });
  const second = await createChapter(context.app, book.id, {
    title: '第二章 落雪',
    volumeId: volumeOne.id,
  });
  const third = await createChapter(context.app, book.id, {
    title: '第三章 入城',
    volumeId: volumeTwo.id,
  });
  const fourth = await createChapter(context.app, book.id, { title: '第四章 未归卷' });
  return { book, volumeOne, volumeTwo, first, second, third, fourth };
}

/** 用当前版本号保存正文（避免测试里手写版本号）。 */
async function saveContent(context: TestServerContext, chapterId: string, contentText: string) {
  const detail = await getChapter(context.app, chapterId);
  return saveChapterContent(context.app, chapterId, {
    contentText,
    expectedVersion: detail.version,
  });
}

/* -------------------------------------------------------------------------- */
/*                              上下文预览测试                                 */
/* -------------------------------------------------------------------------- */

describe('POST /api/v1/chapters/:chapterId/ai/context-preview', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('按分卷阅读顺序组装前情摘要与上一章尾部，并在超预算时确定性裁剪', async () => {
    context = await createTestServer();
    const { book, first, second, third, fourth } = await seedReadingOrder(context);

    await context.app.inject({
      method: 'PUT',
      url: `/api/v1/books/${book.id}/outline`,
      payload: {
        mainPlot: '少年北行追寻兄长下落。',
        worldSetting: '灵潮复苏的九州。',
        styleGuide: '短句为主。',
        endingPlan: '终卷决战北境。',
      },
    });
    await context.app.inject({
      method: 'POST',
      url: `/api/v1/books/${book.id}/cards`,
      payload: {
        category: 'character',
        title: '沈墨',
        summary: '主角，边城少年剑客。',
        pinned: true,
      },
    });

    await context.app.inject({
      method: 'PUT',
      url: `/api/v1/chapters/${first.id}/summary`,
      payload: { outline: '启程', summary: '沈墨离开边城。', keyEvents: ['离开边城'] },
    });
    await context.app.inject({
      method: 'PUT',
      url: `/api/v1/chapters/${second.id}/summary`,
      payload: { outline: '落雪', summary: '沈墨夜宿荒庙。', keyEvents: ['夜宿荒庙'] },
    });
    // 当前章之后的章节摘要绝不能出现在前情里
    await context.app.inject({
      method: 'PUT',
      url: `/api/v1/chapters/${fourth.id}/summary`,
      payload: { summary: '这是一条不应被纳入的前情摘要。' },
    });

    const longTail = `第二章正文开头。${'雪'.repeat(1000)}`;
    await saveContent(context, second.id, longTail);
    await saveContent(context, third.id, '第三章已有正文，准备入城。');

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${third.id}/ai/context-preview`,
      payload: { action: 'continue', instruction: '顺势推进入城见闻' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<AiContextPreviewResponse>();

    expect(body.sections.map((section) => section.key)).toEqual([
      'book-outline',
      'knowledge-cards',
      'recent-summaries',
      'prev-chapter-tail',
      'current-chapter',
      'instruction',
    ]);
    expect(body.recentSummariesCount).toBe(2);
    expect(body.prevChapterTitle).toBe('第二章 落雪');
    expect(body.truncated).toBe(false);

    const summarySection = body.sections.find((section) => section.key === 'recent-summaries');
    expect(summarySection).toBeDefined();
    const summaryPreview = summarySection?.preview ?? '';
    expect(summaryPreview.indexOf('第一章 启程')).toBeGreaterThanOrEqual(0);
    expect(summaryPreview.indexOf('第一章 启程')).toBeLessThan(
      summaryPreview.indexOf('第二章 落雪'),
    );
    expect(summaryPreview).not.toContain('不应被纳入');

    const prevSection = body.sections.find((section) => section.key === 'prev-chapter-tail');
    expect(prevSection?.preview).toContain('第二章 落雪');
    // 默认 800 字尾部衔接：开头的正文会被裁掉
    expect(prevSection?.preview).not.toContain('第二章正文开头。');

    expect(body.selectedCards).toHaveLength(1);
    expect(body.selectedCards[0]?.title).toBe('沈墨');
    expect(body.selectedCards[0]?.reason).toBe('pinned');
    expect(body.systemPromptPreview).toContain('长夜行舟');
    expect(body.userPromptPreview).toContain('本轮任务');

    // 超预算：总大纲 + 设定卡 + 前情摘要超过 1000 Token 时必须确定性裁剪
    await context.app.inject({
      method: 'PUT',
      url: `/api/v1/books/${book.id}/outline`,
      payload: {
        mainPlot: '主'.repeat(30_000),
        worldSetting: '世'.repeat(30_000),
        styleGuide: '文'.repeat(30_000),
        endingPlan: '终'.repeat(30_000),
      },
    });

    const tight = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${third.id}/ai/context-preview`,
      payload: { action: 'continue', maxContextTokens: 1000 },
    });
    expect(tight.statusCode).toBe(200);
    const tightBody = tight.json<AiContextPreviewResponse>();
    expect(tightBody.maxContextTokens).toBe(1000);
    expect(tightBody.truncated).toBe(true);
    expect(tightBody.sections.some((section) => section.truncated)).toBe(true);
  });

  it('章节不存在返回 404，非法请求体返回 400', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);

    const missing = await context.app.inject({
      method: 'POST',
      url: '/api/v1/chapters/11111111-1111-4111-8111-111111111111/ai/context-preview',
      payload: { action: 'continue' },
    });
    expect(missing.statusCode).toBe(404);

    const chapter = await createChapter(context.app, book.id);
    const invalid = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/ai/context-preview`,
      payload: { action: 'not-an-action' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/*                                流式写作测试                                 */
/* -------------------------------------------------------------------------- */

describe('POST /api/v1/chapters/:chapterId/ai/stream', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('推送 start → 多个 delta → done 帧，且用量审计落盘', async () => {
    const model = createStreamModel(['风起', '，', '雪落。']);
    context = await createTestServer({
      gateway: new ModelGateway({ createLanguageModel: () => model }),
    });
    const seeded = await seedProviderAndModel(context);
    await bindRole(context, 'writer', seeded.modelId, { temperature: 0.5, maxTokens: 4096 });

    const book = await createBook(context.app, { title: '长夜行舟' });
    const chapter = await createChapter(context.app, book.id, { title: '第一章 启程' });
    await saveContent(context, chapter.id, '夜风穿城而过。');

    const baseUrl = await context.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${baseUrl}/api/v1/chapters/${chapter.id}/ai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ action: 'continue', instruction: '继续推进' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const raw = await readAllSse(response);
    const frames = parseSseFrames(raw);

    expect(frames[0]?.event).toBe('start');
    const start = frames[0]?.data as unknown as AiStreamStartEvent;
    expect(start.chapterId).toBe(chapter.id);
    expect(start.action).toBe('continue');
    expect(start.role).toBe('writer');
    expect(start.modelRef).toBe('Mock Provider/mock-model');

    const deltas = frames.filter((frame) => frame.event === 'delta');
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.map((frame) => frame.data['text']).join('')).toBe('风起，雪落。');

    const doneFrame = frames.find((frame) => frame.event === 'done');
    expect(doneFrame).toBeDefined();
    const done = doneFrame?.data as unknown as AiStreamDoneEvent;
    expect(done.fullText).toBe('风起，雪落。');
    expect(done.finishReason).toBe('stop');
    expect(done.inputTokens).toBe(1000);
    expect(done.outputTokens).toBe(500);
    // (1000 * 1 + 500 * 2) / 1_000_000
    expect(done.estimatedCostUsd).toBeCloseTo(0.002, 6);
    expect(typeof done.usageLogId).toBe('string');
    expect(raw).not.toContain(TEST_PROVIDER_API_KEY);

    await waitFor(() => context!.store.state.logs.length === 1);
    const log = context.store.state.logs[0];
    expect(log?.id).toBe(done.usageLogId);
    expect(log?.scene).toBe('chapter-write');
    expect(log?.role).toBe('writer');
    expect(log?.status).toBe('success');
    expect(log?.modelRef).toBe('Mock Provider/mock-model');
    expect(log?.inputTokens).toBe(1000);
    expect(log?.outputTokens).toBe(500);
  });

  it('角色未绑定返回 409 JSON，空内容改写返回 400 AI_EMPTY_CONTEXT', async () => {
    const model = createStreamModel(['润色', '完成。']);
    context = await createTestServer({
      gateway: new ModelGateway({ createLanguageModel: () => model }),
    });
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);
    await saveContent(context, chapter.id, '已有正文。');

    const unbound = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/ai/stream`,
      payload: { action: 'continue' },
    });
    expect(unbound.statusCode).toBe(409);
    expect(unbound.headers['content-type']).toContain('application/json');
    expect(unbound.json<ApiError>().code).toBe('AGENT_ROLE_UNBOUND');

    const seeded = await seedProviderAndModel(context);
    await bindRole(context, 'writer', seeded.modelId);

    const emptyChapter = await createChapter(context.app, book.id, { title: '空白章' });
    const empty = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${emptyChapter.id}/ai/stream`,
      payload: { action: 'rewrite' },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json<ApiError>().code).toBe('AI_EMPTY_CONTEXT');

    // 非 continue 动作只要有选区即可通过前置校验并建立 SSE 流
    const baseUrl = await context.app.listen({ host: '127.0.0.1', port: 0 });
    const withSelection = await fetch(`${baseUrl}/api/v1/chapters/${emptyChapter.id}/ai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'polish', selectedText: '待润色的片段' }),
    });
    expect(withSelection.status).toBe(200);
    const frames = parseSseFrames(await readAllSse(withSelection));
    expect(frames[0]?.event).toBe('start');
    expect(frames.some((frame) => frame.event === 'done')).toBe(true);
  });

  it('上游错误推送脱敏 error 帧并落盘 error 审计日志（不含明文 Key）', async () => {
    const model = createUpstreamFailureModel();
    context = await createTestServer({
      gateway: new ModelGateway({ createLanguageModel: () => model }),
    });
    const seeded = await seedProviderAndModel(context);
    await bindRole(context, 'writer', seeded.modelId);

    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);
    await saveContent(context, chapter.id, '正文已有内容。');

    const baseUrl = await context.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${baseUrl}/api/v1/chapters/${chapter.id}/ai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'continue' }),
    });

    expect(response.status).toBe(200);
    const raw = await readAllSse(response);
    const frames = parseSseFrames(raw);

    expect(frames[0]?.event).toBe('start');
    expect(frames.some((frame) => frame.event === 'done')).toBe(false);

    const errorFrame = frames.find((frame) => frame.event === 'error');
    expect(errorFrame).toBeDefined();
    const error = errorFrame?.data as unknown as AiStreamErrorEvent;
    expect(error.code).toBe('UPSTREAM_AUTH_ERROR');
    expect(error.message).not.toContain(TEST_PROVIDER_API_KEY);
    expect(error.message).toContain('[REDACTED]');
    expect(raw).not.toContain(TEST_PROVIDER_API_KEY);

    await waitFor(() => context!.store.state.logs.length === 1);
    const log = context.store.state.logs[0];
    expect(log?.status).toBe('error');
    expect(log?.scene).toBe('chapter-write');
    expect(log?.role).toBe('writer');
    expect(log?.errorCode).toBe('UPSTREAM_AUTH_ERROR');
    expect(log?.errorMessage ?? '').not.toContain(TEST_PROVIDER_API_KEY);
  });

  it('客户端中止后调用 close() 清理，不推送 done 帧', async () => {
    const model = createDelayedStreamModel();
    const spied = withCloseSpy(new ModelGateway({ createLanguageModel: () => model }));
    context = await createTestServer({ gateway: spied.gateway });
    const seeded = await seedProviderAndModel(context);
    await bindRole(context, 'writer', seeded.modelId);

    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);
    await saveContent(context, chapter.id, '正文已有内容。');

    const baseUrl = await context.app.listen({ host: '127.0.0.1', port: 0 });
    const abortController = new AbortController();
    const response = await fetch(`${baseUrl}/api/v1/chapters/${chapter.id}/ai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'continue' }),
      signal: abortController.signal,
    });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 5_000;
    while (!buffer.includes('event: delta') && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    expect(buffer).toContain('event: delta');

    abortController.abort();
    await reader.cancel().catch(() => undefined);

    await waitFor(() => spied.closeCalls() >= 1);
    expect(buffer).not.toContain('event: done');
    expect(buffer).not.toContain('event: error');
  });
});

/* -------------------------------------------------------------------------- */
/*                              原子应用 AI 正文                               */
/* -------------------------------------------------------------------------- */

describe('POST /api/v1/chapters/:chapterId/ai/apply', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('单事务留底 source=ai 快照、重算字数、版本 +1，并支持一键回滚', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id, { title: '第一章 启程' });

    const original = '夜风穿城而过，沈墨按住剑柄。';
    await saveContent(context, chapter.id, original);
    const before = await getChapter(context.app, chapter.id);
    expect(before.version).toBe(2);

    const appliedText = `${original}\n\n城门在身后缓缓合拢，他向北望去。`;
    const applied = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/ai/apply`,
      payload: {
        expectedVersion: before.version,
        action: 'continue',
        mode: 'append',
        contentText: appliedText,
        contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
    });
    expect(applied.statusCode).toBe(200);
    const body = applied.json<ApplyAiChapterContentResponse>();

    expect(body.chapter.version).toBe(before.version + 1);
    expect(body.chapter.contentText).toBe(appliedText);
    expect(body.chapter.wordCount).toBe(countNovelWords(appliedText));
    expect(body.chapter.contentJson).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });

    expect(body.backupRevision.source).toBe('ai');
    expect(body.backupRevision.version).toBe(before.version);
    expect(body.backupRevision.titleSnapshot).toBe('第一章 启程');
    expect(body.backupRevision.note).toBe('AI 续写（追加到文末）前自动留底');

    // 留底快照记录的是应用前的原稿正文（可一键回滚）
    const backupDetail = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/revisions/${body.backupRevision.id}`,
    });
    expect(backupDetail.statusCode).toBe(200);
    expect(backupDetail.json<ChapterRevisionDetail>().contentText).toBe(original);

    const listBefore = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/revisions`,
    });
    const revisionCount = listBefore.json<ChapterRevisionListResponse>().total;

    // 一键回滚复原
    const restored = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/revisions/${body.backupRevision.id}/restore`,
    });
    expect(restored.statusCode).toBe(200);
    const restoredBody = restored.json<RestoreChapterRevisionResponse>();
    expect(restoredBody.chapter.contentText).toBe(original);
    expect(restoredBody.chapter.wordCount).toBe(countNovelWords(original));

    // 版本冲突：拒绝修改、不写入脏快照
    const conflict = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/ai/apply`,
      payload: {
        expectedVersion: before.version,
        action: 'continue',
        mode: 'append',
        contentText: '这段内容不应被写入。',
      },
    });
    expect(conflict.statusCode).toBe(409);
    const conflictBody = conflict.json<ApiError>();
    expect(conflictBody.code).toBe('CHAPTER_VERSION_CONFLICT');
    expect(conflictBody.details?.[0]?.path).toBe('expectedVersion');
    expect(conflictBody.details?.[0]?.message).toBe(
      `currentVersion=${restoredBody.chapter.version}`,
    );

    const afterConflict = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/revisions`,
    });
    expect(afterConflict.json<ChapterRevisionListResponse>().total).toBe(revisionCount + 1);

    const latest = await getChapter(context.app, chapter.id);
    expect(latest.contentText).toBe(original);
    expect(latest.version).toBe(restoredBody.chapter.version);
  });

  it('自定义备注透传；章节不存在返回 404 CHAPTER_NOT_FOUND', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);

    const applied = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/ai/apply`,
      payload: {
        expectedVersion: 1,
        action: 'polish',
        mode: 'replace_all',
        contentText: '润色后的正文。',
        note: 'AI 润色替换全文',
      },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json<ApplyAiChapterContentResponse>().backupRevision.note).toBe(
      'AI 润色替换全文',
    );

    const missing = await context.app.inject({
      method: 'POST',
      url: '/api/v1/chapters/11111111-1111-4111-8111-111111111111/ai/apply',
      payload: {
        expectedVersion: 1,
        action: 'continue',
        mode: 'append',
        contentText: '正文',
      },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiError>().code).toBe('CHAPTER_NOT_FOUND');
  });
});
