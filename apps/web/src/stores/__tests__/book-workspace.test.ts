import {
  countNovelWords,
  type BookDto,
  type BookTreeResponse,
  type ChapterDetailDto,
  type ChapterTreeItem,
  type VolumeTreeNode,
} from '@fanxiaoshuo/shared';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/books', () => ({
  booksApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    purge: vi.fn(),
    restore: vi.fn(),
    tree: vi.fn(),
    trash: vi.fn(),
    exportUrl: vi.fn(),
    exportFile: vi.fn(),
  },
  volumesApi: {
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    restore: vi.fn(),
    reorder: vi.fn(),
  },
  chaptersApi: {
    create: vi.fn(),
    updateMeta: vi.fn(),
    remove: vi.fn(),
    restore: vi.fn(),
    reorder: vi.fn(),
    get: vi.fn(),
    saveContent: vi.fn(),
    listRevisions: vi.fn(),
    getRevision: vi.fn(),
    createRevision: vi.fn(),
    restoreRevision: vi.fn(),
  },
  downloadBookExport: vi.fn(),
}));

import { booksApi, chaptersApi, volumesApi } from '@/api/books';
import { ApiClientError } from '@/api/errors';
import { AUTOSAVE_DEBOUNCE_MS, useBookWorkspaceStore } from '@/stores/book-workspace';

const NOW = '2024-05-01T10:00:00.000Z';
const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const VOLUME_ID = '33333333-3333-4333-8333-333333333333';
const VOLUME_ID_2 = '33333333-3333-4333-8333-333333333334';
const CHAPTER_ID = '22222222-2222-4222-8222-222222222222';
const CHAPTER_ID_2 = '22222222-2222-4222-8222-222222222223';

const treeMock = vi.mocked(booksApi.tree);
const trashMock = vi.mocked(booksApi.trash);
const getChapterMock = vi.mocked(chaptersApi.get);
const saveContentMock = vi.mocked(chaptersApi.saveContent);
const reorderChaptersMock = vi.mocked(chaptersApi.reorder);
const updateMetaMock = vi.mocked(chaptersApi.updateMeta);
const removeChapterMock = vi.mocked(chaptersApi.remove);
const createChapterMock = vi.mocked(chaptersApi.create);
const reorderVolumesMock = vi.mocked(volumesApi.reorder);

