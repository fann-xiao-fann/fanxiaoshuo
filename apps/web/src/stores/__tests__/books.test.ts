import type { BookDto } from '@fanxiaoshuo/shared';
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
  downloadBookExport: vi.fn(),
}));

import { booksApi, downloadBookExport } from '@/api/books';
import { ApiClientError } from '@/api/errors';
import { BOOK_STATUS_FILTER_OPTIONS, useBooksStore } from '@/stores/books';

const NOW = '2024-05-01T10:00:00.000Z';

function makeBook(overrides: Partial<BookDto> = {}): BookDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: '长夜灯河',
    authorPenName: '砚青',
    genre: '东方玄幻',
    status: 'ongoing',
    synopsis: '守夜人的故事',
    targetChapterWords: 3000,
    volumeCount: 2,
    chapterCount: 12,
    totalWordCount: 34567,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const listMock = vi.mocked(booksApi.list);
const createMock = vi.mocked(booksApi.create);
const updateMock = vi.mocked(booksApi.update);
const removeMock = vi.mocked(booksApi.remove);
const purgeMock = vi.mocked(booksApi.purge);
const restoreMock = vi.mocked(booksApi.restore);
const exportDownloadMock = vi.mocked(downloadBookExport);

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useBooksStore', () => {
  it('加载书架并记录聚合结果', async () => {
    listMock.mockResolvedValue({ items: [makeBook()], total: 1 });
    const store = useBooksStore();

    await store.loadBooks();

    expect(store.books).toHaveLength(1);
    expect(store.loadedOnce).toBe(true);
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(listMock).toHaveBeenCalledWith({
      q: '',
      status: undefined,
      includeDeleted: 'exclude',
    });
  });

  it('筛选条件进入查询串并驱动 hasFilters', async () => {
    listMock.mockResolvedValue({ items: [], total: 0 });
    const store = useBooksStore();

    store.setKeyword('  灯河  ');
    store.setStatusFilter('completed');
    await store.loadBooks();

    expect(store.hasFilters).toBe(true);
    expect(listMock).toHaveBeenLastCalledWith({
      q: '灯河',
      status: 'completed',
      includeDeleted: 'exclude',
    });

    store.resetFilters();
    expect(store.hasFilters).toBe(false);
    expect(store.filters).toEqual({ keyword: '', status: null });
  });

  it('列表失败写入错误文案并向上抛出', async () => {
    listMock.mockRejectedValue(
      new ApiClientError('后端不可用', { code: 'SERVICE_UNAVAILABLE', status: 503 }),
    );
    const store = useBooksStore();

    await expect(store.loadBooks()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(store.error).toBe('后端不可用');
    expect(store.loading).toBe(false);
    expect(store.loadedOnce).toBe(false);
  });

  it('创建书籍后刷新列表', async () => {
    const created = makeBook({ id: '99999999-9999-4999-8999-999999999999', title: '新书' });
    createMock.mockResolvedValue(created);
    listMock.mockResolvedValue({ items: [created], total: 1 });
    const store = useBooksStore();

    const book = await store.createBook({ title: '新书' });

    expect(book.title).toBe('新书');
    expect(createMock).toHaveBeenCalledWith({ title: '新书' });
    expect(store.books).toHaveLength(1);
    expect(store.saving).toBe(false);
  });

  it('编辑书籍后刷新列表', async () => {
    const updated = makeBook({ title: '改名后' });
    updateMock.mockResolvedValue(updated);
    listMock.mockResolvedValue({ items: [updated], total: 1 });
    const store = useBooksStore();

    await store.updateBook(updated.id, { title: '改名后' });

    expect(updateMock).toHaveBeenCalledWith(updated.id, { title: '改名后' });
    expect(store.books[0]?.title).toBe('改名后');
  });

  it('软删除移出书架并同步回收站', async () => {
    removeMock.mockResolvedValue(undefined);
    listMock
      .mockResolvedValueOnce({ items: [makeBook()], total: 1 })
      .mockResolvedValueOnce({ items: [makeBook({ deletedAt: NOW })], total: 1 });
    const store = useBooksStore();
    await store.loadBooks();

    await store.softDeleteBook(store.books[0]!.id);

    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(store.books).toHaveLength(0);
    expect(store.trashBooks).toHaveLength(1);
    expect(store.trashCount).toBe(1);
  });

  it('恢复与永久删除分别更新回收站与书架', async () => {
    const trashed = makeBook({ deletedAt: NOW });
    listMock.mockResolvedValueOnce({ items: [trashed], total: 1 }).mockResolvedValueOnce({
      items: [makeBook()],
      total: 1,
    });
    restoreMock.mockResolvedValue(makeBook());
    purgeMock.mockResolvedValue(undefined);

    const store = useBooksStore();
    await store.loadTrash();
    expect(store.trashBooks).toHaveLength(1);

    await store.restoreBook(trashed.id);
    expect(restoreMock).toHaveBeenCalledWith(trashed.id);
    expect(store.trashBooks).toHaveLength(0);
    expect(store.books).toHaveLength(1);

    await store.loadTrash();
    await store.purgeBook(trashed.id);
    expect(purgeMock).toHaveBeenCalledWith(trashed.id);
    expect(store.trashBooks).toHaveLength(0);
  });

  it('导出书籍调用真实下载并复位 pending 状态', async () => {
    exportDownloadMock.mockResolvedValue({
      blob: new Blob(['x']),
      filename: 'book.txt',
    });
    const store = useBooksStore();

    await store.exportBook(makeBook().id, 'txt');

    expect(exportDownloadMock).toHaveBeenCalledWith(makeBook().id, 'txt');
    expect(store.pendingBookId).toBeNull();
  });

  it('状态筛选项覆盖「全部」与四个作品状态', () => {
    expect(BOOK_STATUS_FILTER_OPTIONS.map((item) => item.label)).toEqual([
      '全部',
      '草稿',
      '连载中',
      '已完结',
      '已归档',
    ]);
    expect(BOOK_STATUS_FILTER_OPTIONS[0]?.value).toBeNull();
  });
});
