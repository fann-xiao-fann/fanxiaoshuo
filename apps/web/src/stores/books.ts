import {
  BOOK_STATUS_LABELS,
  type BookDto,
  type BookStatus,
  type CreateBookInputPayload,
  type ExportFormat,
  type UpdateBookInputPayload,
} from '@fanxiaoshuo/shared';
import { defineStore } from 'pinia';
import { booksApi, downloadBookExport } from '@/api/books';
import { describeError } from '@/api/errors';

export interface BooksFilters {
  /** 书名 / 笔名 / 题材关键字 */
  keyword: string;
  /** null 表示「全部状态」 */
  status: BookStatus | null;
}

interface BooksState {
  books: BookDto[];
  filters: BooksFilters;
  loading: boolean;
  error: string | null;
  loadedOnce: boolean;
  trashBooks: BookDto[];
  trashLoading: boolean;
  trashError: string | null;
  saving: boolean;
  /** 正在执行删除 / 恢复 / 导出的书籍 id（用于按钮 loading 与防重复点击） */
  pendingBookId: string | null;
}

/** 书架状态筛选项（「全部」+ 四个作品状态），供工具栏与回收站复用。 */
export const BOOK_STATUS_FILTER_OPTIONS: Array<{ label: string; value: BookStatus | null }> = [
  { label: '全部', value: null },
  ...(Object.keys(BOOK_STATUS_LABELS) as BookStatus[]).map((status) => ({
    label: BOOK_STATUS_LABELS[status],
    value: status,
  })),
];

export const useBooksStore = defineStore('fx-books', {
  state: (): BooksState => ({
    books: [],
    filters: {
      keyword: '',
      status: null,
    },
    loading: false,
    error: null,
    loadedOnce: false,
    trashBooks: [],
    trashLoading: false,
    trashError: null,
    saving: false,
    pendingBookId: null,
  }),

  getters: {
    /** 是否处于筛选状态（空书架文案据此区分「没有书」与「没有匹配结果」）。 */
    hasFilters(state): boolean {
      return state.filters.keyword.trim().length > 0 || state.filters.status !== null;
    },
    bookById(state) {
      return (bookId: string): BookDto | undefined =>
        state.books.find((book) => book.id === bookId);
    },
    trashCount(state): number {
      return state.trashBooks.length;
    },
  },

  actions: {
    setKeyword(keyword: string): void {
      this.filters.keyword = keyword;
    },

    setStatusFilter(status: BookStatus | null): void {
      this.filters.status = status;
    },

    resetFilters(): void {
      this.filters.keyword = '';
      this.filters.status = null;
    },

    /** 书架列表（服务端完成状态 / 关键字筛选与卷章字数聚合）。 */
    async loadBooks(): Promise<BookDto[]> {
      this.loading = true;
      this.error = null;
      try {
        const response = await booksApi.list({
          q: this.filters.keyword.trim(),
          status: this.filters.status ?? undefined,
          includeDeleted: 'exclude',
        });
        this.books = response.items;
        this.loadedOnce = true;
        return response.items;
      } catch (error) {
        this.error = describeError(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },

    /** 回收站列表（仅软删书籍）。 */
    async loadTrash(): Promise<BookDto[]> {
      this.trashLoading = true;
      this.trashError = null;
      try {
        const response = await booksApi.list({ includeDeleted: 'only' });
        this.trashBooks = response.items;
        return response.items;
      } catch (error) {
        this.trashError = describeError(error);
        throw error;
      } finally {
        this.trashLoading = false;
      }
    },

    async createBook(payload: CreateBookInputPayload): Promise<BookDto> {
      this.saving = true;
      this.error = null;
      try {
        const book = await booksApi.create(payload);
        await this.loadBooks();
        return book;
      } catch (error) {
        this.error = describeError(error);
        throw error;
      } finally {
        this.saving = false;
      }
    },

    async updateBook(bookId: string, payload: UpdateBookInputPayload): Promise<BookDto> {
      this.saving = true;
      this.error = null;
      try {
        const book = await booksApi.update(bookId, payload);
        await this.loadBooks();
        return book;
      } catch (error) {
        this.error = describeError(error);
        throw error;
      } finally {
        this.saving = false;
      }
    },

    /** 移入回收站（软删）。 */
    async softDeleteBook(bookId: string): Promise<void> {
      this.pendingBookId = bookId;
      try {
        await booksApi.remove(bookId);
        this.books = this.books.filter((book) => book.id !== bookId);
        await this.loadTrash();
      } finally {
        this.pendingBookId = null;
      }
    },

    async restoreBook(bookId: string): Promise<void> {
      this.pendingBookId = bookId;
      try {
        await booksApi.restore(bookId);
        this.trashBooks = this.trashBooks.filter((book) => book.id !== bookId);
        await this.loadBooks();
      } finally {
        this.pendingBookId = null;
      }
    },

    /** 彻底删除（仅回收站内书籍，调用方负责二次确认）。 */
    async purgeBook(bookId: string): Promise<void> {
      this.pendingBookId = bookId;
      try {
        await booksApi.purge(bookId);
        this.trashBooks = this.trashBooks.filter((book) => book.id !== bookId);
      } finally {
        this.pendingBookId = null;
      }
    },

    /** 一键下载整本作品（TXT / Markdown）。 */
    async exportBook(bookId: string, format: ExportFormat): Promise<void> {
      this.pendingBookId = bookId;
      try {
        await downloadBookExport(bookId, format);
      } finally {
        this.pendingBookId = null;
      }
    },
  },
});
