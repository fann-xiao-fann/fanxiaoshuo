import { z } from 'zod';
import { isoDateTimeSchema, nonNegativeIntSchema, trimmedText, uuidSchema } from './primitives.js';

/** 分卷标题 / 简介长度上限。 */
export const VOLUME_TITLE_MAX_LENGTH = 120;
export const VOLUME_SUMMARY_MAX_LENGTH = 2_000;

/** 分卷 DTO（回收站列表与卷章树基础信息共用，含聚合统计）。 */
export const volumeDtoSchema = z
  .strictObject({
    id: uuidSchema,
    bookId: uuidSchema,
    title: z.string().min(1).max(VOLUME_TITLE_MAX_LENGTH),
    summary: z.string().max(VOLUME_SUMMARY_MAX_LENGTH),
    /** 卷内排序序号，升序展示 */
    sortOrder: nonNegativeIntSchema,
    /** 本卷未软删章节数 */
    chapterCount: nonNegativeIntSchema,
    /** 本卷未软删章节字数汇总 */
    totalWordCount: nonNegativeIntSchema,
    /** 非 null 表示位于本书回收站 */
    deletedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .describe('分卷对外 DTO（含章数与字数聚合）');

export type VolumeDto = z.infer<typeof volumeDtoSchema>;

/** `POST /api/v1/books/:bookId/volumes` 请求体（新建卷自动追加到末尾）。 */
export const createVolumeSchema = z
  .strictObject({
    title: trimmedText(VOLUME_TITLE_MAX_LENGTH),
    summary: z.string().trim().max(VOLUME_SUMMARY_MAX_LENGTH).default(''),
  })
  .describe('新建分卷请求');

export type CreateVolumeInput = z.infer<typeof createVolumeSchema>;
export type CreateVolumeInputPayload = z.input<typeof createVolumeSchema>;

/** `PATCH /api/v1/volumes/:volumeId` 请求体（至少提供一个待更新字段）。 */
export const updateVolumeSchema = z
  .strictObject({
    title: trimmedText(VOLUME_TITLE_MAX_LENGTH).optional(),
    summary: z.string().trim().max(VOLUME_SUMMARY_MAX_LENGTH).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: '至少需要提供一个待更新字段',
  })
  .describe('更新分卷请求');

export type UpdateVolumeInput = z.infer<typeof updateVolumeSchema>;
export type UpdateVolumeInputPayload = z.input<typeof updateVolumeSchema>;

/**
 * `PUT /api/v1/books/:bookId/volumes/reorder` 请求体。
 * `volumeIds` 的数组下标即新的 `sortOrder`，必须为本书全部分卷且不得重复。
 */
export const reorderVolumesSchema = z
  .strictObject({
    volumeIds: z.array(uuidSchema).min(1).max(1_000),
  })
  .refine((value) => new Set(value.volumeIds).size === value.volumeIds.length, {
    message: '分卷 ID 不得重复',
    path: ['volumeIds'],
  })
  .describe('分卷排序请求（数组下标即新 sortOrder）');

export type ReorderVolumesInput = z.infer<typeof reorderVolumesSchema>;
