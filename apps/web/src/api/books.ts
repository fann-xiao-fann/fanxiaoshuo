import {
  bookDtoSchema,
  bookListResponseSchema,
  bookTrashResponseSchema,
  bookTreeResponseSchema,
  chapterDetailDtoSchema,
  chapterRevisionDetailSchema,
  chapterRevisionListResponseSchema,
  chapterSaveResponseSchema,
  restoreChapterRevisionResponseSchema,
  type BookDto,
  type BookExportQuery,
  type BookListResponse,
  type BookStatus,
  type BookTrashResponse,
  type BookTreeResponse,
  type ChapterDetailDto,
  type ChapterRevisionDetail,
  type ChapterRevisionListResponse,
  type ChapterRevisionSummary,
  type ChapterSaveResponse,
  type CreateBookInputPayload,
  type CreateChapterInputPayload,
  type CreateChapterRevisionInputPayload,
  type CreateVolumeInputPayload,
  type ExportFormat,
  type ReorderChaptersInput,
  type SaveChapterContentInputPayload,
  type UpdateBookInputPayload,
  type UpdateChapterMetaInputPayload,
  type UpdateVolumeInputPayload,
} from '@fanxiaoshuo/shared';
import { z } from 'zod';
import { API_BASE_URL } from './config';
import { normalizeApiError } from './errors';
import { apiRequest, apiRequestVoid, type RequestOptions } from './http';

/**
 * 书库 / 卷章 / 正文 / 快照 / 导出的强类型 API 客户端。
 *
 * 所有响应（包括创建类接口）都经 `@fanxiaoshuo/shared` 的 Zod 契约解析，
 * 视图层只接触 DTO 类型，不重复判断 HTTP 状态码。
 */

function bookPath(bookId: string): string {
  return `/books/${encodeURIComponent(bookId)}`;
}

function volumePath(volumeId: string): string {
  return `/volumes/${encodeURIComponent(volumeId)}`;
}

