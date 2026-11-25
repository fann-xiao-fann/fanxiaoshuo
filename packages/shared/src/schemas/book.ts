import { z } from 'zod';
import {
  BOOK_STATUSES,
  DEFAULT_TARGET_CHAPTER_WORDS,
  MAX_TARGET_CHAPTER_WORDS,
  exportFormatSchema,
  bookStatusSchema,
} from '../constants/books.js';
import { isoDateTimeSchema, nonNegativeIntSchema, trimmedText, uuidSchema } from './primitives.js';

/** 书籍标题 / 笔名 / 题材 / 简介长度上限（与前端输入框 maxlength 保持一致）。 */
export const BOOK_TITLE_MAX_LENGTH = 120;
export const BOOK_AUTHOR_MAX_LENGTH = 64;
export const BOOK_GENRE_MAX_LENGTH = 64;
export const BOOK_SYNOPSIS_MAX_LENGTH = 5_000;

/** 单章目标字数：正整数，防御性上限避免误输入天文数字。 */
export const targetChapterWordsSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_TARGET_CHAPTER_WORDS);

/** 书籍 DTO（书架列表与详情共用，含聚合统计）。 */
export const bookDtoSchema = z
  .strictObject({
    id: uuidSchema,
    title: z.string().min(1).max(BOOK_TITLE_MAX_LENGTH),
    authorPenName: z.string().max(BOOK_AUTHOR_MAX_LENGTH),
    genre: z.string().max(BOOK_GENRE_MAX_LENGTH),
    status: bookStatusSchema,
    synopsis: z.string().max(BOOK_SYNOPSIS_MAX_LENGTH),
    /** 单章目标字数（写作进度提示用） */
    targetChapterWords: targetChapterWordsSchema,
    /** 未软删分卷数量 */
    volumeCount: nonNegativeIntSchema,
    /** 未软删章节数量 */
    chapterCount: nonNegativeIntSchema,
    /** 未软删章节字数汇总（服务端重算，客户端值不可信） */
    totalWordCount: nonNegativeIntSchema,
    /** 非 null 表示位于回收站 */
    deletedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .describe('书籍对外 DTO（含卷章数与总字数聚合）');

export type BookDto = z.infer<typeof bookDtoSchema>;

/** `POST /api/v1/books` 请求体。 */
export const createBookSchema = z
  .strictObject({
    title: trimmedText(BOOK_TITLE_MAX_LENGTH),
    authorPenName: z.string().trim().max(BOOK_AUTHOR_MAX_LENGTH).default(''),
    genre: z.string().trim().max(BOOK_GENRE_MAX_LENGTH).default(''),
    status: bookStatusSchema.default(BOOK_STATUSES[0]),
    synopsis: z.string().trim().max(BOOK_SYNOPSIS_MAX_LENGTH).default(''),
    targetChapterWords: targetChapterWordsSchema.default(DEFAULT_TARGET_CHAPTER_WORDS),
  })
  .describe('新建书籍请求');

export type CreateBookInput = z.infer<typeof createBookSchema>;
export type CreateBookInputPayload = z.input<typeof createBookSchema>;

/** `PATCH /api/v1/books/:bookId` 请求体（至少提供一个待更新字段）。 */
export const updateBookSchema = z
  .strictObject({
    title: trimmedText(BOOK_TITLE_MAX_LENGTH).optional(),
    authorPenName: z.string().trim().max(BOOK_AUTHOR_MAX_LENGTH).optional(),
    genre: z.string().trim().max(BOOK_GENRE_MAX_LENGTH).optional(),
    status: bookStatusSchema.optional(),
    synopsis: z.string().trim().max(BOOK_SYNOPSIS_MAX_LENGTH).optional(),
    targetChapterWords: targetChapterWordsSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: '至少需要提供一个待更新字段',
  })
  .describe('更新书籍请求');

export type UpdateBookInput = z.infer<typeof updateBookSchema>;
export type UpdateBookInputPayload = z.input<typeof updateBookSchema>;

/** 查询串中的空字符串视为「未传」（Fastify 会把 `?status=` 解析为空串）。 */
function emptyToUndefined<S extends z.ZodType>(schema: S) {
  return z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? undefined : value),
    schema,
  );
}

/**
 * `GET /api/v1/books` 查询串。
 * `includeDeleted`：`exclude`（默认，仅活跃作品）/ `only`（仅回收站）。
 */
export const bookListQuerySchema = z
  .strictObject({
    status: emptyToUndefined(bookStatusSchema.optional()),
    /** 书名 / 笔名 / 题材关键字（服务端做大小写不敏感模糊匹配） */
    q: emptyToUndefined(z.string().trim().max(120).optional()),
    includeDeleted: emptyToUndefined(z.enum(['exclude', 'only']).default('exclude')),
  })
  .describe('书架列表查询（状态 / 关键字 / 是否包含回收站）');

export type BookListQuery = z.infer<typeof bookListQuerySchema>;
export type BookListQueryPayload = z.input<typeof bookListQuerySchema>;

/** `GET /api/v1/books` 响应。 */
export const bookListResponseSchema = z.strictObject({
  items: z.array(bookDtoSchema),
  total: nonNegativeIntSchema,
});

export type BookListResponse = z.infer<typeof bookListResponseSchema>;

/** `GET /api/v1/books/:bookId/export?format=txt|md` 查询串。 */
export const bookExportQuerySchema = z
  .strictObject({
    format: exportFormatSchema,
  })
  .describe('整本导出查询（txt / md）');

export type BookExportQuery = z.infer<typeof bookExportQuerySchema>;
