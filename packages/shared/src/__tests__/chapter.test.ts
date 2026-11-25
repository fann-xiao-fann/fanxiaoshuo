import { describe, expect, it } from 'vitest';
import {
  MAX_CHAPTER_CONTENT_LENGTH,
  bookTreeResponseSchema,
  bookTrashResponseSchema,
  chapterDetailDtoSchema,
  chapterSaveResponseSchema,
  chapterTreeItemSchema,
  createChapterSchema,
  reorderChaptersSchema,
  saveChapterContentSchema,
  tiptapJsonSchema,
  updateChapterMetaSchema,
  volumeTreeNodeSchema,
} from '../index.js';

const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const VOLUME_ID = '22222222-2222-4222-8222-222222222222';
const CHAPTER_ID = '44444444-4444-4444-8444-444444444444';
const CHAPTER_ID_2 = '55555555-5555-4555-8555-555555555555';
const CREATED_AT = '2026-02-01T10:00:00.000Z';
const TIPTAP_DOC = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '风起' }] }] };

function chapterTreeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: CHAPTER_ID,
    bookId: BOOK_ID,
    volumeId: VOLUME_ID,
    title: '第一章 风起',
    sortOrder: 0,
    status: 'draft',
    wordCount: 3120,
    version: 3,
    deletedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function chapterDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...chapterTreeItem(),
    contentText: '第一章 风起\n\n少年负剑出山。',
    contentJson: TIPTAP_DOC,
    ...overrides,
  };
}

