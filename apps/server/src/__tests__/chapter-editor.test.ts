import type {
  ApiError,
  BookListResponse,
  ChapterRevisionDetail,
  ChapterRevisionListResponse,
  ChapterSaveResponse,
  RestoreChapterRevisionResponse,
} from '@fanxiaoshuo/shared';
import { countNovelWords } from '@fanxiaoshuo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServerContext } from './helpers/in-memory.js';
import {
  createBook,
  createChapter,
  createManualClock,
  getChapter,
  saveChapterContent,
} from './helpers/book-fixtures.js';

const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';

describe('章节正文读取与乐观并发保存', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('GET /api/v1/chapters/:chapterId 返回初始正文与版本号', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id, { title: '第一章 剑来' });

    const detail = await getChapter(context.app, chapter.id);
    expect(detail.id).toBe(chapter.id);
    expect(detail.bookId).toBe(book.id);
    expect(detail.title).toBe('第一章 剑来');
    expect(detail.status).toBe('draft');
    expect(detail.contentText).toBe('');
    expect(detail.contentJson).toBeNull();
    expect(detail.wordCount).toBe(0);
    expect(detail.version).toBe(1);
  });

  it('保存正文时服务端重算字数、递增版本并可选更新标题', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id, { title: '第一章' });

    const content = '第一章 风起，Hello World!\n\n第二段：雨落长安。';
    const saved = await saveChapterContent(context.app, chapter.id, {
      title: '第一章 风起',
      contentText: content,
      contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
      expectedVersion: 1,
    });

    expect(saved.chapter.version).toBe(2);
    expect(saved.chapter.title).toBe('第一章 风起');
    expect(saved.chapter.wordCount).toBe(countNovelWords(content));
    expect(saved.chapter.contentText).toBe(content);
    expect(saved.autoRevisionCreated).toBe(true);

    const detail = await getChapter(context.app, chapter.id);
    expect(detail.contentJson).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(detail.version).toBe(2);
  });

  it('拒绝客户端自带 wordCount 等未知字段（字数绝不由客户端决定）', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);

    const rejected = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/chapters/${chapter.id}/content`,
      payload: { contentText: '正文', expectedVersion: 1, wordCount: 999999 },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<ApiError>().code).toBe('VALIDATION_ERROR');

    const detail = await getChapter(context.app, chapter.id);
    expect(detail.wordCount).toBe(0);
    expect(detail.version).toBe(1);
  });

  it('版本号过期时返回 409 CHAPTER_VERSION_CONFLICT 并携带服务端最新版本', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);

    await saveChapterContent(context.app, chapter.id, {
      contentText: '第一版正文。',
      expectedVersion: 1,
    });

    const conflict = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/chapters/${chapter.id}/content`,
      payload: { contentText: '过期客户端正文。', expectedVersion: 1 },
    });

    expect(conflict.statusCode).toBe(409);
    const body = conflict.json<ApiError>();
    expect(body.code).toBe('CHAPTER_VERSION_CONFLICT');
    expect(body.details?.[0]?.path).toBe('expectedVersion');
    expect(body.details?.[0]?.message).toContain('currentVersion=2');

    const detail = await getChapter(context.app, chapter.id);
    expect(detail.contentText).toBe('第一版正文。');
    expect(detail.version).toBe(2);
  });

  it('forceOverwrite 覆盖前自动留底 restore 快照', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);

    await saveChapterContent(context.app, chapter.id, {
      contentText: '数据库里的较新正文。',
      expectedVersion: 1,
    });

    const forced = await saveChapterContent(context.app, chapter.id, {
      contentText: '用户强制覆盖的正文。',
      expectedVersion: 1,
      forceOverwrite: true,
    });

    expect(forced.chapter.contentText).toBe('用户强制覆盖的正文。');
    expect(forced.chapter.version).toBe(3);
    expect(forced.autoRevisionCreated).toBe(false);

    const revisions = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/revisions`,
    });
    const list = revisions.json<ChapterRevisionListResponse>();
    expect(list.items[0]?.source).toBe('restore');
    expect(list.items[0]?.note).toBe('强制覆盖前自动备份');
    expect('contentText' in (list.items[0] ?? {})).toBe(false);

    const backup = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/revisions/${list.items[0]?.id}`,
    });
    expect(backup.json<ChapterRevisionDetail>().contentText).toBe('数据库里的较新正文。');
  });

  it('自动快照按节流间隔生成、跳过与去重', async () => {
    const clock = createManualClock();
    context = await createTestServer({ clock });
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);

    const first = await saveChapterContent(context.app, chapter.id, {
      contentText: '第一次保存的正文。',
      expectedVersion: 1,
    });
    expect(first.autoRevisionCreated).toBe(true);

    // 距上次 auto 快照仅 1 分钟：内容有变化但被节流跳过。
    clock.advance(60_000);
    const throttled = await saveChapterContent(context.app, chapter.id, {
      contentText: '第二次保存的正文。',
      expectedVersion: 2,
    });
    expect(throttled.autoRevisionCreated).toBe(false);

    let revisions = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/revisions`,
    });
    let list = revisions.json<ChapterRevisionListResponse>();
    expect(list.items.filter((item) => item.source === 'auto')).toHaveLength(1);

    // 超过 5 分钟窗口：再次自动留底。
    clock.advance(5 * 60 * 1000);
    const allowed = await saveChapterContent(context.app, chapter.id, {
      contentText: '第三次保存的正文。',
      expectedVersion: 3,
    });
    expect(allowed.autoRevisionCreated).toBe(true);

    // 内容与最近一次快照完全一致：不再重复留底。
    clock.advance(10 * 60 * 1000);
    const unchanged = await saveChapterContent(context.app, chapter.id, {
      contentText: '第三次保存的正文。',
      expectedVersion: 4,
    });
    expect(unchanged.autoRevisionCreated).toBe(false);

    revisions = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/revisions`,
    });
    list = revisions.json<ChapterRevisionListResponse>();
    expect(list.items.filter((item) => item.source === 'auto')).toHaveLength(2);

    // 空正文不产生自动快照。
    clock.advance(10 * 60 * 1000);
    const blank = await saveChapterContent(context.app, chapter.id, {
      contentText: '   \n\n  ',
      expectedVersion: 5,
    });
    expect(blank.autoRevisionCreated).toBe(false);
    expect(blank.chapter.wordCount).toBe(0);
  });

  it('已删除章节禁止读取 / 保存正文', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);
    await context.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${chapter.id}` });

    const read = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}`,
    });
    expect(read.statusCode).toBe(404);
    expect(read.json<ApiError>().code).toBe('CHAPTER_NOT_FOUND');

    const save = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/chapters/${chapter.id}/content`,
      payload: { contentText: '正文', expectedVersion: 1 },
    });
    expect(save.statusCode).toBe(404);

    const missing = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/chapters/${UNKNOWN_ID}/content`,
      payload: { contentText: '正文', expectedVersion: 1 },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('保存正文后书架与目录树字数立即同步', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);

    const content = '剑光照亮整座长安城。';
    await saveChapterContent(context.app, chapter.id, {
      contentText: content,
      expectedVersion: 1,
    });

    const list = await context.app.inject({ method: 'GET', url: '/api/v1/books' });
    const item = list.json<BookListResponse>().items[0];
    expect(item?.totalWordCount).toBe(countNovelWords(content));
    expect(item?.chapterCount).toBe(1);
  });
});

