import type {
  ApiError,
  BookOutlineDto,
  ChapterSummaryDto,
  ExtractChapterSummaryResponse,
  KnowledgeCardDto,
  KnowledgeCardListResponse,
} from '@fanxiaoshuo/shared';
import { ModelGateway } from '@fanxiaoshuo/agents';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServerContext } from './helpers/in-memory.js';
import {
  bindRole,
  seedProviderAndModel,
  TEST_PROVIDER_API_KEY,
  unbindRole,
} from './helpers/ai-fixtures.js';
import {
  createBook,
  createChapter,
  getChapter,
  saveChapterContent,
} from './helpers/book-fixtures.js';

const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';

function mockUsage() {
  return {
    inputTokens: { total: 1200, noCache: 1200, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 300, text: 300, reasoning: 0 },
  };
}

/** 返回合法摘要 JSON 的模型（同时验证 lorekeeper 提炼链路）。 */
function createSummaryModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' } as const,
      usage: mockUsage(),
      warnings: [],
    },
  });
}

describe('Book Bible：总大纲 / 设定卡 / 章节摘要', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('未填写总大纲时返回空默认结构（updatedAt: null），保存后可完整回显', async () => {
    context = await createTestServer();
    const book = await createBook(context.app, { title: '长夜行舟' });

    const empty = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/outline`,
    });
    expect(empty.statusCode).toBe(200);
    const emptyBody = empty.json<BookOutlineDto>();
    expect(emptyBody).toEqual({
      bookId: book.id,
      mainPlot: '',
      worldSetting: '',
      styleGuide: '',
      endingPlan: '',
      updatedAt: null,
    });

    const saved = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/books/${book.id}/outline`,
      payload: {
        mainPlot: '少年自边城启程，追查失踪的兄长。',
        worldSetting: '九州灵潮复苏，修行者以剑意沟通天地。',
        styleGuide: '第三人称限知视角，短句为主，禁用现代词汇。',
        endingPlan: '三卷揭幕，五卷收束兄长线索，终卷决战。',
      },
    });
    expect(saved.statusCode).toBe(200);
    const savedBody = saved.json<BookOutlineDto>();
    expect(savedBody.mainPlot).toContain('边城');
    expect(savedBody.updatedAt).not.toBeNull();

    const reloaded = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/outline`,
    });
    expect(reloaded.json<BookOutlineDto>()).toEqual(savedBody);

    // 再次保存为整段覆盖
    const overwritten = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/books/${book.id}/outline`,
      payload: { mainPlot: '新的主线', worldSetting: '', styleGuide: '', endingPlan: '' },
    });
    expect(overwritten.statusCode).toBe(200);
    expect(overwritten.json<BookOutlineDto>().mainPlot).toBe('新的主线');
    expect(overwritten.json<BookOutlineDto>().worldSetting).toBe('');

    // 回收站中的书籍不可读写
    await context.app.inject({ method: 'DELETE', url: `/api/v1/books/${book.id}` });
    const trashed = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/outline`,
    });
    expect(trashed.statusCode).toBe(404);
  });

  it('设定卡 CRUD、分类/常驻/关键字筛选、跨书 404 且不泄露原始向量', async () => {
    context = await createTestServer();
    const book = await createBook(context.app, { title: '山河剑歌' });
    const otherBook = await createBook(context.app, { title: '另一本书' });

    const created = await context.app.inject({
      method: 'POST',
      url: `/api/v1/books/${book.id}/cards`,
      payload: {
        category: 'character',
        title: '沈墨',
        summary: '边城出身的少年剑客',
        content: '左手持断剑，性格隐忍，师承无名老道。',
        aliases: ['小沈', '墨哥'],
        tags: ['主角', '剑修'],
        pinned: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const card = created.json<KnowledgeCardDto>();
    expect(card.category).toBe('character');
    expect(card.pinned).toBe(true);
    expect(card.sortOrder).toBe(0);
    expect(card.hasEmbedding).toBe(false);
    expect(card.embeddingModelRef).toBeNull();

    const worldCard = await context.app.inject({
      method: 'POST',
      url: `/api/v1/books/${book.id}/cards`,
      payload: {
        category: 'world',
        title: '灵潮海',
        summary: '灵气汇聚之地',
        content: '每逢月圆灵力暴动，寻常修士不敢靠近。',
      },
    });
    expect(worldCard.statusCode).toBe(201);
    expect(worldCard.json<KnowledgeCardDto>().sortOrder).toBe(1);

    // 分类筛选
    const byCategory = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/cards?category=world`,
    });
    expect(byCategory.statusCode).toBe(200);
    const categoryBody = byCategory.json<KnowledgeCardListResponse>();
    expect(categoryBody.total).toBe(1);
    expect(categoryBody.items[0]?.title).toBe('灵潮海');

    // 常驻筛选（置顶卡排在最前）
    const pinned = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/cards?pinned=true`,
    });
    expect(pinned.json<KnowledgeCardListResponse>().items.map((item) => item.title)).toEqual([
      '沈墨',
    ]);

    // 关键字命中别名（大小写不敏感对中文等价于精确包含）
    const byAlias = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/cards?q=${encodeURIComponent('墨哥')}`,
    });
    expect(byAlias.json<KnowledgeCardListResponse>().items.map((item) => item.title)).toEqual([
      '沈墨',
    ]);

    // 关键字命中文正文
    const byContent = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/cards?q=${encodeURIComponent('月圆')}`,
    });
    expect(byContent.json<KnowledgeCardListResponse>().items.map((item) => item.title)).toEqual([
      '灵潮海',
    ]);

    // 空关键字视为未传（不返回 400）
    const noKeyword = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/cards?q=`,
    });
    expect(noKeyword.statusCode).toBe(200);
    expect(noKeyword.json<KnowledgeCardListResponse>().total).toBe(2);

    // 更新：取消置顶并改写摘要
    const patched = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/books/${book.id}/cards/${card.id}`,
      payload: { pinned: false, summary: '边城出身的少年剑客（已更新）' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<KnowledgeCardDto>().pinned).toBe(false);
    expect(patched.json<KnowledgeCardDto>().summary).toContain('已更新');

    // 读取单张卡
    const detail = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/cards/${card.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<KnowledgeCardDto>().id).toBe(card.id);

    // 跨书访问 → 404 KNOWLEDGE_CARD_NOT_FOUND
    const crossBook = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${otherBook.id}/cards/${card.id}`,
    });
    expect(crossBook.statusCode).toBe(404);
    expect(crossBook.json<ApiError>().code).toBe('KNOWLEDGE_CARD_NOT_FOUND');

    const crossPatch = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/books/${otherBook.id}/cards/${card.id}`,
      payload: { pinned: true },
    });
    expect(crossPatch.statusCode).toBe(404);
    expect(crossPatch.json<ApiError>().code).toBe('KNOWLEDGE_CARD_NOT_FOUND');

    const missing = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/cards/${UNKNOWN_ID}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiError>().code).toBe('KNOWLEDGE_CARD_NOT_FOUND');

    // 服务端写入向量后：仅暴露 hasEmbedding / embeddingModelRef，绝不下发原始浮点数组
    const persisted = [...context.store.state.cards.values()].find((item) => item.id === card.id);
    expect(persisted).toBeDefined();
    await context.store.knowledgeCards.update(card.id, {
      embedding: [0.123456, -0.654321],
      embeddingModelRef: 'Mock Provider/embedding-3',
    });
    const withVector = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/cards/${card.id}`,
    });
    expect(withVector.statusCode).toBe(200);
    const vectorBody = withVector.json<KnowledgeCardDto>();
    expect(vectorBody.hasEmbedding).toBe(true);
    expect(vectorBody.embeddingModelRef).toBe('Mock Provider/embedding-3');
    expect(withVector.body).not.toContain('0.123456');
    expect(withVector.body).not.toContain('-0.654321');
    expect(withVector.body).not.toContain('"embedding"');

    // 删除
    const removed = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${book.id}/cards/${card.id}`,
    });
    expect(removed.statusCode).toBe(204);
    const afterDelete = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/cards/${card.id}`,
    });
    expect(afterDelete.statusCode).toBe(404);
  });

  it('手工保存章节细纲与摘要：保留未传字段并强制 source=manual', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id, { title: '第一章 落雪' });

    const empty = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/summary`,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<ChapterSummaryDto>()).toEqual({
      chapterId: chapter.id,
      bookId: book.id,
      outline: '',
      summary: '',
      keyEvents: [],
      charactersPresent: [],
      source: 'manual',
      updatedAt: null,
    });

    const first = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/chapters/${chapter.id}/summary`,
      payload: {
        outline: '主角在落雪之夜抵达边城。',
        summary: '主角抵达边城并遇见守城老兵。',
        keyEvents: ['抵达边城', '遇见老兵'],
        charactersPresent: ['沈墨', '老兵'],
      },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<ChapterSummaryDto>();
    expect(firstBody.outline).toContain('落雪之夜');
    expect(firstBody.summary).toContain('守城老兵');
    expect(firstBody.source).toBe('manual');
    expect(firstBody.updatedAt).not.toBeNull();

    // 只更新摘要：细纲/关键事件/出场人物保留
    const second = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/chapters/${chapter.id}/summary`,
      payload: { summary: '主角抵达边城，老兵告知兄长线索。' },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<ChapterSummaryDto>();
    expect(secondBody.outline).toBe(firstBody.outline);
    expect(secondBody.keyEvents).toEqual(firstBody.keyEvents);
    expect(secondBody.charactersPresent).toEqual(firstBody.charactersPresent);
    expect(secondBody.summary).toContain('兄长线索');
    expect(secondBody.source).toBe('manual');

    // 回收站中的章节不可读写
    await context.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${chapter.id}` });
    const trashed = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/summary`,
    });
    expect(trashed.statusCode).toBe(404);
  });

  it('lorekeeper 提炼摘要：经网关落盘用量日志、保留原有细纲、source=ai', async () => {
    const summaryJson = JSON.stringify({
      summary: '沈墨在落雪之夜抵达边城，与守城老兵交谈后得知兄长曾向北行。',
      keyEvents: ['沈墨抵达边城', '老兵透露兄长向北'],
      charactersPresent: ['沈墨', '守城老兵'],
    });
    const gateway = new ModelGateway({
      createLanguageModel: () => createSummaryModel(summaryJson),
    });
    context = await createTestServer({ gateway });
    const seeded = await seedProviderAndModel(context, { providerName: 'Lore Provider' });
    await bindRole(context, 'lorekeeper', seeded.modelId, { temperature: 0.3, maxTokens: 2048 });

    const book = await createBook(context.app, { title: '落雪边城' });
    const chapter = await createChapter(context.app, book.id, { title: '第一章 落雪' });
    const content = '雪落边城，沈墨推门而入。老兵抬眼：你兄长三日前向北去了。';
    await saveChapterContent(context.app, chapter.id, {
      contentText: content,
      expectedVersion: 1,
    });

    // 先保留一条手工细纲，验证 AI 提炼不会覆盖它
    await context.app.inject({
      method: 'PUT',
      url: `/api/v1/chapters/${chapter.id}/summary`,
      payload: { outline: '本章目标：交代主角抵达边城与兄长线索。' },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/summary/extract`,
      payload: { instruction: '摘要聚焦兄长线索' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<ExtractChapterSummaryResponse>();
    expect(body.summary.source).toBe('ai');
    expect(body.summary.summary).toContain('沈墨');
    expect(body.summary.keyEvents).toEqual(['沈墨抵达边城', '老兵透露兄长向北']);
    expect(body.summary.charactersPresent).toEqual(['沈墨', '守城老兵']);
    expect(body.summary.outline).toBe('本章目标：交代主角抵达边城与兄长线索。');
    expect(body.modelRef).toBe('Lore Provider/mock-model');
    expect(body.usage.inputTokens).toBe(1200);
    expect(body.usage.outputTokens).toBe(300);
    expect(typeof body.usageLogId).toBe('string');
    expect(response.body).not.toContain(TEST_PROVIDER_API_KEY);

    // 用量日志：场景 lore-extract、角色 lorekeeper、成功、Token 落盘
    expect(context.store.state.logs).toHaveLength(1);
    const log = context.store.state.logs[0];
    expect(log?.id).toBe(body.usageLogId);
    expect(log?.scene).toBe('lore-extract');
    expect(log?.role).toBe('lorekeeper');
    expect(log?.status).toBe('success');
    expect(log?.modelRef).toBe('Lore Provider/mock-model');
    expect(log?.inputTokens).toBe(1200);
    expect(log?.outputTokens).toBe(300);

    // 落盘后的 GET 与提炼结果一致
    const persisted = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/summary`,
    });
    expect(persisted.json<ChapterSummaryDto>()).toEqual(body.summary);

    // save=false：仅预览，不落盘、不覆盖已保存摘要
    const preview = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/summary/extract`,
      payload: { save: false },
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json<ExtractChapterSummaryResponse>();
    expect(previewBody.summary.summary).toContain('沈墨');
    expect(previewBody.summary.outline).toBe('本章目标：交代主角抵达边城与兄长线索。');
    const stillSaved = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/summary`,
    });
    expect(stillSaved.json<ChapterSummaryDto>().updatedAt).toBe(body.summary.updatedAt);
  });

  it('供应商或模型停用时在调用上游前返回 409，且不写入用量日志', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);
    await saveChapterContent(context.app, chapter.id, {
      contentText: '正文已写好，但角色绑定的供应商被停用。',
      expectedVersion: 1,
    });

    const seeded = await seedProviderAndModel(context, {
      providerName: 'Disabled Provider',
      providerEnabled: false,
    });
    await bindRole(context, 'lorekeeper', seeded.modelId);

    const providerDisabled = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/summary/extract`,
      payload: {},
    });
    expect(providerDisabled.statusCode).toBe(409);
    expect(providerDisabled.json<ApiError>().code).toBe('PROVIDER_DISABLED');
    expect(context.store.state.logs).toHaveLength(0);
    expect(context.store.state.summaries.size).toBe(0);

    await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${seeded.providerId}`,
      payload: { isEnabled: true },
    });
    await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/models/${seeded.modelId}`,
      payload: { isEnabled: false },
    });

    const modelDisabled = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/summary/extract`,
      payload: {},
    });
    expect(modelDisabled.statusCode).toBe(409);
    expect(modelDisabled.json<ApiError>().code).toBe('MODEL_DISABLED');
    expect(context.store.state.logs).toHaveLength(0);
  });

  it('空正文提炼返回 400 AI_EMPTY_CONTEXT，未绑定 lorekeeper 返回 409 AGENT_ROLE_UNBOUND', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);

    const empty = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/summary/extract`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json<ApiError>().code).toBe('AI_EMPTY_CONTEXT');

    const content = '正文已经有了，但还没有绑定 lorekeeper。';
    await saveChapterContent(context.app, chapter.id, {
      contentText: content,
      expectedVersion: (await getChapter(context.app, chapter.id)).version,
    });

    const unbound = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/summary/extract`,
      payload: {},
    });
    expect(unbound.statusCode).toBe(409);
    expect(unbound.json<ApiError>().code).toBe('AGENT_ROLE_UNBOUND');
    expect(context.store.state.summaries.size).toBe(0);

    // 供应商停用也要在调用上游前拒绝
    const seeded = await seedProviderAndModel(context);
    await bindRole(context, 'lorekeeper', seeded.modelId);
    await unbindRole(context, 'lorekeeper');
    const unboundAgain = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/summary/extract`,
      payload: {},
    });
    expect(unboundAgain.statusCode).toBe(409);
    expect(unboundAgain.json<ApiError>().code).toBe('AGENT_ROLE_UNBOUND');
  });
});