function makeBook(overrides: Partial<BookDto> = {}): BookDto {
  return {
    id: BOOK_ID,
    title: '长夜灯河',
    authorPenName: '砚青',
    genre: '东方玄幻',
    status: 'ongoing',
    synopsis: '守夜人的故事',
    targetChapterWords: 3000,
    volumeCount: 1,
    chapterCount: 2,
    totalWordCount: 100,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeChapterItem(overrides: Partial<ChapterTreeItem> = {}): ChapterTreeItem {
  return {
    id: CHAPTER_ID,
    bookId: BOOK_ID,
    volumeId: VOLUME_ID,
    title: '第一章 风起',
    sortOrder: 0,
    status: 'draft',
    wordCount: 40,
    version: 1,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeVolume(
  overrides: Partial<VolumeTreeNode> = {},
  chapters: ChapterTreeItem[] = [makeChapterItem()],
): VolumeTreeNode {
  return {
    id: VOLUME_ID,
    bookId: BOOK_ID,
    title: '第一卷 灯下山河',
    summary: '',
    sortOrder: 0,
    chapterCount: chapters.length,
    totalWordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    chapters,
    ...overrides,
  };
}

function makeTree(overrides: Partial<BookTreeResponse> = {}): BookTreeResponse {
  return {
    book: makeBook(),
    volumes: [makeVolume()],
    ungroupedChapters: [],
    trashCount: 0,
    ...overrides,
  };
}

function makeChapterDetail(overrides: Partial<ChapterDetailDto> = {}): ChapterDetailDto {
  return {
    id: CHAPTER_ID,
    bookId: BOOK_ID,
    volumeId: VOLUME_ID,
    title: '第一章 风起',
    sortOrder: 0,
    status: 'draft',
    contentText: '第一章正文',
    contentJson: null,
    wordCount: countNovelWords('第一章正文'),
    version: 1,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function conflictError(currentVersion: number): ApiClientError {
  return new ApiClientError('章节版本过期', {
    code: 'CHAPTER_VERSION_CONFLICT',
    status: 409,
    details: [{ path: 'currentVersion', message: String(currentVersion) }],
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

afterEach(() => {
  useBookWorkspaceStore().cancelAutoSave();
  vi.useRealTimers();
});

describe('useBookWorkspaceStore · 目录树', () => {
  it('加载目录树并保存卷章与回收站计数', async () => {
    treeMock.mockResolvedValue(makeTree({ trashCount: 3 }));
    const store = useBookWorkspaceStore();

    await store.loadTree(BOOK_ID);

    expect(store.bookId).toBe(BOOK_ID);
    expect(store.book?.title).toBe('长夜灯河');
    expect(store.volumes).toHaveLength(1);
    expect(store.trashCount).toBe(3);
    expect(store.totalChapterCount).toBe(1);
    expect(store.totalWordCount).toBe(100);
    expect(store.targetChapterWords).toBe(3000);
  });

  it('目录树加载失败写入 treeError 并抛出', async () => {
    treeMock.mockRejectedValue(new ApiClientError('书籍不存在', { code: 'BOOK_NOT_FOUND', status: 404 }));
    const store = useBookWorkspaceStore();

    await expect(store.loadTree(BOOK_ID)).rejects.toMatchObject({ code: 'BOOK_NOT_FOUND' });
    expect(store.treeError).toBe('书籍不存在');
    expect(store.treeLoading).toBe(false);
  });

  it('回收站加载写入卷与章列表', async () => {
    trashMock.mockResolvedValue({
      volumes: [makeVolume({ deletedAt: NOW })],
      chapters: [makeChapterItem({ deletedAt: NOW })],
    });
    const store = useBookWorkspaceStore();
    store.bookId = BOOK_ID;

    await store.loadTrash();

    expect(store.trash.volumes).toHaveLength(1);
    expect(store.trash.chapters).toHaveLength(1);
    expect(store.trashLoading).toBe(false);
  });

  it('当前章被删除后自动清空编辑器状态', async () => {
    treeMock.mockResolvedValue(makeTree());
    getChapterMock.mockResolvedValue(makeChapterDetail());
    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);
    await store.openChapter(CHAPTER_ID);

    treeMock.mockResolvedValue(makeTree({ volumes: [], ungroupedChapters: [] }));
    await store.loadTree(BOOK_ID);

    expect(store.currentChapterId).toBeNull();
    expect(store.currentChapter).toBeNull();
  });
});

describe('useBookWorkspaceStore · 章节加载与编辑', () => {
  it('加载章节正文并按共享字数口径计算草稿字数', async () => {
    getChapterMock.mockResolvedValue(makeChapterDetail({ contentText: '风起 灯河\n\nHello 世界' }));
    const store = useBookWorkspaceStore();

    const ok = await store.openChapter(CHAPTER_ID);

    expect(ok).toBe(true);
    expect(store.currentChapterId).toBe(CHAPTER_ID);
    expect(store.draftTitle).toBe('第一章 风起');
    expect(store.draftWordCount).toBe(countNovelWords('风起 灯河\n\nHello 世界'));
    expect(store.saveStatus).toBe('idle');
    expect(store.isDirty).toBe(false);
    expect(store.editorSyncToken).toBeGreaterThan(0);
  });

  it('编辑草稿标记脏状态并在 1500ms 防抖后自动保存', async () => {
    vi.useFakeTimers();
    treeMock.mockResolvedValue(makeTree());
    getChapterMock.mockResolvedValue(makeChapterDetail());
    saveContentMock.mockResolvedValue({
      chapter: makeChapterDetail({ contentText: '新正文', version: 2, wordCount: 3 }),
      autoRevisionCreated: false,
    });

    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);
    await store.openChapter(CHAPTER_ID);

    store.setDraft({ contentText: '新正文' });
    expect(store.isDirty).toBe(true);
    expect(store.saveStatus).toBe('dirty');
    expect(store.draftWordCount).toBe(3);
    expect(saveContentMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    expect(saveContentMock).toHaveBeenCalledTimes(1);
    expect(saveContentMock).toHaveBeenCalledWith(
      CHAPTER_ID,
      expect.objectContaining({ expectedVersion: 1, contentText: '新正文', forceOverwrite: false }),
    );
    expect(store.isDirty).toBe(false);
    expect(store.saveStatus).toBe('saved');
    expect(store.currentChapter?.version).toBe(2);
    expect(store.lastSavedAt).toBe(NOW);
  });

  it('保存成功后增量同步分卷与全书字数', async () => {
    treeMock.mockResolvedValue(
      makeTree({
        book: makeBook({ totalWordCount: 3 }),
        volumes: [makeVolume({}, [makeChapterItem({ wordCount: 3 })])],
      }),
    );
    getChapterMock.mockResolvedValue(makeChapterDetail({ contentText: '旧正文', wordCount: 3 }));
    saveContentMock.mockResolvedValue({
      chapter: makeChapterDetail({ contentText: '新的更长的正文内容', version: 2, wordCount: 9 }),
      autoRevisionCreated: false,
    });

    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);
    await store.openChapter(CHAPTER_ID);
    const beforeVolume = store.volumes[0]!.totalWordCount;
    const beforeBook = store.book!.totalWordCount;

    store.setDraft({ contentText: '新的更长的正文内容' });
    await store.saveContent();

    expect(store.volumes[0]!.totalWordCount).toBe(beforeVolume + 6);
    expect(store.book!.totalWordCount).toBe(beforeBook + 6);
  });

  it('保存期间继续输入时保持脏状态并重新排队', async () => {
    treeMock.mockResolvedValue(makeTree());
    getChapterMock.mockResolvedValue(makeChapterDetail({ contentText: '初稿', wordCount: 2 }));

    const deferred: {
      resolve?: (value: Awaited<ReturnType<typeof chaptersApi.saveContent>>) => void;
    } = {};
    saveContentMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);
    await store.openChapter(CHAPTER_ID);

    store.setDraft({ contentText: '第一轮修改' });
    const pending = store.saveContent();
    expect(store.saveStatus).toBe('saving');

    store.setDraft({ contentText: '第二轮修改' });
    deferred.resolve?.({
      chapter: makeChapterDetail({ contentText: '第一轮修改', version: 2, wordCount: 5 }),
      autoRevisionCreated: false,
    });
    await pending;

    expect(store.isDirty).toBe(true);
    expect(store.saveStatus).toBe('dirty');
    expect(store.currentChapter?.version).toBe(2);
  });

  it('命中版本冲突时进入 conflict 状态并解析最新版本号', async () => {
    treeMock.mockResolvedValue(makeTree());
    getChapterMock.mockResolvedValue(makeChapterDetail());
    saveContentMock.mockRejectedValue(conflictError(7));

    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);
    await store.openChapter(CHAPTER_ID);

    store.setDraft({ contentText: '冲突草稿' });
    const ok = await store.saveContent();

    expect(ok).toBe(false);
    expect(store.saveStatus).toBe('conflict');
    expect(store.conflictCurrentVersion).toBe(7);
    expect(store.isDirty).toBe(true);
  });

  it('强制覆盖携带 forceOverwrite 与旧 expectedVersion', async () => {
    treeMock.mockResolvedValue(makeTree());
    getChapterMock.mockResolvedValue(makeChapterDetail({ version: 3 }));
    saveContentMock.mockRejectedValueOnce(conflictError(5)).mockResolvedValueOnce({
      chapter: makeChapterDetail({ contentText: '覆盖稿', version: 6, wordCount: 3 }),
      autoRevisionCreated: true,
    });

    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);
    await store.openChapter(CHAPTER_ID);
    store.setDraft({ contentText: '覆盖稿' });

    await store.saveContent();
    expect(store.saveStatus).toBe('conflict');

    const ok = await store.forceOverwrite();

    expect(ok).toBe(true);
    expect(saveContentMock).toHaveBeenLastCalledWith(
      CHAPTER_ID,
      expect.objectContaining({ expectedVersion: 3, forceOverwrite: true }),
    );
    expect(store.saveStatus).toBe('saved');
    expect(store.conflictCurrentVersion).toBeNull();
  });

  it('冲突弹窗「稍后再处理」保留草稿并退出 conflict 状态', async () => {
    treeMock.mockResolvedValue(makeTree());
    getChapterMock.mockResolvedValue(makeChapterDetail());
    saveContentMock.mockRejectedValue(conflictError(9));

    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);
    await store.openChapter(CHAPTER_ID);
    store.setDraft({ contentText: '未保存' });
    await store.saveContent();

    store.cancelConflict();

    expect(store.saveStatus).toBe('dirty');
    expect(store.isDirty).toBe(true);
    expect(store.conflictCurrentVersion).toBeNull();
  });

  it('重新加载最新版本丢弃本地过期草稿', async () => {
    treeMock.mockResolvedValue(makeTree());
    getChapterMock.mockResolvedValue(makeChapterDetail());
    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);
    await store.openChapter(CHAPTER_ID);
    store.setDraft({ contentText: '本地草稿' });

    getChapterMock.mockResolvedValue(
      makeChapterDetail({ contentText: '服务端最新正文', version: 8 }),
    );
    await store.reloadCurrentChapter();

    expect(store.draftContentText).toBe('服务端最新正文');
    expect(store.currentChapter?.version).toBe(8);
    expect(store.isDirty).toBe(false);
    expect(store.saveStatus).toBe('idle');
  });

  it('切换章节时若旧稿保存失败返回 false 且不加载新章', async () => {
    treeMock.mockResolvedValue(makeTree());
    getChapterMock.mockResolvedValue(makeChapterDetail());
    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);
    await store.openChapter(CHAPTER_ID);
    store.setDraft({ contentText: '未保存草稿' });

    saveContentMock.mockRejectedValue(new ApiClientError('网络异常', { code: 'NETWORK_ERROR', status: 0 }));

    const ok = await store.openChapter(CHAPTER_ID_2);

    expect(ok).toBe(false);
    expect(store.currentChapterId).toBe(CHAPTER_ID);
    expect(store.saveStatus).toBe('error');
    expect(store.saveError).toBe('网络异常');
  });

  it('保存失败时 flushPendingSave 返回 false', async () => {
    treeMock.mockResolvedValue(makeTree());
    getChapterMock.mockResolvedValue(makeChapterDetail());
    saveContentMock.mockRejectedValue(
      new ApiClientError('保存失败', { code: 'INTERNAL_ERROR', status: 500 }),
    );
    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);
    await store.openChapter(CHAPTER_ID);
    store.setDraft({ contentText: '草稿' });

    await expect(store.flushPendingSave()).resolves.toBe(false);
  });
});