describe('章节历史快照与安全回滚', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('手动快照按时间倒序返回，详情包含完整正文', async () => {
    const clock = createManualClock();
    context = await createTestServer({ clock });
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id, { title: '第一章' });

    await saveChapterContent(context.app, chapter.id, {
      contentText: '初稿正文。',
      expectedVersion: 1,
    });

    clock.advance(1000);
    const first = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/revisions`,
      payload: { note: '初稿留底' },
    });
    expect(first.statusCode).toBe(201);
    const firstDetail = first.json<ChapterRevisionDetail>();
    expect(firstDetail.source).toBe('manual');
    expect(firstDetail.note).toBe('初稿留底');
    expect(firstDetail.contentText).toBe('初稿正文。');
    expect(firstDetail.version).toBe(2);

    clock.advance(1000);
    const second = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/revisions`,
      payload: {},
    });
    expect(second.statusCode).toBe(201);
    const secondDetail = second.json<ChapterRevisionDetail>();
    expect(secondDetail.note).toBe('');

    const listResponse = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/revisions`,
    });
    const list = listResponse.json<ChapterRevisionListResponse>();
    expect(list.total).toBeGreaterThanOrEqual(2);
    expect(list.items[0]?.id).toBe(secondDetail.id);
    expect(list.items[1]?.id).toBe(firstDetail.id);

    const detail = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/revisions/${firstDetail.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<ChapterRevisionDetail>().contentText).toBe('初稿正文。');
  });

  it('快照不属于该章节或不存在时返回 404 REVISION_NOT_FOUND', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapterA = await createChapter(context.app, book.id, { title: '甲章' });
    const chapterB = await createChapter(context.app, book.id, { title: '乙章' });

    const created = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapterA.id}/revisions`,
      payload: { note: '甲章快照' },
    });
    const revision = created.json<ChapterRevisionDetail>();

    const crossChapter = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapterB.id}/revisions/${revision.id}`,
    });
    expect(crossChapter.statusCode).toBe(404);
    expect(crossChapter.json<ApiError>().code).toBe('REVISION_NOT_FOUND');

    const missing = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapterA.id}/revisions/${UNKNOWN_ID}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiError>().code).toBe('REVISION_NOT_FOUND');

    const restoreCross = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapterB.id}/revisions/${revision.id}/restore`,
    });
    expect(restoreCross.statusCode).toBe(404);
  });

  it('回滚先把当前正文留底为 restore 快照，再回滚并递增版本，可二次恢复', async () => {
    const clock = createManualClock();
    context = await createTestServer({ clock });
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id, { title: '第一章' });

    await saveChapterContent(context.app, chapter.id, {
      contentText: '第一版正文。',
      expectedVersion: 1,
    });

    clock.advance(1000);
    const snapshot = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/revisions`,
      payload: { note: '第一版留底' },
    });
    const snapshotDetail = snapshot.json<ChapterRevisionDetail>();

    clock.advance(1000);
    const secondSave = await saveChapterContent(context.app, chapter.id, {
      contentText: '第二版正文。',
      expectedVersion: 2,
    });
    expect(secondSave.chapter.version).toBe(3);

    clock.advance(1000);
    const restore = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/revisions/${snapshotDetail.id}/restore`,
    });
    expect(restore.statusCode).toBe(200);
    const restored = restore.json<RestoreChapterRevisionResponse>();
    expect(restored.chapter.contentText).toBe('第一版正文。');
    expect(restored.chapter.version).toBe(4);
    expect(restored.chapter.wordCount).toBe(countNovelWords('第一版正文。'));
    expect(restored.backupRevision.source).toBe('restore');
    expect(restored.backupRevision.note).toContain('回滚至 v2 前自动备份');
    expect('contentText' in restored.backupRevision).toBe(false);

    const backupDetail = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/revisions/${restored.backupRevision.id}`,
    });
    expect(backupDetail.json<ChapterRevisionDetail>().contentText).toBe('第二版正文。');

    // 二次恢复：把回滚前留底的版本再滚回来。
    clock.advance(1000);
    const secondRestore = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/revisions/${restored.backupRevision.id}/restore`,
    });
    expect(secondRestore.statusCode).toBe(200);
    const secondRestored = secondRestore.json<RestoreChapterRevisionResponse>();
    expect(secondRestored.chapter.contentText).toBe('第二版正文。');
    expect(secondRestored.chapter.version).toBe(5);
    expect(secondRestored.backupRevision.note).toContain('回滚至 v3 前自动备份');
  });

  it('回滚后的章节可继续用新版本号保存正文', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);

    await saveChapterContent(context.app, chapter.id, {
      contentText: 'A 版本。',
      expectedVersion: 1,
    });
    const snapshot = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/revisions`,
      payload: { note: 'A 版本' },
    });
    const snapshotDetail = snapshot.json<ChapterRevisionDetail>();

    const restore = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/revisions/${snapshotDetail.id}/restore`,
    });
    const restored = restore.json<RestoreChapterRevisionResponse>();

    const saved: ChapterSaveResponse = await saveChapterContent(context.app, chapter.id, {
      contentText: 'B 版本。',
      expectedVersion: restored.chapter.version,
    });
    expect(saved.chapter.version).toBe(restored.chapter.version + 1);
    expect(saved.chapter.contentText).toBe('B 版本。');
  });

  it('已删除章节的快照读取与回滚返回 404', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id);
    const created = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/revisions`,
      payload: { note: '留底' },
    });
    const revision = created.json<ChapterRevisionDetail>();

    await context.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${chapter.id}` });

    const list = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}/revisions`,
    });
    expect(list.statusCode).toBe(404);

    const restore = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/revisions/${revision.id}/restore`,
    });
    expect(restore.statusCode).toBe(404);
    expect(restore.json<ApiError>().code).toBe('CHAPTER_NOT_FOUND');
  });
});
