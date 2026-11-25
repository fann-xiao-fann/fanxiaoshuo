import type {
  ApiError,
  BookTrashResponse,
  BookDto,
  ChapterTreeItem,
  VolumeDto,
} from '@fanxiaoshuo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServerContext } from './helpers/in-memory.js';
import {
  createBook,
  createChapter,
  createVolume,
  getChapter,
  getTree,
  saveChapterContent,
} from './helpers/book-fixtures.js';

const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';

describe('卷章树与回收站视图', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('空书籍返回空目录树与零聚合', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);

    const tree = await getTree(context.app, book.id);
    expect(tree.book.id).toBe(book.id);
    expect(tree.volumes).toEqual([]);
    expect(tree.ungroupedChapters).toEqual([]);
    expect(tree.trashCount).toBe(0);
    expect(tree.book.volumeCount).toBe(0);
  });

  it('新建卷与章自动追加 sortOrder，树按序返回且不含正文', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const volume1 = await createVolume(context.app, book.id, { title: '第一卷' });
    const volume2 = await createVolume(context.app, book.id, { title: '第二卷' });
    expect(volume1.sortOrder).toBe(0);
    expect(volume2.sortOrder).toBe(1);

    const chapter1 = await createChapter(context.app, book.id, {
      title: '第一章',
      volumeId: volume1.id,
    });
    const chapter2 = await createChapter(context.app, book.id, {
      title: '第二章',
      volumeId: volume1.id,
    });
    const loose = await createChapter(context.app, book.id, { title: '未分卷章' });
    expect([chapter1.sortOrder, chapter2.sortOrder, loose.sortOrder]).toEqual([0, 1, 0]);

    const content = '风起于青萍之末，浪成于微澜之间。';
    await saveChapterContent(context.app, chapter1.id, {
      contentText: content,
      expectedVersion: 1,
    });

    const tree = await getTree(context.app, book.id);
    expect(tree.volumes.map((node) => node.title)).toEqual(['第一卷', '第二卷']);
    expect(tree.volumes[0]?.chapters.map((chapter) => chapter.title)).toEqual([
      '第一章',
      '第二章',
    ]);
    expect(tree.volumes[0]?.chapterCount).toBe(2);
    expect(tree.volumes[0]?.totalWordCount).toBeGreaterThan(0);
    expect(tree.volumes[1]?.chapters).toEqual([]);
    expect(tree.ungroupedChapters.map((chapter) => chapter.title)).toEqual(['未分卷章']);
    expect(tree.book.chapterCount).toBe(3);

    const firstChapterNode = tree.volumes[0]?.chapters[0];
    expect(firstChapterNode).toBeDefined();
    expect(Object.keys(firstChapterNode ?? {})).not.toContain('contentText');
    expect(Object.keys(firstChapterNode ?? {})).not.toContain('contentJson');
  });

  it('不存在的书籍返回 404，非法 UUID 返回 400', async () => {
    context = await createTestServer();

    const missingTree = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${UNKNOWN_ID}/tree`,
    });
    expect(missingTree.statusCode).toBe(404);
    expect(missingTree.json<ApiError>().code).toBe('BOOK_NOT_FOUND');

    const missingTrash = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${UNKNOWN_ID}/trash`,
    });
    expect(missingTrash.statusCode).toBe(404);

    const invalid = await context.app.inject({
      method: 'GET',
      url: '/api/v1/books/nope/tree',
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('跨书越界与已删分卷创建章节被拦截', async () => {
    context = await createTestServer();
    const bookA = await createBook(context.app, { title: 'A 书' });
    const bookB = await createBook(context.app, { title: 'B 书' });
    const volumeOfA = await createVolume(context.app, bookA.id, { title: 'A 卷' });

    const crossBook = await context.app.inject({
      method: 'POST',
      url: `/api/v1/books/${bookB.id}/chapters`,
      payload: { title: '越界章', volumeId: volumeOfA.id },
    });
    expect(crossBook.statusCode).toBe(409);
    expect(crossBook.json<ApiError>().code).toBe('CONFLICT');

    const unknownVolume = await context.app.inject({
      method: 'POST',
      url: `/api/v1/books/${bookA.id}/chapters`,
      payload: { title: '幽灵卷章', volumeId: UNKNOWN_ID },
    });
    expect(unknownVolume.statusCode).toBe(404);
    expect(unknownVolume.json<ApiError>().code).toBe('VOLUME_NOT_FOUND');

    await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/volumes/${volumeOfA.id}`,
    });
    const deletedVolume = await context.app.inject({
      method: 'POST',
      url: `/api/v1/books/${bookA.id}/chapters`,
      payload: { title: '已删卷章', volumeId: volumeOfA.id },
    });
    expect(deletedVolume.statusCode).toBe(404);
    expect(deletedVolume.json<ApiError>().code).toBe('VOLUME_NOT_FOUND');
  });

  it('回收站中的书籍禁止新建卷 / 章', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    await context.app.inject({ method: 'DELETE', url: `/api/v1/books/${book.id}` });

    const volume = await context.app.inject({
      method: 'POST',
      url: `/api/v1/books/${book.id}/volumes`,
      payload: { title: '卷' },
    });
    expect(volume.statusCode).toBe(404);
    expect(volume.json<ApiError>().code).toBe('BOOK_NOT_FOUND');

    const chapter = await context.app.inject({
      method: 'POST',
      url: `/api/v1/books/${book.id}/chapters`,
      payload: { title: '章' },
    });
    expect(chapter.statusCode).toBe(404);
  });
});

describe('卷与章的元信息、排序与跨卷移动', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('PATCH /api/v1/volumes/:volumeId 可重命名并返回聚合', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const volume = await createVolume(context.app, book.id, { title: '旧卷名' });
    const chapter = await createChapter(context.app, book.id, { volumeId: volume.id });
    await saveChapterContent(context.app, chapter.id, {
      contentText: '卷内正文。',
      expectedVersion: 1,
    });

    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/volumes/${volume.id}`,
      payload: { title: '新卷名', summary: '卷简介' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<VolumeDto>();
    expect(body.title).toBe('新卷名');
    expect(body.summary).toBe('卷简介');
    expect(body.chapterCount).toBe(1);
    expect(body.totalWordCount).toBeGreaterThan(0);

    const unknown = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/volumes/${UNKNOWN_ID}`,
      payload: { title: '幽灵' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<ApiError>().code).toBe('VOLUME_NOT_FOUND');
  });

  it('PUT volumes/reorder 在单事务内重写 sortOrder，越界 ID 返回 409', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const first = await createVolume(context.app, book.id, { title: '甲卷' });
    const second = await createVolume(context.app, book.id, { title: '乙卷' });
    const third = await createVolume(context.app, book.id, { title: '丙卷' });

    const reorder = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/books/${book.id}/volumes/reorder`,
      payload: { volumeIds: [third.id, first.id, second.id] },
    });
    expect(reorder.statusCode).toBe(204);

    const tree = await getTree(context.app, book.id);
    expect(tree.volumes.map((node) => node.title)).toEqual(['丙卷', '甲卷', '乙卷']);
    expect(tree.volumes.map((node) => node.sortOrder)).toEqual([0, 1, 2]);

    const foreign = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/books/${book.id}/volumes/reorder`,
      payload: { volumeIds: [first.id, UNKNOWN_ID] },
    });
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json<ApiError>().code).toBe('CONFLICT');

    const duplicated = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/books/${book.id}/volumes/reorder`,
      payload: { volumeIds: [first.id, first.id] },
    });
    expect(duplicated.statusCode).toBe(400);
  });

  it('PUT chapters/reorder 支持同卷排序与跨卷移动，并同步卷章聚合', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const volumeA = await createVolume(context.app, book.id, { title: 'A 卷' });
    const volumeB = await createVolume(context.app, book.id, { title: 'B 卷' });
    const chapter1 = await createChapter(context.app, book.id, {
      title: '第一章',
      volumeId: volumeA.id,
    });
    const chapter2 = await createChapter(context.app, book.id, {
      title: '第二章',
      volumeId: volumeA.id,
    });
    const chapter3 = await createChapter(context.app, book.id, {
      title: '第三章',
      volumeId: volumeB.id,
    });

    // 把第二章移到 A 卷首位，第三章跨卷移到 A 卷末位。
    const reorder = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/books/${book.id}/chapters/reorder`,
      payload: {
        items: [
          { chapterId: chapter2.id, volumeId: volumeA.id, sortOrder: 0 },
          { chapterId: chapter1.id, volumeId: volumeA.id, sortOrder: 1 },
          { chapterId: chapter3.id, volumeId: volumeA.id, sortOrder: 2 },
        ],
      },
    });
    expect(reorder.statusCode).toBe(204);

    let tree = await getTree(context.app, book.id);
    expect(tree.volumes[0]?.chapters.map((chapter) => chapter.title)).toEqual([
      '第二章',
      '第一章',
      '第三章',
    ]);
    expect(tree.volumes[1]?.chapters).toEqual([]);

    // 再把第一章移到未分卷区。
    const moveUngrouped = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/books/${book.id}/chapters/reorder`,
      payload: { items: [{ chapterId: chapter1.id, volumeId: null, sortOrder: 0 }] },
    });
    expect(moveUngrouped.statusCode).toBe(204);

    tree = await getTree(context.app, book.id);
    expect(tree.ungroupedChapters.map((chapter) => chapter.title)).toEqual(['第一章']);
    expect(tree.volumes[0]?.chapterCount).toBe(2);
  });

  it('跨书章节或分卷参与重排返回 409', async () => {
    context = await createTestServer();
    const bookA = await createBook(context.app, { title: 'A 书' });
    const bookB = await createBook(context.app, { title: 'B 书' });
    const chapterOfB = await createChapter(context.app, bookB.id, { title: 'B 章' });
    const volumeOfB = await createVolume(context.app, bookB.id, { title: 'B 卷' });

    const foreignChapter = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/books/${bookA.id}/chapters/reorder`,
      payload: { items: [{ chapterId: chapterOfB.id, volumeId: null, sortOrder: 0 }] },
    });
    expect(foreignChapter.statusCode).toBe(409);
    expect(foreignChapter.json<ApiError>().code).toBe('CONFLICT');

    const chapterOfA = await createChapter(context.app, bookA.id, { title: 'A 章' });
    const foreignVolume = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/books/${bookA.id}/chapters/reorder`,
      payload: {
        items: [{ chapterId: chapterOfA.id, volumeId: volumeOfB.id, sortOrder: 0 }],
      },
    });
    expect(foreignVolume.statusCode).toBe(409);
  });

  it('PATCH /api/v1/chapters/:chapterId 支持改标题、状态与跨卷移动', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const volume = await createVolume(context.app, book.id);
    const chapter = await createChapter(context.app, book.id, { title: '旧章名' });

    const renamed = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/chapters/${chapter.id}`,
      payload: { title: '新章名', status: 'final', volumeId: volume.id },
    });
    expect(renamed.statusCode).toBe(200);
    const body = renamed.json<ChapterTreeItem & { contentText: string }>();
    expect(body.title).toBe('新章名');
    expect(body.status).toBe('final');
    expect(body.volumeId).toBe(volume.id);
    expect(body.contentText).toBe('');

    const otherBook = await createBook(context.app, { title: '另一本' });
    const foreignVolume = await createVolume(context.app, otherBook.id);
    const crossBook = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/chapters/${chapter.id}`,
      payload: { volumeId: foreignVolume.id },
    });
    expect(crossBook.statusCode).toBe(409);

    const missing = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/chapters/${UNKNOWN_ID}`,
      payload: { title: '幽灵' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiError>().code).toBe('CHAPTER_NOT_FOUND');
  });
});

describe('软删除、回收站与永久删除', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('软删除分卷后目录树隐藏该卷及其章节，全书字数即时重算，可恢复', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const volume = await createVolume(context.app, book.id, { title: '待删卷' });
    const chapter = await createChapter(context.app, book.id, {
      title: '卷内章',
      volumeId: volume.id,
    });
    await saveChapterContent(context.app, chapter.id, {
      contentText: '卷内正文内容。',
      expectedVersion: 1,
    });

    const before = await getTree(context.app, book.id);
    const wordsBefore = before.book.totalWordCount;
    expect(wordsBefore).toBeGreaterThan(0);

    const deleted = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/volumes/${volume.id}`,
    });
    expect(deleted.statusCode).toBe(204);

    const afterDelete = await getTree(context.app, book.id);
    expect(afterDelete.volumes).toEqual([]);
    expect(afterDelete.ungroupedChapters).toEqual([]);
    expect(afterDelete.book.totalWordCount).toBe(0);
    expect(afterDelete.trashCount).toBe(1);

    const trashResponse = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/trash`,
    });
    expect(trashResponse.statusCode).toBe(200);
    const trash = trashResponse.json<BookTrashResponse>();
    expect(trash.volumes.map((item) => item.title)).toEqual(['待删卷']);
    expect(trash.chapters).toEqual([]);

    const restored = await context.app.inject({
      method: 'POST',
      url: `/api/v1/volumes/${volume.id}/restore`,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<VolumeDto>().deletedAt).toBeNull();

    const afterRestore = await getTree(context.app, book.id);
    expect(afterRestore.volumes[0]?.chapters.map((item) => item.title)).toEqual(['卷内章']);
    expect(afterRestore.book.totalWordCount).toBe(wordsBefore);
  });

  it('永久删除分卷需先软删，删除后其章节归入未分卷区且正文保留', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const volume = await createVolume(context.app, book.id, { title: '临时卷' });
    const chapter = await createChapter(context.app, book.id, {
      title: '保留章',
      volumeId: volume.id,
    });
    await saveChapterContent(context.app, chapter.id, {
      contentText: '不能被静默丢弃的正文。',
      expectedVersion: 1,
    });

    const guarded = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/volumes/${volume.id}?permanent=true`,
    });
    expect(guarded.statusCode).toBe(409);
    expect(guarded.json<ApiError>().code).toBe('CONFLICT');

    await context.app.inject({ method: 'DELETE', url: `/api/v1/volumes/${volume.id}` });
    const purged = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/volumes/${volume.id}?permanent=true`,
    });
    expect(purged.statusCode).toBe(204);

    const tree = await getTree(context.app, book.id);
    expect(tree.volumes).toEqual([]);
    expect(tree.ungroupedChapters.map((item) => item.title)).toEqual(['保留章']);

    const detail = await getChapter(context.app, chapter.id);
    expect(detail.volumeId).toBeNull();
    expect(detail.contentText).toBe('不能被静默丢弃的正文。');
  });

  it('章节软删除进入回收站并可恢复 / 彻底删除', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id, { title: '待删章' });
    await saveChapterContent(context.app, chapter.id, {
      contentText: '章节正文。',
      expectedVersion: 1,
    });

    await context.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${chapter.id}` });

    const trashResponse = await context.app.inject({
      method: 'GET',
      url: `/api/v1/books/${book.id}/trash`,
    });
    const trash = trashResponse.json<BookTrashResponse>();
    expect(trash.chapters.map((item) => item.title)).toEqual(['待删章']);
    expect(trash.chapters[0]?.deletedAt).not.toBeNull();

    const hidden = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}`,
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json<ApiError>().code).toBe('CHAPTER_NOT_FOUND');

    const restored = await context.app.inject({
      method: 'POST',
      url: `/api/v1/chapters/${chapter.id}/restore`,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<BookDto>()).toBeTruthy();

    const activeTree = await getTree(context.app, book.id);
    expect(activeTree.book.chapterCount).toBe(1);

    await context.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${chapter.id}` });
    const purged = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/chapters/${chapter.id}?permanent=true`,
    });
    expect(purged.statusCode).toBe(204);

    const gone = await context.app.inject({
      method: 'GET',
      url: `/api/v1/chapters/${chapter.id}`,
    });
    expect(gone.statusCode).toBe(404);
  });

  it('永久删除活跃章节返回 409，未知节点返回 404', async () => {
    context = await createTestServer();
    const book = await createBook(context.app);
    const chapter = await createChapter(context.app, book.id, { title: '活跃章' });

    const guarded = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/chapters/${chapter.id}?permanent=true`,
    });
    expect(guarded.statusCode).toBe(409);

    const unknownChapter = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/chapters/${UNKNOWN_ID}`,
    });
    expect(unknownChapter.statusCode).toBe(404);

    const unknownVolume = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/volumes/${UNKNOWN_ID}`,
    });
    expect(unknownVolume.statusCode).toBe(404);
    expect(unknownVolume.json<ApiError>().code).toBe('VOLUME_NOT_FOUND');
  });
});
