import { describe, expect, it } from 'vitest';
import {
  createVolumeSchema,
  reorderVolumesSchema,
  updateVolumeSchema,
  volumeDtoSchema,
} from '../index.js';

const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const VOLUME_ID = '22222222-2222-4222-8222-222222222222';
const VOLUME_ID_2 = '33333333-3333-4333-8333-333333333333';
const CREATED_AT = '2026-02-01T10:00:00.000Z';

function volumeDto(overrides: Record<string, unknown> = {}) {
  return {
    id: VOLUME_ID,
    bookId: BOOK_ID,
    title: '第一卷 少年出山',
    summary: '主角初入宗门。',
    sortOrder: 0,
    chapterCount: 12,
    totalWordCount: 36_000,
    deletedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

describe('volumeDtoSchema', () => {
  it('接受完整分卷 DTO（含章数与字数聚合）', () => {
    const parsed = volumeDtoSchema.parse(volumeDto());
    expect(parsed.chapterCount).toBe(12);
    expect(parsed.totalWordCount).toBe(36_000);
    expect(parsed.deletedAt).toBeNull();
  });

  it('接受回收站中的分卷', () => {
    expect(volumeDtoSchema.safeParse(volumeDto({ deletedAt: CREATED_AT })).success).toBe(true);
  });

  it('拒绝缺失 bookId、非法 UUID、负数字数与空标题', () => {
    const { bookId: _omitted, ...withoutBookId } = volumeDto();
    expect(volumeDtoSchema.safeParse(withoutBookId).success).toBe(false);
    expect(volumeDtoSchema.safeParse(volumeDto({ id: 'x' })).success).toBe(false);
    expect(volumeDtoSchema.safeParse(volumeDto({ chapterCount: -1 })).success).toBe(false);
    expect(volumeDtoSchema.safeParse(volumeDto({ title: '' })).success).toBe(false);
    expect(volumeDtoSchema.safeParse(volumeDto({ sortOrder: 1.2 })).success).toBe(false);
  });

  it('strictObject 拒绝多余字段', () => {
    expect(volumeDtoSchema.safeParse(volumeDto({ contentText: '越界正文' })).success).toBe(false);
  });
});

describe('createVolumeSchema', () => {
  it('仅必填 title，summary 默认空字符串', () => {
    expect(createVolumeSchema.parse({ title: '  第二卷 风起  ' })).toEqual({
      title: '第二卷 风起',
      summary: '',
    });
  });

  it('拒绝空 / 纯空白 / 超长标题', () => {
    expect(createVolumeSchema.safeParse({ title: '' }).success).toBe(false);
    expect(createVolumeSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(createVolumeSchema.safeParse({ title: 'x'.repeat(121) }).success).toBe(false);
  });

  it('拒绝未知字段与超长简介', () => {
    expect(createVolumeSchema.safeParse({ title: '第一卷', sortOrder: 0 }).success).toBe(false);
    expect(
      createVolumeSchema.safeParse({ title: '第一卷', summary: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });
});

describe('updateVolumeSchema', () => {
  it('接受单字段更新', () => {
    expect(updateVolumeSchema.parse({ summary: '新的卷简介' })).toEqual({ summary: '新的卷简介' });
  });

  it('拒绝空对象、空白标题与多余字段', () => {
    expect(updateVolumeSchema.safeParse({}).success).toBe(false);
    expect(updateVolumeSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(updateVolumeSchema.safeParse({ title: '新卷名', sortOrder: 3 }).success).toBe(false);
  });
});

describe('reorderVolumesSchema', () => {
  it('接受合法分卷 ID 列表（数组下标即新 sortOrder）', () => {
    expect(reorderVolumesSchema.parse({ volumeIds: [VOLUME_ID_2, VOLUME_ID] })).toEqual({
      volumeIds: [VOLUME_ID_2, VOLUME_ID],
    });
  });

  it('拒绝空数组、非 UUID 与重复 ID', () => {
    expect(reorderVolumesSchema.safeParse({ volumeIds: [] }).success).toBe(false);
    expect(reorderVolumesSchema.safeParse({ volumeIds: ['not-a-uuid'] }).success).toBe(false);
    expect(reorderVolumesSchema.safeParse({ volumeIds: [VOLUME_ID, VOLUME_ID] }).success).toBe(false);
  });

  it('拒绝多余字段与缺失 volumeIds', () => {
    expect(reorderVolumesSchema.safeParse({}).success).toBe(false);
    expect(
      reorderVolumesSchema.safeParse({ volumeIds: [VOLUME_ID], bookId: BOOK_ID }).success,
    ).toBe(false);
  });
});
