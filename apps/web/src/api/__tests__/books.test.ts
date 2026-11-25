import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  booksApi,
  chaptersApi,
  downloadBookExport,
  parseContentDispositionFilename,
  triggerBlobDownload,
  volumesApi,
} from '@/api/books';

const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const CHAPTER_ID = '22222222-2222-4222-8222-222222222222';
const VOLUME_ID = '33333333-3333-4333-8333-333333333333';
const REVISION_ID = '44444444-4444-4444-8444-444444444444';

const NOW = '2024-05-01T10:00:00.000Z';

function bookDto() {
  return {
    id: BOOK_ID,
    title: '长夜灯河',
    authorPenName: '砚青',
    genre: '东方玄幻',
    status: 'ongoing',
    synopsis: '一个关于灯河与守夜人的故事。',
    targetChapterWords: 3000,
    volumeCount: 1,
    chapterCount: 2,
    totalWordCount: 6789,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function chapterDto(content = '正文') {
  return {
    id: CHAPTER_ID,
    bookId: BOOK_ID,
    volumeId: VOLUME_ID,
    title: '第一章 风起',
    sortOrder: 0,
    status: 'draft',
    contentText: content,
    contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    wordCount: 2,
    version: 3,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchMockOnce(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error('fetch 未被调用');
  }
  return call as [string, RequestInit];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('booksApi', () => {
  it('列表请求携带状态 / 关键字 / 回收站参数', async () => {
    const fetchMock = fetchMockOnce({ items: [bookDto()], total: 1 });

    const response = await booksApi.list({
      status: 'ongoing',
      q: '灯河',
      includeDeleted: 'exclude',
    });

    expect(response.total).toBe(1);
    expect(response.items[0]?.title).toBe('长夜灯河');
    const [url, init] = lastCall(fetchMock);
    expect(init.method).toBe('GET');
    expect(url).toContain('/books?');
    expect(url).toContain('status=ongoing');
    expect(url).toContain('includeDeleted=exclude');
    expect(decodeURIComponent(url)).toContain('q=灯河');
  });

  it('创建书籍使用 POST 并提交完整 payload', async () => {
    const fetchMock = fetchMockOnce(bookDto(), 201);

    const created = await booksApi.create({
      title: '长夜灯河',
      authorPenName: '砚青',
      genre: '东方玄幻',
      status: 'ongoing',
      synopsis: '简介',
      targetChapterWords: 3000,
    });

    expect(created.id).toBe(BOOK_ID);
    const [, init] = lastCall(fetchMock);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ title: '长夜灯河', targetChapterWords: 3000 });
  });

  it('软删除与永久删除分别命中默认 / permanent 查询', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await booksApi.remove(BOOK_ID);
    expect(lastCall(fetchMock)[0]).not.toContain('permanent');

    await booksApi.purge(BOOK_ID);
    const [url, init] = lastCall(fetchMock);
    expect(init.method).toBe('DELETE');
    expect(url).toContain('permanent=true');
  });

  it('目录树响应经共享 Zod 契约校验', async () => {
    fetchMockOnce({
      book: bookDto(),
      volumes: [
        {
          id: VOLUME_ID,
          bookId: BOOK_ID,
          title: '第一卷',
          summary: '',
          sortOrder: 0,
          chapterCount: 1,
          totalWordCount: 100,
          deletedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
          chapters: [
            {
              id: CHAPTER_ID,
              bookId: BOOK_ID,
              volumeId: VOLUME_ID,
              title: '第一章',
              sortOrder: 0,
              status: 'draft',
              wordCount: 100,
              version: 1,
              deletedAt: null,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        },
      ],
      ungroupedChapters: [],
      trashCount: 0,
    });

    const tree = await booksApi.tree(BOOK_ID);
    expect(tree.book.title).toBe('长夜灯河');
    expect(tree.volumes[0]?.chapters[0]?.id).toBe(CHAPTER_ID);
  });

  it('响应不符合契约时抛 INVALID_RESPONSE', async () => {
    fetchMockOnce({ items: 'not-an-array', total: 0 });
    await expect(booksApi.list()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('后端错误码透传到 ApiClientError', async () => {
    fetchMockOnce({ code: 'BOOK_NOT_FOUND', message: '书籍不存在' }, 404);
    await expect(booksApi.get(BOOK_ID)).rejects.toMatchObject({
      code: 'BOOK_NOT_FOUND',
      status: 404,
    });
  });

  it('导出下载地址包含格式查询参数', () => {
    expect(booksApi.exportUrl(BOOK_ID, 'md')).toContain(`/books/${BOOK_ID}/export?format=md`);
  });
});

describe('volumesApi / chaptersApi', () => {
  it('分卷重排提交完整 volumeIds 顺序', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await volumesApi.reorder(BOOK_ID, [VOLUME_ID]);
    const [url, init] = lastCall(fetchMock);
    expect(init.method).toBe('PUT');
    expect(url).toContain(`/books/${BOOK_ID}/volumes/reorder`);
    expect(JSON.parse(String(init.body))).toEqual({ volumeIds: [VOLUME_ID] });
  });

  it('创建章节兼容包装型响应并提取 id', async () => {
    fetchMockOnce({ chapter: { id: CHAPTER_ID, title: '第一章' } }, 201);
    const ack = await chaptersApi.create(BOOK_ID, { volumeId: VOLUME_ID, title: '第一章' });
    expect(ack.id).toBe(CHAPTER_ID);
  });

  it('创建章节在响应无 id 时返回 null 由调用方回退', async () => {
    fetchMockOnce({}, 201);
    const ack = await chaptersApi.create(BOOK_ID, { volumeId: VOLUME_ID, title: '第一章' });
    expect(ack.id).toBeNull();
  });

  it('保存正文携带乐观锁版本号并解析保存响应', async () => {
    const fetchMock = fetchMockOnce(
      { chapter: { ...chapterDto('新正文'), version: 4 }, autoRevisionCreated: false },
      200,
    );

    const response = await chaptersApi.saveContent(CHAPTER_ID, {
      title: '第一章 风起',
      contentText: '新正文',
      contentJson: null,
      expectedVersion: 3,
    });

    expect(response.chapter.version).toBe(4);
    const [url, init] = lastCall(fetchMock);
    expect(url).toContain(`/chapters/${CHAPTER_ID}/content`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toMatchObject({ expectedVersion: 3, contentText: '新正文' });
  });

  it('版本冲突响应透传 CHAPTER_VERSION_CONFLICT 与 currentVersion 明细', async () => {
    fetchMockOnce(
      {
        code: 'CHAPTER_VERSION_CONFLICT',
        message: '章节已被更新',
        details: [{ path: 'currentVersion', message: '7' }],
      },
      409,
    );

    await expect(
      chaptersApi.saveContent(CHAPTER_ID, {
        contentText: '旧稿',
        expectedVersion: 3,
      }),
    ).rejects.toMatchObject({
      code: 'CHAPTER_VERSION_CONFLICT',
      details: [{ path: 'currentVersion', message: '7' }],
    });
  });

  it('创建快照与回滚分别命中对应路径', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        // 真实服务端返回的是快照详情（含正文），用于前置校验契约一致。
        jsonResponse(
          {
            id: REVISION_ID,
            chapterId: CHAPTER_ID,
            version: 3,
            source: 'manual',
            note: '留底',
            titleSnapshot: '第一章',
            wordCount: 2,
            contentText: '第一章正文',
            contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
            createdAt: NOW,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            chapter: chapterDto('回滚后的正文'),
            backupRevision: {
              id: REVISION_ID,
              chapterId: CHAPTER_ID,
              version: 3,
              source: 'restore',
              note: '回滚备份',
              titleSnapshot: '第一章',
              wordCount: 2,
              createdAt: NOW,
            },
          },
          200,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const revision = await chaptersApi.createRevision(CHAPTER_ID, { note: '留底' });
    expect(revision.source).toBe('manual');
    expect(revision.contentText).toBe('第一章正文');
    expect(revision.contentJson).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(lastCall(fetchMock)[0]).toContain(`/chapters/${CHAPTER_ID}/revisions`);

    const restored = await chaptersApi.restoreRevision(CHAPTER_ID, REVISION_ID);
    expect(restored.chapter.contentText).toBe('回滚后的正文');
    expect(lastCall(fetchMock)[0]).toContain(`/revisions/${REVISION_ID}/restore`);
  });
});

describe('导出下载', () => {
  it('解析 RFC 5987 与普通 filename', () => {
    expect(
      parseContentDispositionFilename(
        "attachment; filename*=UTF-8''%E9%95%BF%E5%A4%9C%E7%81%AF%E6%B2%B3.txt",
      ),
    ).toBe('长夜灯河.txt');
    expect(parseContentDispositionFilename('attachment; filename="book.md"')).toBe('book.md');
    expect(parseContentDispositionFilename(null)).toBeNull();
    expect(parseContentDispositionFilename('attachment')).toBeNull();
  });

  it('下载导出返回 Blob 与文件名并触发浏览器下载', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('第一章正文', {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': "attachment; filename*=UTF-8''book.txt",
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const createObjectURL = vi.fn().mockReturnValue('blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    vi.useFakeTimers();
    const payload = await downloadBookExport(BOOK_ID, 'txt');

    expect(payload.filename).toBe('book.txt');
    expect(payload.blob.size).toBeGreaterThan(0);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(lastCall(fetchMock)[0]).toContain(`/books/${BOOK_ID}/export?format=txt`);

    vi.advanceTimersByTime(1_100);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('导出失败时抛统一 ApiClientError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ code: 'BOOK_NOT_FOUND', message: '书籍不存在' }, 404)),
    );

    await expect(booksApi.exportFile(BOOK_ID, 'md')).rejects.toMatchObject({
      code: 'BOOK_NOT_FOUND',
    });
  });

  it('非浏览器环境静默跳过下载动作', () => {
    Object.defineProperty(URL, 'createObjectURL', { value: undefined, configurable: true });
    expect(() => triggerBlobDownload(new Blob(['x']), 'x.txt')).not.toThrow();
  });
});
