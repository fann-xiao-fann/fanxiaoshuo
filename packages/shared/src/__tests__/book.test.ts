import { describe, expect, it } from 'vitest';
import {
  AUTO_REVISION_INTERVAL_MS,
  BOOK_STATUSES,
  BOOK_STATUS_LABELS,
  CHAPTER_STATUSES,
  CHAPTER_STATUS_LABELS,
  DEFAULT_TARGET_CHAPTER_WORDS,
  EXPORT_FORMATS,
  EXPORT_FORMAT_META,
  MAX_CHAPTER_CONTENT_LENGTH,
  REVISION_SOURCES,
  REVISION_SOURCE_LABELS,
  bookDtoSchema,
  bookExportQuerySchema,
  bookListQuerySchema,
  bookListResponseSchema,
  bookStatusSchema,
  chapterStatusSchema,
  createBookSchema,
  exportFormatSchema,
  revisionSourceSchema,
  updateBookSchema,
} from '../index.js';

const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-02-01T10:00:00.000Z';
const UPDATED_AT = '2026-02-02T11:30:00.000Z';

/** 合法书籍 DTO 夹具（各用例按需覆盖字段）。 */
function bookDto(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOK_ID,
    title: '斗破苍穹',
    authorPenName: '天蚕土豆',
    genre: '玄幻',
    status: 'ongoing',
    synopsis: '少年萧炎，斗气大陆崛起之路。',
    targetChapterWords: 3000,
    volumeCount: 2,
    chapterCount: 18,
    totalWordCount: 54_000,
    deletedAt: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe('书籍 / 章节 / 快照 / 导出枚举与中文展示名', () => {
  it('状态枚举字面量与设计文档一致', () => {
    expect(BOOK_STATUSES).toEqual(['draft', 'ongoing', 'completed', 'archived']);
    expect(CHAPTER_STATUSES).toEqual(['outline', 'draft', 'reviewing', 'final']);
    expect(REVISION_SOURCES).toEqual(['manual', 'auto', 'restore', 'ai']);
    expect(EXPORT_FORMATS).toEqual(['txt', 'md']);
  });

  it('中文展示名覆盖全部枚举值且非空', () => {
    expect(Object.keys(BOOK_STATUS_LABELS)).toEqual([...BOOK_STATUSES]);
    expect(Object.keys(CHAPTER_STATUS_LABELS)).toEqual([...CHAPTER_STATUSES]);
    expect(Object.keys(REVISION_SOURCE_LABELS)).toEqual([...REVISION_SOURCES]);
    for (const labels of [BOOK_STATUS_LABELS, CHAPTER_STATUS_LABELS, REVISION_SOURCE_LABELS]) {
      for (const label of Object.values(labels)) {
        expect(typeof label).toBe('string');
        expect(label.length).toBeGreaterThan(0);
      }
    }
  });

  it('enum schema 接受全部合法值并拒绝未知值', () => {
    for (const status of BOOK_STATUSES) {
      expect(bookStatusSchema.safeParse(status).success).toBe(true);
    }
    for (const status of CHAPTER_STATUSES) {
      expect(chapterStatusSchema.safeParse(status).success).toBe(true);
    }
    for (const source of REVISION_SOURCES) {
      expect(revisionSourceSchema.safeParse(source).success).toBe(true);
    }
    for (const format of EXPORT_FORMATS) {
      expect(exportFormatSchema.safeParse(format).success).toBe(true);
    }
    expect(bookStatusSchema.safeParse('paused').success).toBe(false);
    expect(chapterStatusSchema.safeParse('').success).toBe(false);
    expect(revisionSourceSchema.safeParse('AUTO').success).toBe(false);
    expect(exportFormatSchema.safeParse('pdf').success).toBe(false);
  });

  it('运行常量与设计文档一致', () => {
    expect(AUTO_REVISION_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(MAX_CHAPTER_CONTENT_LENGTH).toBe(500_000);
    expect(DEFAULT_TARGET_CHAPTER_WORDS).toBe(3000);
  });

  it('导出格式元信息提供 UTF-8 Content-Type', () => {
    expect(EXPORT_FORMAT_META.txt.contentType).toBe('text/plain; charset=utf-8');
    expect(EXPORT_FORMAT_META.md.contentType).toBe('text/markdown; charset=utf-8');
    expect(EXPORT_FORMAT_META.txt.extension).toBe('txt');
    expect(EXPORT_FORMAT_META.md.extension).toBe('md');
  });
});

describe('bookDtoSchema', () => {
  it('接受完整书籍 DTO（含聚合统计）', () => {
    const parsed = bookDtoSchema.parse(bookDto());
    expect(parsed.volumeCount).toBe(2);
    expect(parsed.chapterCount).toBe(18);
    expect(parsed.totalWordCount).toBe(54_000);
    expect(parsed.deletedAt).toBeNull();
  });

  it('接受回收站中带 deletedAt 的书籍', () => {
    expect(bookDtoSchema.safeParse(bookDto({ deletedAt: UPDATED_AT })).success).toBe(true);
  });

  it('拒绝缺失聚合字段与负数字数', () => {
    const { totalWordCount: _omitted, ...withoutTotal } = bookDto();
    expect(bookDtoSchema.safeParse(withoutTotal).success).toBe(false);
    expect(bookDtoSchema.safeParse(bookDto({ totalWordCount: -1 })).success).toBe(false);
    expect(bookDtoSchema.safeParse(bookDto({ chapterCount: 1.5 })).success).toBe(false);
  });

  it('拒绝非法状态、非法 UUID 与空标题', () => {
    expect(bookDtoSchema.safeParse(bookDto({ status: 'paused' })).success).toBe(false);
    expect(bookDtoSchema.safeParse(bookDto({ id: 'not-a-uuid' })).success).toBe(false);
    expect(bookDtoSchema.safeParse(bookDto({ title: '' })).success).toBe(false);
  });

  it('strictObject 拒绝多余字段（防止越界契约漂移）', () => {
    expect(bookDtoSchema.safeParse(bookDto({ apiKey: 'leak' })).success).toBe(false);
  });
});

describe('createBookSchema', () => {
  it('仅必填 title，其余字段取默认值', () => {
    const parsed = createBookSchema.parse({ title: '  诡秘之主  ' });
    expect(parsed).toEqual({
      title: '诡秘之主',
      authorPenName: '',
      genre: '',
      status: 'draft',
      synopsis: '',
      targetChapterWords: DEFAULT_TARGET_CHAPTER_WORDS,
    });
  });

  it('接受完整字段并保留显式 targetChapterWords', () => {
    const parsed = createBookSchema.parse({
      title: '凡人修仙传',
      authorPenName: '忘语',
      genre: '仙侠',
      status: 'ongoing',
      synopsis: '一个普通山村穷小子修仙的故事。',
      targetChapterWords: 2500,
    });
    expect(parsed.targetChapterWords).toBe(2500);
    expect(parsed.status).toBe('ongoing');
  });

  it('拒绝空 / 纯空白 / 超长标题', () => {
    expect(createBookSchema.safeParse({ title: '' }).success).toBe(false);
    expect(createBookSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(createBookSchema.safeParse({ title: 'x'.repeat(121) }).success).toBe(false);
    expect(createBookSchema.safeParse({ title: 'x'.repeat(120) }).success).toBe(true);
  });

  it('拒绝非法单章目标字数（0 / 负数 / 小数 / 超上限 / 字符串）', () => {
    for (const targetChapterWords of [0, -1, 1.5, 50_001, '3000']) {
      expect(createBookSchema.safeParse({ title: '测试书', targetChapterWords }).success).toBe(false);
    }
    expect(createBookSchema.safeParse({ title: '测试书', targetChapterWords: 1 }).success).toBe(true);
  });

  it('拒绝未知字段与缺失 title', () => {
    expect(createBookSchema.safeParse({}).success).toBe(false);
    expect(createBookSchema.safeParse({ title: '测试书', volumeCount: 0 }).success).toBe(false);
  });
});

describe('updateBookSchema', () => {
  it('接受单字段更新', () => {
    expect(updateBookSchema.parse({ status: 'completed' })).toEqual({ status: 'completed' });
  });

  it('拒绝空对象（至少一个字段）', () => {
    expect(updateBookSchema.safeParse({}).success).toBe(false);
  });

  it('拒绝空白标题、非法状态与多余字段', () => {
    expect(updateBookSchema.safeParse({ title: '  ' }).success).toBe(false);
    expect(updateBookSchema.safeParse({ status: 'paused' }).success).toBe(false);
    expect(updateBookSchema.safeParse({ title: '新书名', totalWordCount: 1 }).success).toBe(false);
  });
});

describe('bookListQuerySchema', () => {
  it('空查询串取默认值（默认排除回收站）', () => {
    const parsed = bookListQuerySchema.parse({});
    expect(parsed.includeDeleted).toBe('exclude');
    expect(parsed.status).toBeUndefined();
    expect(parsed.q).toBeUndefined();
  });

  it('空字符串查询参数视为未传（Fastify ?status= 场景）', () => {
    const parsed = bookListQuerySchema.parse({ status: '', q: '', includeDeleted: '' });
    expect(parsed.includeDeleted).toBe('exclude');
    expect(parsed.status).toBeUndefined();
    expect(parsed.q).toBeUndefined();
  });

  it('接受状态 / 关键字 / 回收站筛选并去除首尾空白', () => {
    const parsed = bookListQuerySchema.parse({
      status: 'archived',
      q: '  斗破  ',
      includeDeleted: 'only',
    });
    expect(parsed).toEqual({ status: 'archived', q: '斗破', includeDeleted: 'only' });
  });

  it('拒绝非法状态、非法 includeDeleted 与多余参数', () => {
    expect(bookListQuerySchema.safeParse({ status: 'paused' }).success).toBe(false);
    expect(bookListQuerySchema.safeParse({ includeDeleted: 'all' }).success).toBe(false);
    expect(bookListQuerySchema.safeParse({ page: '2' }).success).toBe(false);
    expect(bookListQuerySchema.safeParse({ q: 'x'.repeat(121) }).success).toBe(false);
  });
});

describe('bookListResponseSchema', () => {
  it('接受书籍列表', () => {
    const parsed = bookListResponseSchema.parse({ items: [bookDto()], total: 1 });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.total).toBe(1);
  });

  it('拒绝负数 total 与非法条目', () => {
    expect(bookListResponseSchema.safeParse({ items: [], total: -1 }).success).toBe(false);
    expect(bookListResponseSchema.safeParse({ items: [{ id: BOOK_ID }], total: 1 }).success).toBe(
      false,
    );
  });
});

describe('bookExportQuerySchema', () => {
  it('接受 txt / md', () => {
    expect(bookExportQuerySchema.parse({ format: 'txt' })).toEqual({ format: 'txt' });
    expect(bookExportQuerySchema.parse({ format: 'md' })).toEqual({ format: 'md' });
  });

  it('拒绝缺失 / 非法 / 多余字段', () => {
    expect(bookExportQuerySchema.safeParse({}).success).toBe(false);
    expect(bookExportQuerySchema.safeParse({ format: 'epub' }).success).toBe(false);
    expect(bookExportQuerySchema.safeParse({ format: 'txt', pretty: true }).success).toBe(false);
  });
});
