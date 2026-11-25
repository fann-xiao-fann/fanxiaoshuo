import {
  API_ERROR_CODES,
  createVolumeSchema,
  reorderVolumesSchema,
  updateVolumeSchema,
  volumeDtoSchema,
} from '@fanxiaoshuo/shared';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';
import { toEmptyVolumeDto, toVolumeDto } from '../mapping/dto.js';
import type { ServerDependencies } from '../server-deps.js';
import { loadVolumeAggregate, requireActiveBookAggregate, volumeNotFound } from './book-helpers.js';
import { parseBooleanQuery, parseIdParam, parseOrThrow } from './helpers.js';

/** `/api/v1/books/:bookId/volumes` 与 `/api/v1/volumes/:volumeId`：分卷 CRUD、软删恢复与排序。 */
export function registerVolumeRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  const booksBase = '/api/v1/books';
  const volumesBase = '/api/v1/volumes';

  app.post(`${booksBase}/:bookId/volumes`, async (request, reply) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const input = parseOrThrow(createVolumeSchema, request.body);
    await requireActiveBookAggregate(deps, bookId);

    // 仓储自动追加到末尾（`sortOrder = max + 1`）。
    const created = await deps.volumes.create({
      bookId,
      title: input.title,
      summary: input.summary,
    });

    return reply.status(201).send(volumeDtoSchema.parse(toEmptyVolumeDto(created)));
  });

  app.put(`${booksBase}/:bookId/volumes/reorder`, async (request, reply) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const input = parseOrThrow(reorderVolumesSchema, request.body);
    await requireActiveBookAggregate(deps, bookId);

    const activeVolumes = await deps.volumes.listByBook(bookId, 'active');
    const knownVolumeIds = new Set(activeVolumes.map((entry) => entry.volume.id));
    const foreignVolumeIds = input.volumeIds.filter((volumeId) => !knownVolumeIds.has(volumeId));
    if (foreignVolumeIds.length > 0) {
      throw new ApiError(
        API_ERROR_CODES.CONFLICT,
        '仅能重排本书未删除的分卷，请刷新目录树后重试。',
        {
          details: foreignVolumeIds.map((volumeId) => ({
            path: 'volumeIds',
            message: `分卷 ${volumeId} 不属于该书籍或已在回收站`,
          })),
        },
      );
    }

    await deps.volumes.reorder(bookId, input.volumeIds);
    return reply.status(204).send();
  });

  app.patch(`${volumesBase}/:volumeId`, async (request) => {
    const volumeId = parseIdParam(request.params, 'volumeId');
    const input = parseOrThrow(updateVolumeSchema, request.body);

    const existing = await deps.volumes.findById(volumeId);
    if (!existing || existing.deletedAt !== null) {
      throw volumeNotFound('分卷不存在或已在回收站中。');
    }

    const updated = await deps.volumes.update(volumeId, input);
    if (!updated) {
      throw volumeNotFound();
    }

    return volumeDtoSchema.parse(toVolumeDto(await loadVolumeAggregate(deps, updated)));
  });

  app.delete(`${volumesBase}/:volumeId`, async (request, reply) => {
    const volumeId = parseIdParam(request.params, 'volumeId');
    const permanent = parseBooleanQuery(request.query, 'permanent');

    const existing = await deps.volumes.findById(volumeId);
    if (!existing) {
      throw volumeNotFound();
    }

    if (permanent) {
      if (existing.deletedAt === null) {
        throw new ApiError(
          API_ERROR_CODES.CONFLICT,
          '仅回收站中的分卷可永久删除：请先软删除并确认后再彻底清理。',
        );
      }
      // 外键 `ON DELETE SET NULL`：卷下未删章节自动归入「未分卷章节」，正文绝不丢失。
      await deps.volumes.purge(volumeId);
      return reply.status(204).send();
    }

    await deps.volumes.softDelete(volumeId);
    return reply.status(204).send();
  });

  app.post(`${volumesBase}/:volumeId/restore`, async (request) => {
    const volumeId = parseIdParam(request.params, 'volumeId');

    const existing = await deps.volumes.findById(volumeId);
    if (!existing) {
      throw volumeNotFound();
    }

    const restored = existing.deletedAt === null ? existing : await deps.volumes.restore(volumeId);
    if (!restored) {
      throw volumeNotFound();
    }

    return volumeDtoSchema.parse(toVolumeDto(await loadVolumeAggregate(deps, restored)));
  });
}
