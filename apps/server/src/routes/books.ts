import {
  API_ERROR_CODES,
  EXPORT_FORMAT_META,
  bookExportQuerySchema,
  bookListQuerySchema,
  bookListResponseSchema,
  bookDtoSchema,
  createBookSchema,
  updateBookSchema,
} from '@fanxiaoshuo/shared';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';
import { buildContentDisposition, renderBookExport } from '../export/book-export.js';
import { toBookDto } from '../mapping/dto.js';
import type { BookRecord } from '../repositories/types.js';
import type { ServerDependencies } from '../server-deps.js';
import { bookNotFound, requireBookAggregate } from './book-helpers.js';
import { parseBooleanQuery, parseIdParam, parseOrThrow } from './helpers.js';

/**
 * `/api/v1/books`：书架 CRUD + 回收站（软删 / 恢复 / 防误删永久删除）+ 整本导出。
 *
 * 安全红线：`?permanent=true` 只允许作用于**已在回收站**的记录，
 * 避免客户端一次误调用就把整本书（含全部卷章与历史快照）不可逆清空。
 */
export function registerBookRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  const base = '/api/v1/books';

  app.get(base, async (request) => {
    const query = parseOrThrow(bookListQuerySchema, request.query ?? {});
    const records = await deps.books.list({
      status: query.status,
      q: query.q,
      includeDeleted: query.includeDeleted,
    });
    return bookListResponseSchema.parse({
      items: records.map(toBookDto),
      total: records.length,
    });
  });

  app.post(base, async (request, reply) => {
    const input = parseOrThrow(createBookSchema, request.body);
    const created = await deps.books.create({
      title: input.title,
      authorPenName: input.authorPenName,
      genre: input.genre,
      status: input.status,
      synopsis: input.synopsis,
      targetChapterWords: input.targetChapterWords,
    });
    const aggregate = await deps.books.findAggregateById(created.id);
    return reply.status(201).send(
      bookDtoSchema.parse(
        toBookDto(
          aggregate ?? {
            book: created,
            volumeCount: 0,
            chapterCount: 0,
            totalWordCount: 0,
          },
        ),
      ),
    );
  });

  app.get(`${base}/:bookId`, async (request) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const aggregate = await requireBookAggregate(deps, bookId);
    return bookDtoSchema.parse(toBookDto(aggregate));
  });

  app.patch(`${base}/:bookId`, async (request) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const input = parseOrThrow(updateBookSchema, request.body);

    const existing = await deps.books.findById(bookId);
    if (!existing) {
      throw bookNotFound();
    }

    const updated = await deps.books.update(bookId, input);
    if (!updated) {
      throw bookNotFound();
    }

    const aggregate = await deps.books.findAggregateById(bookId);
    return bookDtoSchema.parse(
      toBookDto(
        aggregate ?? {
          book: updated,
          volumeCount: 0,
          chapterCount: 0,
          totalWordCount: 0,
        },
      ),
    );
  });

  app.delete(`${base}/:bookId`, async (request, reply) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const permanent = parseBooleanQuery(request.query, 'permanent');

    const existing = await deps.books.findById(bookId);
    if (!existing) {
      throw bookNotFound();
    }

    if (permanent) {
      if (existing.deletedAt === null) {
        throw new ApiError(
          API_ERROR_CODES.CONFLICT,
          '仅回收站中的书籍可永久删除：请先移入回收站并确认后再彻底清理。',
        );
      }
      await deps.books.purge(bookId);
      return reply.status(204).send();
    }

    await deps.books.softDelete(bookId);
    return reply.status(204).send();
  });

  app.post(`${base}/:bookId/restore`, async (request) => {
    const bookId = parseIdParam(request.params, 'bookId');

    const existing = await deps.books.findById(bookId);
    if (!existing) {
      throw bookNotFound();
    }

    const restored = existing.deletedAt === null ? existing : await deps.books.restore(bookId);
    if (!restored) {
      throw bookNotFound();
    }

    const aggregate = await deps.books.findAggregateById(bookId);
    return bookDtoSchema.parse(
      toBookDto(
        aggregate ?? {
          book: restored,
          volumeCount: 0,
          chapterCount: 0,
          totalWordCount: 0,
        },
      ),
    );
  });

  app.get(`${base}/:bookId/export`, async (request, reply) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const query = parseOrThrow(bookExportQuerySchema, request.query ?? {});

    const aggregate = await requireBookAggregate(deps, bookId);
    if (aggregate.book.deletedAt !== null) {
      // 回收站中的书籍不可导出，统一按「不存在」处理，避免误导出待删除稿。
      throw bookNotFound('书籍已在回收站中，无法导出。');
    }

    const book: BookRecord = aggregate.book;
    const volumeAggregates = await deps.volumes.listByBook(bookId, 'active');
    const allChapters = await deps.chapters.listWithContentByBook(bookId);

    // 排除软删章节，以及软删分卷下的章节（与卷章树口径一致）。
    const activeVolumeIds = new Set(volumeAggregates.map((entry) => entry.volume.id));
    const visibleChapters = allChapters
      .filter(
        (chapter) =>
          chapter.deletedAt === null &&
          (chapter.volumeId === null || activeVolumeIds.has(chapter.volumeId)),
      )
      .sort((left, right) => left.sortOrder - right.sortOrder);

    const volumes = volumeAggregates.map((entry) => ({
      volume: entry.volume,
      chapters: visibleChapters.filter((chapter) => chapter.volumeId === entry.volume.id),
    }));
    const ungroupedChapters = visibleChapters.filter((chapter) => chapter.volumeId === null);

    const body = renderBookExport({ book, volumes, ungroupedChapters }, query.format);
    const meta = EXPORT_FORMAT_META[query.format];

    return reply
      .header('Content-Type', meta.contentType)
      .header('Content-Disposition', buildContentDisposition(book.title, query.format))
      .send(body);
  });
}
