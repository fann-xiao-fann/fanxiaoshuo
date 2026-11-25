import {
  API_ERROR_CODES,
  AUTO_REVISION_INTERVAL_MS,
  chapterDetailDtoSchema,
  chapterSaveResponseSchema,
  chapterTreeItemSchema,
  countNovelWords,
  createChapterSchema,
  reorderChaptersSchema,
  saveChapterContentSchema,
  updateChapterMetaSchema,
} from '@fanxiaoshuo/shared';
import type { FastifyInstance } from 'fastify';
import { autoRevisionNote } from '../domain/books.js';
import { ApiError } from '../errors.js';
import { toChapterDetailDto, toChapterTreeItem } from '../mapping/dto.js';
import type { ChapterRecord } from '../repositories/types.js';
import type { ServerDependencies } from '../server-deps.js';
import {
  chapterNotFound,
  requireActiveBookAggregate,
  requireActiveVolumeOfBook,
} from './book-helpers.js';
import { parseBooleanQuery, parseIdParam, parseOrThrow } from './helpers.js';

/** 取章节（必须存在且未软删），否则抛 404。 */
async function requireActiveChapter(
  deps: ServerDependencies,
  chapterId: string,
): Promise<ChapterRecord> {
  const chapter = await deps.chapters.findById(chapterId);
  if (!chapter || chapter.deletedAt !== null) {
    throw chapterNotFound('章节不存在或已在回收站中。');
  }
  return chapter;
}

/**
 * 节流自动快照：正文有实质变更，且距最近一次 `auto` 快照超过阈值时才留底。
 * 阈值默认 5 分钟（`AUTO_REVISION_INTERVAL_MS`），可由依赖注入覆盖用于测试。
 */
export async function maybeCreateAutoRevision(
  deps: ServerDependencies,
  chapter: ChapterRecord,
): Promise<boolean> {
  if (chapter.contentText.trim().length === 0) {
    return false;
  }

  const latestSnapshot = await deps.chapterRevisions.findLatestByChapter(chapter.id);
  if (latestSnapshot && latestSnapshot.contentText === chapter.contentText) {
    // 正文与最近一次快照完全一致：没有留底价值。
    return false;
  }

  const intervalMs = deps.autoRevisionIntervalMs ?? AUTO_REVISION_INTERVAL_MS;
  const latestAuto = await deps.chapterRevisions.findLatestBySource(chapter.id, 'auto');
  if (latestAuto) {
    const now = (deps.clock ?? (() => new Date()))();
    if (now.getTime() - latestAuto.createdAt.getTime() < intervalMs) {
      return false;
    }
  }

  await deps.chapterRevisions.create({
    chapterId: chapter.id,
    version: chapter.version,
    source: 'auto',
    note: autoRevisionNote(Math.max(1, Math.round(intervalMs / 60_000))),
    titleSnapshot: chapter.title,
    contentText: chapter.contentText,
    contentJson: chapter.contentJson,
    wordCount: chapter.wordCount,
  });
  return true;
}