function volumeDto(overrides: Record<string, unknown> = {}) {
  return {
    id: VOLUME_ID,
    bookId: BOOK_ID,
    title: '第一卷 少年出山',
    summary: '',
    sortOrder: 0,
    chapterCount: 2,
    totalWordCount: 6_240,
    deletedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function bookDto() {
  return {
    id: BOOK_ID,
    title: '斗破苍穹',
    authorPenName: '',
    genre: '玄幻',
    status: 'ongoing',
    synopsis: '',
    targetChapterWords: 3000,
    volumeCount: 1,
    chapterCount: 2,
    totalWordCount: 6_240,
    deletedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

describe('tiptapJsonSchema', () => {
  it('接受 ProseMirror 文档对象', () => {
    expect(tiptapJsonSchema.safeParse(TIPTAP_DOC).success).toBe(true);
    expect(tiptapJsonSchema.safeParse({ type: 'doc' }).success).toBe(true);
  });

  it('拒绝数组、字符串与 null', () => {
    expect(tiptapJsonSchema.safeParse([]).success).toBe(false);
    expect(tiptapJsonSchema.safeParse('doc').success).toBe(false);
    expect(tiptapJsonSchema.safeParse(null).success).toBe(false);
  });
});

describe('chapterTreeItemSchema（树节点不含正文）', () => {
  it('接受轻量章节元信息（未分卷时 volumeId 为 null）', () => {
    const parsed = chapterTreeItemSchema.parse(chapterTreeItem({ volumeId: null }));
    expect(parsed.volumeId).toBeNull();
    expect(parsed.version).toBe(3);
  });

  it('strictObject 拒绝携带正文（保证目录树响应轻量）', () => {
    expect(
      chapterTreeItemSchema.safeParse({ ...chapterTreeItem(), contentText: '正文' }).success,
    ).toBe(false);
    expect(
      chapterTreeItemSchema.safeParse({ ...chapterTreeItem(), contentJson: TIPTAP_DOC }).success,
    ).toBe(false);
  });

  it('拒绝非法状态、非正版本号、负字数与缺失字段', () => {
    expect(chapterTreeItemSchema.safeParse(chapterTreeItem({ status: 'done' })).success).toBe(false);
    expect(chapterTreeItemSchema.safeParse(chapterTreeItem({ version: 0 })).success).toBe(false);
    expect(chapterTreeItemSchema.safeParse(chapterTreeItem({ version: 1.5 })).success).toBe(false);
    expect(chapterTreeItemSchema.safeParse(chapterTreeItem({ wordCount: -1 })).success).toBe(false);
    expect(chapterTreeItemSchema.safeParse({ id: CHAPTER_ID }).success).toBe(false);
  });
});

describe('volumeTreeNodeSchema / bookTreeResponseSchema', () => {
  it('接受卷 + 章节列表', () => {
    const parsed = volumeTreeNodeSchema.parse({
      ...volumeDto(),
      chapters: [chapterTreeItem(), chapterTreeItem({ id: CHAPTER_ID_2, sortOrder: 1 })],
    });
    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.totalWordCount).toBe(6_240);
  });

  it('拒绝缺失 chapters 或非法章节节点', () => {
    expect(volumeTreeNodeSchema.safeParse(volumeDto()).success).toBe(false);
    expect(
      volumeTreeNodeSchema.safeParse({ ...volumeDto(), chapters: [{ id: CHAPTER_ID }] }).success,
    ).toBe(false);
  });

  it('接受完整书籍树响应（含未分卷区与回收站计数）', () => {
    const parsed = bookTreeResponseSchema.parse({
      book: bookDto(),
      volumes: [{ ...volumeDto(), chapters: [chapterTreeItem()] }],
      ungroupedChapters: [chapterTreeItem({ id: CHAPTER_ID_2, volumeId: null })],
      trashCount: 3,
    });
    expect(parsed.volumes[0]?.chapters).toHaveLength(1);
    expect(parsed.ungroupedChapters[0]?.volumeId).toBeNull();
    expect(parsed.trashCount).toBe(3);
  });

  it('拒绝负数 trashCount 与多余字段', () => {
    const base = {
      book: bookDto(),
      volumes: [],
      ungroupedChapters: [],
      trashCount: 0,
    };
    expect(bookTreeResponseSchema.safeParse({ ...base, trashCount: -1 }).success).toBe(false);
    expect(bookTreeResponseSchema.safeParse({ ...base, etag: 'x' }).success).toBe(false);
  });
});

describe('bookTrashResponseSchema', () => {
  it('接受回收站卷与章列表', () => {
    const parsed = bookTrashResponseSchema.parse({
      volumes: [volumeDto({ deletedAt: CREATED_AT })],
      chapters: [chapterTreeItem({ deletedAt: CREATED_AT })],
    });
    expect(parsed.volumes[0]?.deletedAt).toBe(CREATED_AT);
    expect(parsed.chapters[0]?.deletedAt).toBe(CREATED_AT);
  });

  it('拒绝缺失字段与多余字段', () => {
    expect(bookTrashResponseSchema.safeParse({ volumes: [] }).success).toBe(false);
    expect(bookTrashResponseSchema.safeParse({ volumes: [], chapters: [], books: [] }).success).toBe(
      false,
    );
  });
});

describe('createChapterSchema', () => {
  it('仅必填 title：状态默认 draft、volumeId 缺省', () => {
    expect(createChapterSchema.parse({ title: '  第一章 风起  ' })).toEqual({
      title: '第一章 风起',
      status: 'draft',
    });
  });

  it('接受显式 volumeId 与 volumeId: null（未分卷）', () => {
    expect(createChapterSchema.parse({ title: '第一章', volumeId: VOLUME_ID }).volumeId).toBe(
      VOLUME_ID,
    );
    expect(createChapterSchema.parse({ title: '第一章', volumeId: null }).volumeId).toBeNull();
  });

  it('拒绝空白标题、非法 volumeId、非法状态与多余字段', () => {
    expect(createChapterSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(createChapterSchema.safeParse({ title: '第一章', volumeId: 'x' }).success).toBe(false);
    expect(createChapterSchema.safeParse({ title: '第一章', status: 'done' }).success).toBe(false);
    expect(createChapterSchema.safeParse({ title: '第一章', contentText: '越界' }).success).toBe(
      false,
    );
  });
});

describe('updateChapterMetaSchema', () => {
  it('接受标题 / 状态 / 所属卷的单字段更新', () => {
    expect(updateChapterMetaSchema.parse({ status: 'final' })).toEqual({ status: 'final' });
    expect(updateChapterMetaSchema.parse({ volumeId: null })).toEqual({ volumeId: null });
    expect(updateChapterMetaSchema.parse({ volumeId: VOLUME_ID })).toEqual({ volumeId: VOLUME_ID });
  });

  it('拒绝空对象、空白标题、非法状态与多余字段', () => {
    expect(updateChapterMetaSchema.safeParse({}).success).toBe(false);
    expect(updateChapterMetaSchema.safeParse({ title: '  ' }).success).toBe(false);
    expect(updateChapterMetaSchema.safeParse({ status: 'done' }).success).toBe(false);
    expect(updateChapterMetaSchema.safeParse({ contentText: '越界' }).success).toBe(false);
  });
});

describe('reorderChaptersSchema', () => {
  it('接受同卷排序与跨卷移动（volumeId: null 表示未分卷区）', () => {
    const parsed = reorderChaptersSchema.parse({
      items: [
        { chapterId: CHAPTER_ID, volumeId: VOLUME_ID, sortOrder: 0 },
        { chapterId: CHAPTER_ID_2, volumeId: null, sortOrder: 1 },
      ],
    });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[1]?.volumeId).toBeNull();
  });

  it('拒绝空列表、重复 chapterId、负 sortOrder 与非法 UUID', () => {
    expect(reorderChaptersSchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      reorderChaptersSchema.safeParse({
        items: [
          { chapterId: CHAPTER_ID, volumeId: VOLUME_ID, sortOrder: 0 },
          { chapterId: CHAPTER_ID, volumeId: VOLUME_ID, sortOrder: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      reorderChaptersSchema.safeParse({
        items: [{ chapterId: CHAPTER_ID, volumeId: VOLUME_ID, sortOrder: -1 }],
      }).success,
    ).toBe(false);
    expect(
      reorderChaptersSchema.safeParse({
        items: [{ chapterId: 'nope', volumeId: VOLUME_ID, sortOrder: 0 }],
      }).success,
    ).toBe(false);
  });

  it('拒绝条目多余字段与缺失 items', () => {
    expect(reorderChaptersSchema.safeParse({}).success).toBe(false);
    expect(
      reorderChaptersSchema.safeParse({
        items: [{ chapterId: CHAPTER_ID, volumeId: VOLUME_ID, sortOrder: 0, bookId: BOOK_ID }],
      }).success,
    ).toBe(false);
  });
});

describe('chapterDetailDtoSchema', () => {
  it('接受含正文与版本的章节详情', () => {
    const parsed = chapterDetailDtoSchema.parse(chapterDetail());
    expect(parsed.contentText).toBe('第一章 风起\n\n少年负剑出山。');
    expect(parsed.contentJson).toEqual(TIPTAP_DOC);
    expect(parsed.version).toBe(3);
  });

  it('接受 contentJson 为 null（仅纯文本的历史数据）与空正文', () => {
    expect(chapterDetailDtoSchema.parse(chapterDetail({ contentJson: null })).contentJson).toBeNull();
    expect(chapterDetailDtoSchema.parse(chapterDetail({ contentText: '' })).contentText).toBe('');
  });

  it('拒绝超过 500,000 字符的正文与缺失 contentText', () => {
    expect(
      chapterDetailDtoSchema.safeParse(
        chapterDetail({ contentText: 'x'.repeat(MAX_CHAPTER_CONTENT_LENGTH + 1) }),
      ).success,
    ).toBe(false);
    const { contentText: _omitted, ...withoutContent } = chapterDetail();
    expect(chapterDetailDtoSchema.safeParse(withoutContent).success).toBe(false);
  });

  it('拒绝非法 version 与多余字段', () => {
    expect(chapterDetailDtoSchema.safeParse(chapterDetail({ version: 0 })).success).toBe(false);
    expect(chapterDetailDtoSchema.safeParse(chapterDetail({ dirty: true })).success).toBe(false);
  });
});

describe('saveChapterContentSchema', () => {
  it('接受最小保存请求（forceOverwrite 默认 false）', () => {
    expect(saveChapterContentSchema.parse({ contentText: '正文', expectedVersion: 1 })).toEqual({
      contentText: '正文',
      expectedVersion: 1,
      forceOverwrite: false,
    });
  });

  it('接受标题、JSON 与强制覆盖标记', () => {
    const parsed = saveChapterContentSchema.parse({
      title: '  新标题  ',
      contentText: '正文',
      contentJson: TIPTAP_DOC,
      expectedVersion: 7,
      forceOverwrite: true,
    });
    expect(parsed.title).toBe('新标题');
    expect(parsed.contentJson).toEqual(TIPTAP_DOC);
    expect(parsed.forceOverwrite).toBe(true);
  });

  it('允许 contentJson 为 null 与空正文（清空章节）', () => {
    const parsed = saveChapterContentSchema.parse({
      contentText: '',
      contentJson: null,
      expectedVersion: 2,
    });
    expect(parsed.contentJson).toBeNull();
    expect(parsed.contentText).toBe('');
  });

  it('拒绝缺失 expectedVersion、非正版本号与超长正文', () => {
    expect(saveChapterContentSchema.safeParse({ contentText: '正文' }).success).toBe(false);
    expect(saveChapterContentSchema.safeParse({ contentText: '正文', expectedVersion: 0 }).success).toBe(
      false,
    );
    expect(
      saveChapterContentSchema.safeParse({ contentText: '正文', expectedVersion: 1.5 }).success,
    ).toBe(false);
    expect(
      saveChapterContentSchema.safeParse({
        contentText: 'x'.repeat(MAX_CHAPTER_CONTENT_LENGTH + 1),
        expectedVersion: 1,
      }).success,
    ).toBe(false);
  });

  it('拒绝空白标题、非对象 contentJson 与多余字段', () => {
    expect(
      saveChapterContentSchema.safeParse({ contentText: '正文', expectedVersion: 1, title: '  ' })
        .success,
    ).toBe(false);
    expect(
      saveChapterContentSchema.safeParse({
        contentText: '正文',
        expectedVersion: 1,
        contentJson: 'doc',
      }).success,
    ).toBe(false);
    expect(
      saveChapterContentSchema.safeParse({ contentText: '正文', expectedVersion: 1, wordCount: 2 })
        .success,
    ).toBe(false);
  });
});

describe('chapterSaveResponseSchema', () => {
  it('接受保存响应', () => {
    const parsed = chapterSaveResponseSchema.parse({
      chapter: chapterDetail(),
      autoRevisionCreated: true,
    });
    expect(parsed.chapter.version).toBe(3);
    expect(parsed.autoRevisionCreated).toBe(true);
  });

  it('拒绝缺失 autoRevisionCreated 或 chapter 非法', () => {
    expect(chapterSaveResponseSchema.safeParse({ chapter: chapterDetail() }).success).toBe(false);
    expect(chapterSaveResponseSchema.safeParse({ chapter: {}, autoRevisionCreated: false }).success).toBe(
      false,
    );
    expect(
      chapterSaveResponseSchema.safeParse({ chapter: chapterDetail(), autoRevisionCreated: 'yes' })
        .success,
    ).toBe(false);
  });
});
