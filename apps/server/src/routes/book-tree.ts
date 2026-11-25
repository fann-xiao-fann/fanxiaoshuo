import {
  bookTrashResponseSchema,
  bookTreeResponseSchema,
  volumeTreeNodeSchema,
} from '@fanxiaoshuo/shared';
import type { FastifyInstance } from 'fastify';
import {
  toBookDto,
  toChapterTreeItem,
  toVolumeDto,
} from '../mapping/dto.js';
import type { ServerDependencies } from '../server-deps.js';
import { requireBookAggregate } from './book-helpers.js';
import { parseIdParam } from './helpers.js';

/**
 * `/api/v1/books/:bookId/tree` 与 `/trash`。
 *
 * 性能红线：目录树**绝不返回** `contentText` / `contentJson`，
 * 百章级作品展开时响应体积保持在几十 KB 内。
 */
export function registerBookTreeRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  const base = '/api/v1/books';

  app.get(`${base}/:bookId/tree`, async (request) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const aggregate = await requireBookAggregate(deps, bookId);

    const volumeAggregates = await deps.volumes.listByBook(bookId, 'active');
    const activeChapters = await deps.chapters.listByBook(bookId, 'active');
    const trashedVolumes = await deps.volumes.listByBook(bookId, 'deleted');
    const trashedChapters = await deps.chapters.listByBook(bookId, 'deleted');

    const activeVolumeIds = new Set(volumeAggregates.map((entry) => entry.volume.id));
    // 软删分卷及其下章节整体从目录树隐藏（章节仍在，可从回收站恢复分卷后重新出现）。
    const visibleChapters = activeChapters
      .filter((chapter) => chapter.volumeId === null || activeVolumeIds.has(chapter.volumeId))
      .sort((left, right) => left.sortOrder - right.sortOrder);

    const volumes = volumeAggregates.map((entry) =>
      volumeTreeNodeSchema.parse({
        ...toVolumeDto(entry),
        chapters: visibleChapters
          .filter((chapter) => chapter.volumeId === entry.volume.id)
          .map(toChapterTreeItem),
      }),
    );

    return bookTreeResponseSchema.parse({
      book: toBookDto(aggregate),
      volumes,
      ungroupedChapters: visibleChapters
        .filter((chapter) => chapter.volumeId === null)
        .map(toChapterTreeItem),
      trashCount: trashedVolumes.length + trashedChapters.length,
    });
  });

  app.get(`${base}/:bookId/trash`, async (request) => {
    const bookId = parseIdParam(request.params, 'bookId');
    await requireBookAggregate(deps, bookId);

    const trashedVolumes = await deps.volumes.listByBook(bookId, 'deleted');
    const trashedChapters = await deps.chapters.listByBook(bookId, 'deleted');

    return bookTrashResponseSchema.parse({
      volumes: trashedVolumes.map(toVolumeDto),
      chapters: trashedChapters.map(toChapterTreeItem),
    });
  });
}