/** `/api/v1/books/:bookId/chapters` 与 `/api/v1/chapters/:chapterId`：章节元信息、正文与排序。 */
export function registerChapterRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  const booksBase = '/api/v1/books';
  const chaptersBase = '/api/v1/chapters';

  app.post(`${booksBase}/:bookId/chapters`, async (request, reply) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const input = parseOrThrow(createChapterSchema, request.body);
    await requireActiveBookAggregate(deps, bookId);

    const volumeId = input.volumeId ?? null;
    if (volumeId !== null) {
      // 防跨书脏关联：分卷必须属于同一本书且未软删。
      await requireActiveVolumeOfBook(deps, bookId, volumeId);
    }

    const created = await deps.chapters.create({
      bookId,
      volumeId,
      title: input.title,
      status: input.status,
    });

    return reply.status(201).send(chapterTreeItemSchema.parse(toChapterTreeItem(created)));
  });

  app.put(`${booksBase}/:bookId/chapters/reorder`, async (request, reply) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const input = parseOrThrow(reorderChaptersSchema, request.body);
    await requireActiveBookAggregate(deps, bookId);

    const activeVolumes = await deps.volumes.listByBook(bookId, 'active');
    const activeVolumeIds = new Set(activeVolumes.map((entry) => entry.volume.id));
    const activeChapters = await deps.chapters.listByBook(bookId, 'active');
    const knownChapterIds = new Set(activeChapters.map((chapter) => chapter.id));

    const problems: { path: string; message: string }[] = [];
    for (const item of input.items) {
      if (!knownChapterIds.has(item.chapterId)) {
        problems.push({
          path: 'items',
          message: `章节 ${item.chapterId} 不属于该书籍或已在回收站`,
        });
      }
      if (item.volumeId !== null && !activeVolumeIds.has(item.volumeId)) {
        problems.push({
          path: 'items',
          message: `分卷 ${item.volumeId} 不属于该书籍或已在回收站`,
        });
      }
    }
    if (problems.length > 0) {
      throw new ApiError(
        API_ERROR_CODES.CONFLICT,
        '重排请求包含不属于该书籍（或已在回收站）的节点，请刷新目录树后重试。',
        { details: problems },
      );
    }

    await deps.chapters.reorder(bookId, input.items);
    return reply.status(204).send();
  });

  app.get(`${chaptersBase}/:chapterId`, async (request) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    const chapter = await requireActiveChapter(deps, chapterId);
    return chapterDetailDtoSchema.parse(toChapterDetailDto(chapter));
  });

  app.patch(`${chaptersBase}/:chapterId`, async (request) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    const input = parseOrThrow(updateChapterMetaSchema, request.body);

    const existing = await deps.chapters.findById(chapterId);
    if (!existing || existing.deletedAt !== null) {
      throw chapterNotFound('章节不存在或已在回收站中。');
    }

    if (input.volumeId !== undefined && input.volumeId !== null) {
      await requireActiveVolumeOfBook(deps, existing.bookId, input.volumeId);
    }

    const updated = await deps.chapters.updateMeta(chapterId, input);
    if (!updated) {
      throw chapterNotFound();
    }

    return chapterDetailDtoSchema.parse(toChapterDetailDto(updated));
  });

  app.delete(`${chaptersBase}/:chapterId`, async (request, reply) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    const permanent = parseBooleanQuery(request.query, 'permanent');

    const existing = await deps.chapters.findById(chapterId);
    if (!existing) {
      throw chapterNotFound();
    }

    if (permanent) {
      if (existing.deletedAt === null) {
        throw new ApiError(
          API_ERROR_CODES.CONFLICT,
          '仅回收站中的章节可永久删除：请先软删除并确认后再彻底清理。',
        );
      }
      await deps.chapters.purge(chapterId);
      return reply.status(204).send();
    }

    await deps.chapters.softDelete(chapterId);
    return reply.status(204).send();
  });

  app.post(`${chaptersBase}/:chapterId/restore`, async (request) => {
    const chapterId = parseIdParam(request.params, 'chapterId');

    const existing = await deps.chapters.findById(chapterId);
    if (!existing) {
      throw chapterNotFound();
    }

    const restored =
      existing.deletedAt === null ? existing : await deps.chapters.restore(chapterId);
    if (!restored) {
      throw chapterNotFound();
    }

    return chapterDetailDtoSchema.parse(toChapterDetailDto(restored));
  });

  app.put(`${chaptersBase}/:chapterId/content`, async (request) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    const input = parseOrThrow(saveChapterContentSchema, request.body);

    const existing = await deps.chapters.findById(chapterId);
    if (!existing || existing.deletedAt !== null) {
      throw chapterNotFound('章节不存在或已在回收站中。');
    }

    // 服务端独立重算字数，绝不信任客户端上报值。
    const wordCount = countNovelWords(input.contentText);

    const outcome = await deps.chapters.saveContent({
      chapterId,
      expectedVersion: input.expectedVersion,
      forceOverwrite: input.forceOverwrite,
      ...(input.title === undefined ? {} : { title: input.title }),
      contentText: input.contentText,
      ...(input.contentJson === undefined ? {} : { contentJson: input.contentJson }),
      wordCount,
    });

    if (outcome.status === 'not_found') {
      throw chapterNotFound();
    }

    if (outcome.status === 'conflict') {
      throw new ApiError(
        API_ERROR_CODES.CHAPTER_VERSION_CONFLICT,
        `章节已被其他窗口或后台任务更新（服务端当前 v${outcome.chapter.version}），请重新加载最新版本后再保存。`,
        {
          details: [
            {
              path: 'expectedVersion',
              message: `currentVersion=${outcome.chapter.version}`,
            },
          ],
        },
      );
    }

    const autoRevisionCreated =
      input.forceOverwrite || input.contentText.trim().length === 0
        ? false
        : await maybeCreateAutoRevision(deps, outcome.chapter);

    return chapterSaveResponseSchema.parse({
      chapter: toChapterDetailDto(outcome.chapter),
      autoRevisionCreated,
    });
  });
}
