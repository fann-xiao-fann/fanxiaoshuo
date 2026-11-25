import { describe, expect, it } from 'vitest';
import {
  chapterRevisionDetailSchema,
  chapterRevisionListResponseSchema,
  chapterRevisionSummarySchema,
  createChapterRevisionSchema,
  restoreChapterRevisionResponseSchema,
} from '../index.js';

const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const VOLUME_ID = '22222222-2222-4222-8222-222222222222';
const CHAPTER_ID = '44444444-4444-4444-8444-444444444444';
const REVISION_ID = '66666666-6666-4666-8666-666666666666';
const CREATED_AT = '2026-02-01T10:00:00.000Z';
const TIPTAP_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

function revisionSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: REVISION_ID,
    chapterId: CHAPTER_ID,
    version: 3,
    source: 'manual',
    note: '交稿前留底',
    titleSnapshot: '第一章 风起',
    wordCount: 3120,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function chapterDetail() {
  return {
    id: CHAPTER_ID,
    bookId: BOOK_ID,
    volumeId: VOLUME_ID,
    title: '第一章 风起',
    sortOrder: 0,
    status: 'draft',
    contentText: '回滚后的正文',
    contentJson: TIPTAP_DOC,
    wordCount: 6,
    version: 4,
    deletedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

describe('chapterRevisionSummarySchema', () => {
  it('接受手动快照元信息', () => {
    const parsed = chapterRevisionSummarySchema.parse(revisionSummary());
    expect(parsed.source).toBe('manual');
    expect(parsed.note).toBe('交稿前留底');
  });

  it('接受 4 种快照来源与空备注', () => {
    for (const source of ['manual', 'auto', 'restore', 'ai'] as const) {
      expect(chapterRevisionSummarySchema.safeParse(revisionSummary({ source })).success).toBe(true);
    }
    expect(chapterRevisionSummarySchema.parse(revisionSummary({ note: '' })).note).toBe('');
  });

  it('拒绝非法来源、非正版本、超长备注与缺失字段', () => {
    expect(
      chapterRevisionSummarySchema.safeParse(revisionSummary({ source: 'snapshot' })).success,
    ).toBe(false);
    expect(chapterRevisionSummarySchema.safeParse(revisionSummary({ version: 0 })).success).toBe(
      false,
    );
    expect(
      chapterRevisionSummarySchema.safeParse(revisionSummary({ note: 'x'.repeat(201) })).success,
    ).toBe(false);
    expect(chapterRevisionSummarySchema.safeParse({ id: REVISION_ID }).success).toBe(false);
  });

  it('strictObject 拒绝多余字段（摘要不含正文）', () => {
    expect(
      chapterRevisionSummarySchema.safeParse({ ...revisionSummary(), contentText: '正文' }).success,
    ).toBe(false);
  });
});

describe('chapterRevisionDetailSchema', () => {
  it('接受含正文的快照详情', () => {
    const parsed = chapterRevisionDetailSchema.parse({
      ...revisionSummary(),
      contentText: '快照正文',
      contentJson: TIPTAP_DOC,
    });
    expect(parsed.contentText).toBe('快照正文');
    expect(parsed.contentJson).toEqual(TIPTAP_DOC);
  });

  it('接受 contentJson 为 null', () => {
    const parsed = chapterRevisionDetailSchema.parse({
      ...revisionSummary(),
      contentText: '',
      contentJson: null,
    });
    expect(parsed.contentJson).toBeNull();
  });

  it('拒绝缺失 contentText 与多余字段', () => {
    expect(
      chapterRevisionDetailSchema.safeParse({ ...revisionSummary(), contentJson: null }).success,
    ).toBe(false);
    expect(
      chapterRevisionDetailSchema.safeParse({
        ...revisionSummary(),
        contentText: '正文',
        contentJson: null,
        chapterContent: '重复',
      }).success,
    ).toBe(false);
  });
});

describe('createChapterRevisionSchema', () => {
  it('接受空对象（备注可选）', () => {
    expect(createChapterRevisionSchema.parse({})).toEqual({});
  });

  it('去除备注首尾空白并限制 200 字符', () => {
    expect(createChapterRevisionSchema.parse({ note: '  灵感版本  ' }).note).toBe('灵感版本');
    expect(createChapterRevisionSchema.safeParse({ note: 'x'.repeat(200) }).success).toBe(true);
    expect(createChapterRevisionSchema.safeParse({ note: 'x'.repeat(201) }).success).toBe(false);
  });

  it('拒绝多余字段（内容由服务端从当前章节读取）', () => {
    expect(
      createChapterRevisionSchema.safeParse({ note: '留底', contentText: '伪造正文' }).success,
    ).toBe(false);
  });
});

describe('chapterRevisionListResponseSchema', () => {
  it('接受快照列表', () => {
    const parsed = chapterRevisionListResponseSchema.parse({
      items: [revisionSummary(), revisionSummary({ id: REVISION_ID, source: 'auto' })],
      total: 2,
    });
    expect(parsed.items).toHaveLength(2);
  });

  it('拒绝负数 total 与非法条目', () => {
    expect(chapterRevisionListResponseSchema.safeParse({ items: [], total: -1 }).success).toBe(false);
    expect(
      chapterRevisionListResponseSchema.safeParse({ items: [{ id: REVISION_ID }], total: 1 }).success,
    ).toBe(false);
  });
});

describe('restoreChapterRevisionResponseSchema', () => {
  it('接受回滚响应（含自动留底的 restore 备份快照）', () => {
    const parsed = restoreChapterRevisionResponseSchema.parse({
      chapter: chapterDetail(),
      backupRevision: revisionSummary({ source: 'restore', note: '回滚至 v3 前自动备份' }),
    });
    expect(parsed.chapter.version).toBe(4);
    expect(parsed.backupRevision.source).toBe('restore');
  });

  it('拒绝缺失 backupRevision 或来源非法的备份', () => {
    expect(
      restoreChapterRevisionResponseSchema.safeParse({ chapter: chapterDetail() }).success,
    ).toBe(false);
    expect(
      restoreChapterRevisionResponseSchema.safeParse({
        chapter: chapterDetail(),
        backupRevision: revisionSummary({ source: 'manual' }),
      }).success,
    ).toBe(true);
    expect(
      restoreChapterRevisionResponseSchema.safeParse({
        chapter: chapterDetail(),
        backupRevision: revisionSummary({ source: 'snapshot' }),
      }).success,
    ).toBe(false);
  });
});
