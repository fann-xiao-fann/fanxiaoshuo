import { API_ERROR_CODES } from '@fanxiaoshuo/shared';
import { ApiError } from '../errors.js';
import type { ServerDependencies } from '../server-deps.js';
import type { BookAggregateRecord, VolumeAggregateRecord, VolumeRecord } from '../repositories/types.js';

/**
 * 书库路由共用的取数与断言工具。
 *
 * 统一错误码语义（见 `packages/shared/src/errors.ts`）：
 * - 资源不存在 / 已彻底删除 → `*_NOT_FOUND`（404）
 * - 资源存在但已在回收站 / 归属不匹配 → `CONFLICT`（409）或 `NOT_FOUND`
 */

export function bookNotFound(message = '书籍不存在或已被彻底删除。'): ApiError {
  return new ApiError(API_ERROR_CODES.BOOK_NOT_FOUND, message);
}

export function volumeNotFound(message = '分卷不存在或已被彻底删除。'): ApiError {
  return new ApiError(API_ERROR_CODES.VOLUME_NOT_FOUND, message);
}

export function chapterNotFound(message = '章节不存在或已被彻底删除。'): ApiError {
  return new ApiError(API_ERROR_CODES.CHAPTER_NOT_FOUND, message);
}

export function revisionNotFound(message = '历史快照不存在或已被清理。'): ApiError {
  return new ApiError(API_ERROR_CODES.REVISION_NOT_FOUND, message);
}

/** 读取书籍聚合（含回收站），不存在抛 404。 */
export async function requireBookAggregate(
  deps: ServerDependencies,
  bookId: string,
): Promise<BookAggregateRecord> {
  const aggregate = await deps.books.findAggregateById(bookId);
  if (!aggregate) {
    throw bookNotFound();
  }
  return aggregate;
}

/** 读取书籍聚合，且必须不在回收站（导出 / 卷章树 / 新建卷章均要求活跃书籍）。 */
export async function requireActiveBookAggregate(
  deps: ServerDependencies,
  bookId: string,
): Promise<BookAggregateRecord> {
  const aggregate = await requireBookAggregate(deps, bookId);
  if (aggregate.book.deletedAt !== null) {
    throw bookNotFound('书籍已在回收站中，请先恢复后再操作。');
  }
  return aggregate;
}

/** 读取分卷并计算卷内聚合（新建 / 更新 / 恢复后返回完整 DTO）。 */
export async function loadVolumeAggregate(
  deps: ServerDependencies,
  volume: VolumeRecord,
): Promise<VolumeAggregateRecord> {
  const chapters = await deps.chapters.listByBook(volume.bookId, 'active');
  const scoped = chapters.filter((chapter) => chapter.volumeId === volume.id);
  return {
    volume,
    chapterCount: scoped.length,
    totalWordCount: scoped.reduce((sum, chapter) => sum + chapter.wordCount, 0),
  };
}

/**
 * 校验分卷归属：必须存在、未软删且属于目标书籍，否则抛错（防跨书脏关联）。
 * 分卷不存在 / 已删 → 404 `VOLUME_NOT_FOUND`；属于其他书籍 → 409 `CONFLICT`。
 */
export async function requireActiveVolumeOfBook(
  deps: ServerDependencies,
  bookId: string,
  volumeId: string,
): Promise<VolumeRecord> {
  const volume = await deps.volumes.findById(volumeId);
  if (!volume || volume.deletedAt !== null) {
    throw volumeNotFound('分卷不存在或已在回收站中。');
  }
  if (volume.bookId !== bookId) {
    throw new ApiError(API_ERROR_CODES.CONFLICT, '该分卷不属于目标书籍，禁止跨书关联。');
  }
  return volume;
}
