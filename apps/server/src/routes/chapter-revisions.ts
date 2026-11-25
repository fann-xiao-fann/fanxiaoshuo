import {
  chapterRevisionDetailSchema,
  chapterRevisionListResponseSchema,
  chapterRevisionSummarySchema,
  createChapterRevisionSchema,
  restoreChapterRevisionResponseSchema,
} from '@fanxiaoshuo/shared';
import type { FastifyInstance } from 'fastify';
import { restoreBackupNote } from '../domain/books.js';
import {
  toChapterDetailDto,
  toRevisionDetail,
  toRevisionSummary,
} from '../mapping/dto.js';
import type { ChapterRecord } from '../repositories/types.js';
import type { ServerDependencies } from '../server-deps.js';
import { chapterNotFound, revisionNotFound } from './book-helpers.js';
import { parseIdParam, parseOrThrow } from './helpers.js';

/** 取章节（必须存在且未软删）。 */
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
 * `/api/v1/chapters/:chapterId/revisions`：历史快照列表 / 详情 / 手动创建 / 安全回滚。
 *
 * 快照表 append-only：任何回滚都会先把当前正文留底为 `restore` 快照，
 * 保证「回滚本身可被回滚」。
 */
export function registerChapterRevisionRoutes(
  app: FastifyInstance,
  deps: ServerDependencies,
): void {
  const base = '/api/v1/chapters';

  app.get(`${base}/:chapterId/revisions`, async (request) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    await requireActiveChapter(deps, chapterId);

    const revisions = await deps.chapterRevisions.listByChapter(chapterId);
    return chapterRevisionListResponseSchema.parse({
      items: revisions.map(toRevisionSummary),
      total: revisions.length,
    });
  });

  app.get(`${base}/:chapterId/revisions/:revisionId`, async (request) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    const revisionId = parseIdParam(request.params, 'revisionId');
    await requireActiveChapter(deps, chapterId);

    const revision = await deps.chapterRevisions.findById(revisionId);
    if (!revision || revision.chapterId !== chapterId) {
      throw revisionNotFound('历史快照不存在或不属于该章节。');
    }

    return chapterRevisionDetailSchema.parse(toRevisionDetail(revision));
  });

  app.post(`${base}/:chapterId/revisions`, async (request, reply) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    const input = parseOrThrow(createChapterRevisionSchema, request.body ?? {});
    const chapter = await requireActiveChapter(deps, chapterId);

    const created = await deps.chapterRevisions.create({
      chapterId,
      version: chapter.version,
      source: 'manual',
      note: input.note ?? '',
      titleSnapshot: chapter.title,
      contentText: chapter.contentText,
      contentJson: chapter.contentJson,
      wordCount: chapter.wordCount,
    });

    return reply
      .status(201)
      .send(chapterRevisionDetailSchema.parse(toRevisionDetail(created)));
  });

  app.post(`${base}/:chapterId/revisions/:revisionId/restore`, async (request) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    const revisionId = parseIdParam(request.params, 'revisionId');
    const chapter = await requireActiveChapter(deps, chapterId);

    const revision = await deps.chapterRevisions.findById(revisionId);
    if (!revision || revision.chapterId !== chapterId) {
      throw revisionNotFound('历史快照不存在或不属于该章节。');
    }

    const result = await deps.chapterRevisions.restore({
      chapterId,
      backup: {
        chapterId,
        version: chapter.version,
        source: 'restore',
        note: restoreBackupNote(revision.version),
        titleSnapshot: chapter.title,
        contentText: chapter.contentText,
        contentJson: chapter.contentJson,
        wordCount: chapter.wordCount,
      },
      restore: {
        title: revision.titleSnapshot,
        contentText: revision.contentText,
        contentJson: revision.contentJson,
        wordCount: revision.wordCount,
      },
    });

    if (!result) {
      throw chapterNotFound('章节不存在或已在回收站中，回滚已取消。');
    }

    return restoreChapterRevisionResponseSchema.parse({
      chapter: toChapterDetailDto(result.chapter),
      backupRevision: chapterRevisionSummarySchema.parse(
        toRevisionSummary(result.backupRevision),
      ),
    });
  });
}
