import type { ApiError, BookDto, BookListResponse } from '@fanxiaoshuo/shared';
import { countNovelWords } from '@fanxiaoshuo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestServer,
  type TestServerContext,
} from './helpers/in-memory.js';
import {
  createBook,
  createChapter,
  createVolume,
  saveChapterContent,
} from './helpers/book-fixtures.js';

const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';

describe('书库 CRUD、筛选与回收站', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('POST /api/v1/books 创建书籍并返回零聚合初始值', async () => {
    context = await createTestServer();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/books',
      payload: {
        title: '  剑起长安  ',
        authorPenName: '青衫客',
        genre: '玄幻',
        status: 'ongoing',
        synopsis: '一剑破万法。',
        targetChapterWords: 2400,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<BookDto>();
    expect(body.title).toBe('剑起长安');
    expect(body.authorPenName).toBe('青衫客');
    expect(body.status).toBe('ongoing');
    expect(body.targetChapterWords).toBe(2400);
    expect(body.volumeCount).toBe(0);
    expect(body.chapterCount).toBe(0);
    expect(body.totalWordCount).toBe(0);
    expect(body.deletedAt).toBeNull();
  });

  it('创建书籍时缺省字段使用契约默认值', async () => {
    context = await createTestServer();
    const body = await createBook(context.app);

    expect(body.authorPenName).toBe('');
    expect(body.genre).toBe('');
    expect(body.status).toBe('draft');
    expect(body.synopsis).toBe('');
    expect(body.targetChapterWords).toBe(3000);
  });

  it('非法书名 / 目标字数返回 400 结构化字段错误且不落库', async () => {
    context = await createTestServer();

    const emptyTitle = await context.app.inject({
      method: 'POST',
      url: '/api/v1/books',
      payload: { title: '   ' },
    });
    expect(emptyTitle.statusCode).toBe(400);
    const titleError = emptyTitle.json<ApiError>();
    expect(titleError.code).toBe('VALIDATION_ERROR');
    expect(titleError.details?.[0]?.path).toBe('title');

    const badWords = await context.app.inject({
      method: 'POST',
      url: '/api/v1/books',
      payload: { title: '合法书名', targetChapterWords: 0 },
    });
    expect(badWords.statusCode).toBe(400);
    expect(badWords.json<ApiError>().details?.[0]?.path).toBe('targetChapterWords');

    const list = await context.app.inject({ method: 'GET', url: '/api/v1/books' });
    expect(list.json<BookListResponse>().items).toHaveLength(0);
  });

  it('GET /api/v1/books 支持状态、关键字筛选并返回卷章聚合', async () => {
    context = await createTestServer();
    const novel = await createBook(context.app, {
      title: '剑起长安',
      authorPenName: '青衫客',
      synopsis: '少年提剑入长安。',
      status: 'ongoing',
    });
    await createBook(context.app, {
      title: '星海归途',
      authorPenName: '白露',
      synopsis: '星际航行的孤独旅人。',
      status: 'completed',
    });

    const volume = await createVolume(context.app, novel.id, { title: '第一卷 风起' });
    const chapter = await createChapter(context.app, novel.id, {
      title: '第一章 剑来',
      volumeId: volume.id,
    });
    const content = '剑光一闪，长安城的雪停了。';
    await saveChapterContent(context.app, chapter.id, {
      contentText: content,
      expectedVersion: 1,
    });

    const byStatus = await context.app.inject({
      method: 'GET',
      url: '/api/v1/books?status=ongoing',
    });
    const statusBody = byStatus.json<BookListResponse>();
    expect(statusBody.total).toBe(1);
    expect(statusBody.items[0]?.title).toBe('剑起长安');
    expect(statusBody.items[0]?.volumeCount).toBe(1);
    expect(statusBody.items[0]?.chapterCount).toBe(1);
    expect(statusBody.items[0]?.totalWordCount).toBe(countNovelWords(content));

    const byKeyword = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books?q=${encodeURIComponent('白露')}`,
    });
    const keywordBody = byKeyword.json<BookListResponse>();
    expect(keywordBody.total).toBe(1);
    expect(keywordBody.items[0]?.title).toBe('星海归途');

    const bySynopsis = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books?q=${encodeURIComponent('孤独旅人')}`,
    });
    expect(bySynopsis.json<BookListResponse>().items[0]?.title).toBe('星海归途');
  });

  it('GET/PATCH /api/v1/books/:bookId 返回详情并可局部更新', async () => {
    context = await createTestServer();
    const created = await createBook(context.app);

    const detail = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${created.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<BookDto>().id).toBe(created.id);

    const patched = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/books/${created.id}`,
      payload: { title: '新书名', status: 'archived' },
    });
    expect(patched.statusCode).toBe(200);
    const patchedBody = patched.json<BookDto>();
    expect(patchedBody.title).toBe('新书名');
    expect(patchedBody.status).toBe('archived');
    expect(patchedBody.authorPenName).toBe('');

    const emptyPatch = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/books/${created.id}`,
      payload: {},
    });
    expect(emptyPatch.statusCode).toBe(400);
  });

  it('不存在的书籍返回 404 BOOK_NOT_FOUND，非法 UUID 返回 400', async () => {
    context = await createTestServer();

    const missing = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${UNKNOWN_ID}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiError>().code).toBe('BOOK_NOT_FOUND');

    const invalid = await context.app.inject({
      method: 'GET',
      url: '/api/v1/books/not-a-uuid',
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<ApiError>().code).toBe('VALIDATION_ERROR');

    const patchMissing = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/books/${UNKNOWN_ID}`,
      payload: { title: '无名' },
    });
    expect(patchMissing.json<ApiError>().code).toBe('BOOK_NOT_FOUND');
  });

  it('软删除进入回收站、恢复后卷章结构完整保留', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const volume = await createVolume(context.app, book.id);
    const chapter = await createChapter(context.app, book.id, { volumeId: volume.id });
    await saveChapterContent(context.app, chapter.id, {
      contentText: '旧稿正文。',
      expectedVersion: 1,
    });

    const softDeleted = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${book.id}`,
    });
    expect(softDeleted.statusCode).toBe(204);

    const activeList = await context.app.inject({ method: 'GET', url: '/api/v1/books' });
    expect(activeList.json<BookListResponse>().total).toBe(0);

    const trashList = await context.app.inject({
      method: 'GET',
      url: '/api/v1/books?includeDeleted=only',
    });
    const trashBody = trashList.json<BookListResponse>();
    expect(trashBody.total).toBe(1);
    expect(trashBody.items[0]?.deletedAt).not.toBeNull();
    expect(trashBody.items[0]?.chapterCount).toBe(1);

    const restored = await context.app.inject({
      method: 'POST',
      url: `/api/v1/books/${book.id}/restore`,
    });
    expect(restored.statusCode).toBe(200);
    const restoredBody = restored.json<BookDto>();
    expect(restoredBody.deletedAt).toBeNull();
    expect(restoredBody.volumeCount).toBe(1);
    expect(restoredBody.chapterCount).toBe(1);

    const detail = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}`,
    });
    expect(detail.json<{ contentText: string }>().contentText).toBe('旧稿正文。');
  });

  it('DELETE ?permanent=true 仅允许对回收站书籍执行，防误删返回 409', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);

    const guarded = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${book.id}?permanent=true`,
    });
    expect(guarded.statusCode).toBe(409);
    expect(guarded.json<ApiError>().code).toBe('CONFLICT');

    const stillThere = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}`,
    });
    expect(stillThere.statusCode).toBe(200);

    await context.app.inject({ method: 'DELETE', url: `/api/v1/books/${book.id}` });
    const purged = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${book.id}?permanent=true`,
    });
    expect(purged.statusCode).toBe(204);

    const gone = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}`,
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json<ApiError>().code).toBe('BOOK_NOT_FOUND');

    const trash = await context.app.inject({
      method: 'GET',
      url: '/api/v1/books?includeDeleted=only',
    });
    expect(trash.json<BookListResponse>().total).toBe(0);
  });

  it('永久删除书籍级联清理卷、章与历史快照', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const volume = await createVolume(context.app, book.id);
    const chapter = await createChapter(context.app, book.id, { volumeId: volume.id });
    await saveChapterContent(context.app, chapter.id, {
      contentText: '待清理正文。',
      expectedVersion: 1,
    });
    await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/revisions`,
      payload: { note: '留底' },
    });

    await context.app.inject({ method: 'DELETE', url: `/api/v1/books/${book.id}` });
    await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${book.id}?permanent=true`,
    });

    expect(context.store.state.volumes.size).toBe(0);
    expect(context.store.state.chapters.size).toBe(0);
    expect(context.store.state.revisions.size).toBe(0);

    const chapterLookup = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}`,
    });
    expect(chapterLookup.statusCode).toBe(404);
  });
});