function chapterPath(chapterId: string): string {
  return `/chapters/${encodeURIComponent(chapterId)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * 创建类接口的响应形状在契约层未单独冻结（可能返回完整 DTO、或仅 `{ id }`）。
 * 这里做一次宽松归一：优先取顶层 `id`，其次从常见包装字段中提取，
 * 取不到时返回 `null` 并由调用方回退为「重新拉取目录树后定位」。
 */
function extractEntityId(raw: unknown): string | null {
  const node = asRecord(raw);
  if (node === null) {
    return null;
  }
  const direct = node['id'];
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  for (const key of ['chapter', 'volume', 'item', 'data', 'book']) {
    const nested = asRecord(node[key]);
    const nestedId = nested?.['id'];
    if (typeof nestedId === 'string' && nestedId.length > 0) {
      return nestedId;
    }
  }
  return null;
}

const createdEntityAckSchema = z.unknown().transform((raw) => extractEntityId(raw));

export interface CreatedEntityAck {
  id: string | null;
}

function toAck(raw: string | null): CreatedEntityAck {
  return { id: raw };
}

/* -------------------------------------------------------------------------- */
/*                                   书架                                     */
/* -------------------------------------------------------------------------- */

export interface BooksListQuery {
  /** 作品状态筛选（省略表示全部） */
  status?: BookStatus;
  /** 书名 / 笔名 / 题材关键字 */
  q?: string;
  /** `exclude`（默认，仅活跃作品）/ `only`（仅回收站） */
  includeDeleted?: 'exclude' | 'only';
}

export const booksApi = {
  list(query: BooksListQuery = {}, options: RequestOptions = {}): Promise<BookListResponse> {
    return apiRequest('/books', bookListResponseSchema, {
      ...options,
      query: {
        status: query.status,
        q: query.q,
        includeDeleted: query.includeDeleted,
        ...options.query,
      },
    });
  },

  get(bookId: string, options: RequestOptions = {}): Promise<BookDto> {
    return apiRequest(bookPath(bookId), bookDtoSchema, options);
  },

  create(payload: CreateBookInputPayload): Promise<BookDto> {
    return apiRequest('/books', bookDtoSchema, { method: 'POST', body: payload });
  },

  update(bookId: string, payload: UpdateBookInputPayload): Promise<BookDto> {
    return apiRequest(bookPath(bookId), bookDtoSchema, { method: 'PATCH', body: payload });
  },

  /** 软删除：书籍进入回收站。 */
  remove(bookId: string): Promise<void> {
    return apiRequestVoid(bookPath(bookId), { method: 'DELETE' });
  },

  /** 永久删除：仅允许对回收站内书籍执行。 */
  purge(bookId: string): Promise<void> {
    return apiRequestVoid(bookPath(bookId), { method: 'DELETE', query: { permanent: true } });
  },

  restore(bookId: string): Promise<BookDto> {
    return apiRequest(`${bookPath(bookId)}/restore`, bookDtoSchema, { method: 'POST' });
  },

  tree(bookId: string, options: RequestOptions = {}): Promise<BookTreeResponse> {
    return apiRequest(`${bookPath(bookId)}/tree`, bookTreeResponseSchema, options);
  },

  trash(bookId: string, options: RequestOptions = {}): Promise<BookTrashResponse> {
    return apiRequest(`${bookPath(bookId)}/trash`, bookTrashResponseSchema, options);
  },

  /** 整本导出下载地址（浏览器直接下载或新窗口打开）。 */
  exportUrl(bookId: string, format: ExportFormat): string {
    const query: BookExportQuery = { format };
    return `${API_BASE_URL}${bookPath(bookId)}/export?format=${query.format}`;
  },

  /** 拉取整本导出的 Blob 与文件名（用于自定义下载入口与单测断言）。 */
  exportFile(bookId: string, format: ExportFormat): Promise<DownloadPayload> {
    return downloadFile(booksApi.exportUrl(bookId, format));
  },
};

/* -------------------------------------------------------------------------- */
/*                                    分卷                                     */
/* -------------------------------------------------------------------------- */

export const volumesApi = {
  async create(bookId: string, payload: CreateVolumeInputPayload): Promise<CreatedEntityAck> {
    const id = await apiRequest(`${bookPath(bookId)}/volumes`, createdEntityAckSchema, {
      method: 'POST',
      body: payload,
    });
    return toAck(id);
  },

  update(volumeId: string, payload: UpdateVolumeInputPayload): Promise<void> {
    return apiRequestVoid(volumePath(volumeId), { method: 'PATCH', body: payload });
  },

  remove(volumeId: string, options: { permanent?: boolean } = {}): Promise<void> {
    return apiRequestVoid(volumePath(volumeId), {
      method: 'DELETE',
      query: options.permanent === true ? { permanent: true } : undefined,
    });
  },

  restore(volumeId: string): Promise<void> {
    return apiRequestVoid(`${volumePath(volumeId)}/restore`, { method: 'POST' });
  },

  /** 数组下标即新的 `sortOrder`，须为本书全部分卷的完整顺序。 */
  reorder(bookId: string, volumeIds: string[]): Promise<void> {
    return apiRequestVoid(`${bookPath(bookId)}/volumes/reorder`, {
      method: 'PUT',
      body: { volumeIds },
    });
  },
};

/* -------------------------------------------------------------------------- */
/*                                    章节                                     */
/* -------------------------------------------------------------------------- */

export const chaptersApi = {
  async create(bookId: string, payload: CreateChapterInputPayload): Promise<CreatedEntityAck> {
    const id = await apiRequest(`${bookPath(bookId)}/chapters`, createdEntityAckSchema, {
      method: 'POST',
      body: payload,
    });
    return toAck(id);
  },

  updateMeta(chapterId: string, payload: UpdateChapterMetaInputPayload): Promise<void> {
    return apiRequestVoid(chapterPath(chapterId), { method: 'PATCH', body: payload });
  },

  remove(chapterId: string, options: { permanent?: boolean } = {}): Promise<void> {
    return apiRequestVoid(chapterPath(chapterId), {
      method: 'DELETE',
      query: options.permanent === true ? { permanent: true } : undefined,
    });
  },

  restore(chapterId: string): Promise<void> {
    return apiRequestVoid(`${chapterPath(chapterId)}/restore`, { method: 'POST' });
  },

  /** 同卷排序与跨卷移动在服务端单事务内完成。 */
  reorder(bookId: string, payload: ReorderChaptersInput): Promise<void> {
    return apiRequestVoid(`${bookPath(bookId)}/chapters/reorder`, {
      method: 'PUT',
      body: payload,
    });
  },

  get(chapterId: string, options: RequestOptions = {}): Promise<ChapterDetailDto> {
    return apiRequest(chapterPath(chapterId), chapterDetailDtoSchema, options);
  },

  saveContent(
    chapterId: string,
    payload: SaveChapterContentInputPayload,
  ): Promise<ChapterSaveResponse> {
    return apiRequest(`${chapterPath(chapterId)}/content`, chapterSaveResponseSchema, {
      method: 'PUT',
      body: payload,
    });
  },

  listRevisions(
    chapterId: string,
    options: RequestOptions = {},
  ): Promise<ChapterRevisionListResponse> {
    return apiRequest(
      `${chapterPath(chapterId)}/revisions`,
      chapterRevisionListResponseSchema,
      options,
    );
  },

  getRevision(chapterId: string, revisionId: string): Promise<ChapterRevisionDetail> {
    return apiRequest(
      `${chapterPath(chapterId)}/revisions/${encodeURIComponent(revisionId)}`,
      chapterRevisionDetailSchema,
    );
  },

  /**
   * 手动留底快照。
   *
   * 服务端 `POST /chapters/:chapterId/revisions` 返回的是**快照详情**
   * （`chapterRevisionDetailSchema`，含 `contentText` / `contentJson`），
   * 因此这里必须按详情契约解析，否则多余字段会触发 `INVALID_RESPONSE`。
   * `ChapterRevisionDetail` 是 `ChapterRevisionSummary` 的超集，调用方完全兼容。
   */
  createRevision(
    chapterId: string,
    payload: CreateChapterRevisionInputPayload = {},
  ): Promise<ChapterRevisionDetail> {
    return apiRequest(`${chapterPath(chapterId)}/revisions`, chapterRevisionDetailSchema, {
      method: 'POST',
      body: payload,
    });
  },

  restoreRevision(
    chapterId: string,
    revisionId: string,
  ): Promise<{ chapter: ChapterDetailDto; backupRevision: ChapterRevisionSummary }> {
    return apiRequest(
      `${chapterPath(chapterId)}/revisions/${encodeURIComponent(revisionId)}/restore`,
      restoreChapterRevisionResponseSchema,
      { method: 'POST' },
    );
  },
};

/* -------------------------------------------------------------------------- */
/*                                 导出下载                                   */
/* -------------------------------------------------------------------------- */

export interface DownloadPayload {
  blob: Blob;
  /** 服务端 `Content-Disposition` 声明的文件名（缺失时按兜底命名）。 */
  filename: string;
}

/** 解析 RFC 5987 / RFC 6266 的 `Content-Disposition` 文件名。 */
export function parseContentDispositionFilename(header: string | null): string | null {
  if (header === null || header.trim().length === 0) {
    return null;
  }
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1] !== undefined) {
    try {
      const decoded = decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ''));
      if (decoded.length > 0) {
        return decoded;
      }
    } catch {
      /* 编码非法：回退到普通 filename */
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(header);
  if (quoted?.[1] !== undefined && quoted[1].trim().length > 0) {
    return quoted[1].trim();
  }
  return null;
}

/** 读取导出响应：非 2xx 时按统一 `ApiError` 契约抛错。 */
async function downloadFile(url: string, fallbackName = 'book.txt'): Promise<DownloadPayload> {
  const response = await fetch(url, { headers: { Accept: '*/*' } });
  if (!response.ok) {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text.trim().length > 0 ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      /* 非 JSON 错误体：保留原始文本 */
    }
    throw normalizeApiError(response.status, body);
  }
  const blob = await response.blob();
  const filename =
    parseContentDispositionFilename(response.headers.get('content-disposition')) ?? fallbackName;
  return { blob, filename };
}

/** 触发浏览器文件下载（非浏览器环境静默跳过，便于单测复用）。 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return;
  }
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // 立即回收会打断部分浏览器的下载，延后释放
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

/** 一键下载整本作品（TXT / Markdown）。 */
export async function downloadBookExport(
  bookId: string,
  format: ExportFormat,
): Promise<DownloadPayload> {
  const payload = await booksApi.exportFile(bookId, format);
  triggerBlobDownload(payload.blob, payload.filename);
  return payload;
}