describe('useBookWorkspaceStore · 卷章排序与移动', () => {
  it('同卷上移提交按新顺序的 reorder 请求', async () => {
    treeMock.mockResolvedValue(
      makeTree({
        volumes: [
          makeVolume({}, [
            makeChapterItem({ id: CHAPTER_ID, sortOrder: 0 }),
            makeChapterItem({ id: CHAPTER_ID_2, sortOrder: 1, title: '第二章' }),
          ]),
        ],
      }),
    );
    reorderChaptersMock.mockResolvedValue(undefined);
    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);

    await store.moveChapter(CHAPTER_ID_2, 'up');

    expect(reorderChaptersMock).toHaveBeenCalledWith(BOOK_ID, {
      items: [
        { chapterId: CHAPTER_ID_2, volumeId: VOLUME_ID, sortOrder: 0 },
        { chapterId: CHAPTER_ID, volumeId: VOLUME_ID, sortOrder: 1 },
      ],
    });
  });

  it('跨卷移动同时重写源卷与目标卷序号', async () => {
    treeMock.mockResolvedValue(
      makeTree({
        volumes: [
          makeVolume({}, [makeChapterItem({ id: CHAPTER_ID }), makeChapterItem({ id: CHAPTER_ID_2 })]),
          makeVolume({ id: VOLUME_ID_2, title: '第二卷', sortOrder: 1 }, []),
        ],
      }),
    );
    reorderChaptersMock.mockResolvedValue(undefined);
    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);

    await store.moveChapterToVolume(CHAPTER_ID_2, { volumeId: VOLUME_ID_2 });

    const [, payload] = reorderChaptersMock.mock.calls[0]!;
    expect(payload.items).toEqual([
      { chapterId: CHAPTER_ID, volumeId: VOLUME_ID, sortOrder: 0 },
      { chapterId: CHAPTER_ID_2, volumeId: VOLUME_ID_2, sortOrder: 0 },
    ]);
  });

  it('分卷上移提交完整分卷顺序', async () => {
    treeMock.mockResolvedValue(
      makeTree({
        volumes: [
          makeVolume({ id: VOLUME_ID, sortOrder: 0 }),
          makeVolume({ id: VOLUME_ID_2, title: '第二卷', sortOrder: 1 }, []),
        ],
      }),
    );
    reorderVolumesMock.mockResolvedValue(undefined);
    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);

    await store.moveVolume(VOLUME_ID_2, 'up');

    expect(reorderVolumesMock).toHaveBeenCalledWith(BOOK_ID, [VOLUME_ID_2, VOLUME_ID]);
  });

  it('创建章节在响应缺 id 时回退到目标卷末尾', async () => {
    createChapterMock.mockResolvedValue({ id: null });
    treeMock
      .mockResolvedValueOnce(makeTree())
      .mockResolvedValueOnce(
        makeTree({
          volumes: [
            makeVolume({}, [
              makeChapterItem({ id: CHAPTER_ID }),
              makeChapterItem({ id: CHAPTER_ID_2, title: '新章', sortOrder: 1 }),
            ]),
          ],
        }),
      );
    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);

    const created = await store.createChapter({ volumeId: VOLUME_ID, title: '新章' });

    expect(created?.id).toBe(CHAPTER_ID_2);
  });

  it('切换章节状态同步目录树与当前章节', async () => {
    treeMock
      .mockResolvedValueOnce(makeTree())
      .mockResolvedValueOnce(
        makeTree({ volumes: [makeVolume({}, [makeChapterItem({ status: 'final' })])] }),
      );
    getChapterMock.mockResolvedValue(makeChapterDetail());
    updateMetaMock.mockResolvedValue(undefined);
    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);
    await store.openChapter(CHAPTER_ID);

    await store.updateChapterStatus(CHAPTER_ID, 'final');

    expect(updateMetaMock).toHaveBeenCalledWith(CHAPTER_ID, { status: 'final' });
    expect(store.currentChapter?.status).toBe('final');
    expect(store.volumes[0]?.chapters[0]?.status).toBe('final');
  });

  it('删除当前章节后清空编辑器并刷新目录', async () => {
    treeMock.mockResolvedValueOnce(makeTree()).mockResolvedValueOnce(makeTree({ volumes: [] }));
    getChapterMock.mockResolvedValue(makeChapterDetail());
    removeChapterMock.mockResolvedValue(undefined);
    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);
    await store.openChapter(CHAPTER_ID);

    await store.deleteChapter(CHAPTER_ID);

    expect(removeChapterMock).toHaveBeenCalledWith(CHAPTER_ID);
    expect(store.currentChapterId).toBeNull();
    expect(store.volumes).toHaveLength(0);
  });
});