describe('整本导出 TXT / Markdown', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('导出 TXT 按卷/章 sortOrder 拼装并跳过软删节点，带 UTF-8 下载头', async () => {
    context = await createTestServer();
    const book = await createBook(context.app, {
      title: '剑起长安',
      synopsis: '少年提剑入长安。',
    });

    const volumeA = await createVolume(context.app, book.id, { title: '风起' });
    const volumeB = await createVolume(context.app, book.id, { title: '云涌' });
    const chapterA1 = await createChapter(context.app, book.id, {
      title: '第一章 剑来',
      volumeId: volumeA.id,
    });
    const chapterA2 = await createChapter(context.app, book.id, {
      title: '第二章 雪落',
      volumeId: volumeA.id,
    });
    const chapterB1 = await createChapter(context.app, book.id, {
      title: '第三章 云起',
      volumeId: volumeB.id,
    });
    const ungrouped = await createChapter(context.app, book.id, { title: '番外 旧事' });
    const chapterToDelete = await createChapter(context.app, book.id, {
      title: '待删章节',
      volumeId: volumeB.id,
    });

    await saveChapterContent(context.app, chapterA1.id, {
      contentText: '第一章正文。',
      expectedVersion: 1,
    });
    await saveChapterContent(context.app, chapterA2.id, {
      contentText: '第二章正文。',
      expectedVersion: 1,
    });
    await saveChapterContent(context.app, chapterB1.id, {
      contentText: '第三章正文。',
      expectedVersion: 1,
    });
    await saveChapterContent(context.app, ungrouped.id, {
      contentText: '番外正文。',
      expectedVersion: 1,
    });
    await saveChapterContent(context.app, chapterToDelete.id, {
      contentText: '不应被导出。',
      expectedVersion: 1,
    });
    await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/chapters/${chapterToDelete.id}`,
    });

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/export?format=txt`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    const disposition = String(response.headers['content-disposition']);
    expect(disposition).toContain('attachment;');
    expect(disposition).toContain('filename="book.txt"');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('剑起长安.txt')}`);

    const body = response.body;
    expect(body.startsWith('剑起长安\n\n少年提剑入长安。')).toBe(true);
    expect(body).toContain('第 1 卷 风起');
    expect(body).toContain('第 2 卷 云涌');
    expect(body).not.toContain('不应被导出');
    expect(body).not.toContain('待删章节');

    const orderIndexes = [
      body.indexOf('第一章 剑来'),
      body.indexOf('第二章 雪落'),
      body.indexOf('第三章 云起'),
      body.indexOf('番外 旧事'),
    ];
    expect(orderIndexes.every((index) => index >= 0)).toBe(true);
    expect([...orderIndexes].sort((a, b) => a - b)).toEqual(orderIndexes);
  });

  it('导出 Markdown 使用 #/##/### 分层并排除软删卷下的章节', async () => {
    context = await createTestServer();
    const book = await createBook(context.app, { title: '星海归途', synopsis: '' });

    const keptVolume = await createVolume(context.app, book.id, { title: '启航' });
    const droppedVolume = await createVolume(context.app, book.id, { title: '弃卷' });
    const keptChapter = await createChapter(context.app, book.id, {
      title: '第一章 远行',
      volumeId: keptVolume.id,
    });
    const droppedChapter = await createChapter(context.app, book.id, {
      title: '弃章',
      volumeId: droppedVolume.id,
    });

    await saveChapterContent(context.app, keptChapter.id, {
      contentText: '远行的第一段。',
      expectedVersion: 1,
    });
    await saveChapterContent(context.app, droppedChapter.id, {
      contentText: '弃卷正文。',
      expectedVersion: 1,
    });
    await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/volumes/${droppedVolume.id}`,
    });

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/export?format=md`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(String(response.headers['content-disposition'])).toContain(
      `filename*=UTF-8''${encodeURIComponent('星海归途.md')}`,
    );

    const body = response.body;
    expect(body).toContain('# 星海归途');
    expect(body).toContain('## 启航');
    expect(body).toContain('### 第一章 远行');
    expect(body).toContain('远行的第一段。');
    expect(body).not.toContain('## 弃卷');
    expect(body).not.toContain('弃卷正文。');
  });

  it('回收站书籍、非法格式与不存在书籍导出均被拦截', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);

    const invalidFormat = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/export?format=pdf`,
    });
    expect(invalidFormat.statusCode).toBe(400);

    const missingFormat = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/export`,
    });
    expect(missingFormat.statusCode).toBe(400);

    const unknown = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${UNKNOWN_ID}/export?format=txt`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<ApiError>().code).toBe('BOOK_NOT_FOUND');

    await context.app.inject({ method: 'DELETE', url: `/api/v1/books/${book.id}` });
    const trashed = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/export?format=txt`,
    });
    expect(trashed.statusCode).toBe(404);
    expect(trashed.json<ApiError>().code).toBe('BOOK_NOT_FOUND');
  });
});