describe('useBookWorkspaceStore · 沉浸模式与快照', () => {
  it('沉浸模式可切换与退出', () => {
    const store = useBookWorkspaceStore();
    expect(store.immersive).toBe(false);

    store.toggleImmersive();
    expect(store.immersive).toBe(true);

    store.setImmersive(false);
    expect(store.immersive).toBe(false);

    store.setImmersive(true);
    store.exitImmersive();
    expect(store.immersive).toBe(false);
  });

  it('创建快照后重新加载历史列表', async () => {
    getChapterMock.mockResolvedValue(makeChapterDetail());
    const store = useBookWorkspaceStore();
    await store.openChapter(CHAPTER_ID);

    vi.mocked(chaptersApi.createRevision).mockResolvedValue({
      id: '55555555-5555-4555-8555-555555555555',
      chapterId: CHAPTER_ID,
      version: 1,
      source: 'manual',
      note: '留底',
      titleSnapshot: '第一章 风起',
      wordCount: 5,
      createdAt: NOW,
    });
    vi.mocked(chaptersApi.listRevisions).mockResolvedValue({
      items: [
        {
          id: '55555555-5555-4555-8555-555555555555',
          chapterId: CHAPTER_ID,
          version: 1,
          source: 'manual',
          note: '留底',
          titleSnapshot: '第一章 风起',
          wordCount: 5,
          createdAt: NOW,
        },
      ],
      total: 1,
    });

    await store.createRevision('留底');

    expect(chaptersApi.createRevision).toHaveBeenCalledWith(CHAPTER_ID, { note: '留底' });
    expect(store.revisions).toHaveLength(1);
    expect(store.revisions[0]?.source).toBe('manual');
  });

  it('回滚快照后刷新正文、目录树与历史列表', async () => {
    treeMock.mockResolvedValue(makeTree());
    getChapterMock.mockResolvedValue(makeChapterDetail());
    const store = useBookWorkspaceStore();
    await store.loadTree(BOOK_ID);
    await store.openChapter(CHAPTER_ID);

    vi.mocked(chaptersApi.restoreRevision).mockResolvedValue({
      chapter: makeChapterDetail({ contentText: '回滚后的正文', version: 4 }),
      backupRevision: {
        id: '66666666-6666-4666-8666-666666666666',
        chapterId: CHAPTER_ID,
        version: 3,
        source: 'restore',
        note: '回滚至 v2 前自动备份',
        titleSnapshot: '第一章 风起',
        wordCount: 6,
        createdAt: NOW,
      },
    });
    vi.mocked(chaptersApi.listRevisions).mockResolvedValue({ items: [], total: 0 });

    await store.restoreRevision('77777777-7777-4777-8777-777777777777');

    expect(store.draftContentText).toBe('回滚后的正文');
    expect(store.currentChapter?.version).toBe(4);
    expect(store.restoringRevisionId).toBeNull();
    expect(store.isDirty).toBe(false);
  });
});
