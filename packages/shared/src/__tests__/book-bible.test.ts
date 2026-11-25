import { describe, expect, it } from 'vitest';
import {
  AI_APPLY_MODES,
  AI_APPLY_MODE_LABELS,
  AI_STREAM_EVENT_NAMES,
  AI_WRITE_ACTIONS,
  AI_WRITE_ACTION_LABELS,
  CHAPTER_SUMMARY_SOURCES,
  CHAPTER_SUMMARY_SOURCE_LABELS,
  CONTEXT_CARD_RECALL_REASONS,
  CONTEXT_CARD_RECALL_REASON_LABELS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_PREV_CHAPTER_TAIL_CHARS,
  DEFAULT_RECENT_SUMMARIES_COUNT,
  KNOWLEDGE_CARD_CATEGORIES,
  KNOWLEDGE_CARD_CATEGORY_LABELS,
  MAX_BOOK_OUTLINE_FIELD_LENGTH,
  MAX_CARD_ALIASES_COUNT,
  MAX_CARD_ALIAS_LENGTH,
  MAX_CARD_CONTENT_LENGTH,
  MAX_CARD_SUMMARY_LENGTH,
  MAX_CARD_TAGS_COUNT,
  MAX_CARD_TAG_LENGTH,
  MAX_CARD_TITLE_LENGTH,
  MAX_CHAPTER_OUTLINE_LENGTH,
  MAX_CHAPTER_SUMMARY_LENGTH,
  MAX_MAX_CONTEXT_TOKENS,
  MAX_PREV_CHAPTER_TAIL_CHARS,
  MAX_RECALLED_CARDS,
  MAX_RECENT_SUMMARIES_COUNT,
  MIN_MAX_CONTEXT_TOKENS,
  aiWriteActionSchema,
  bookOutlineDtoSchema,
  chapterSummaryDtoSchema,
  chapterSummarySourceSchema,
  createKnowledgeCardSchema,
  extractChapterSummaryResponseSchema,
  extractChapterSummarySchema,
  knowledgeCardCategorySchema,
  knowledgeCardDtoSchema,
  knowledgeCardListQuerySchema,
  knowledgeCardListResponseSchema,
  updateKnowledgeCardSchema,
  upsertBookOutlineSchema,
  upsertChapterSummarySchema,
} from '../index.js';

const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const CARD_ID = '33333333-3333-4333-8333-333333333333';
const CHAPTER_ID = '44444444-4444-4444-8444-444444444444';
const CREATED_AT = '2026-02-01T10:00:00.000Z';
const UPDATED_AT = '2026-02-02T11:30:00.000Z';

/** 合法设定卡 DTO 夹具（各用例按需覆盖字段）。 */
function knowledgeCardDto(overrides: Record<string, unknown> = {}) {
  return {
    id: CARD_ID,
    bookId: BOOK_ID,
    category: 'character',
    title: '萧炎',
    summary: '主角，斗气大陆少年。',
    content: '性格坚毅，重情重义。',
    aliases: ['炎帝'],
    tags: ['主角'],
    pinned: true,
    sortOrder: 0,
    hasEmbedding: false,
    embeddingModelRef: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function chapterSummaryDto(overrides: Record<string, unknown> = {}) {
  return {
    chapterId: CHAPTER_ID,
    bookId: BOOK_ID,
    outline: '主角出山，初遇强敌。',
    summary: '少年负剑出山，于村口击退妖兽。',
    keyEvents: ['负剑出山', '击退妖兽'],
    charactersPresent: ['萧炎', '药老'],
    source: 'manual',
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe('Book Bible 领域常量', () => {
  it('6 类设定卡分类与中文标签一一对应', () => {
    expect(KNOWLEDGE_CARD_CATEGORIES).toHaveLength(6);
    expect([...KNOWLEDGE_CARD_CATEGORIES]).toEqual([
      'character',
      'world',
      'faction',
      'item',
      'foreshadowing',
      'timeline',
    ]);
    expect(KNOWLEDGE_CARD_CATEGORY_LABELS.character).toBe('人物');
    expect(KNOWLEDGE_CARD_CATEGORY_LABELS.world).toBe('世界观');
    expect(KNOWLEDGE_CARD_CATEGORY_LABELS.faction).toBe('势力');
    expect(KNOWLEDGE_CARD_CATEGORY_LABELS.item).toBe('物品/金手指');
    expect(KNOWLEDGE_CARD_CATEGORY_LABELS.foreshadowing).toBe('伏笔');
    expect(KNOWLEDGE_CARD_CATEGORY_LABELS.timeline).toBe('时间线');
    expect(Object.keys(KNOWLEDGE_CARD_CATEGORY_LABELS)).toEqual([...KNOWLEDGE_CARD_CATEGORIES]);
    expect(knowledgeCardCategorySchema.safeParse('character').success).toBe(true);
    expect(knowledgeCardCategorySchema.safeParse('unknown').success).toBe(false);
  });

  it('章节摘要来源为 manual / ai', () => {
    expect([...CHAPTER_SUMMARY_SOURCES]).toEqual(['manual', 'ai']);
    expect(CHAPTER_SUMMARY_SOURCE_LABELS.ai).toBe('AI 提炼');
    expect(chapterSummarySourceSchema.safeParse('manual').success).toBe(true);
    expect(chapterSummarySourceSchema.safeParse('auto').success).toBe(false);
  });

  it('4 种写作动作与中文标签符合契约', () => {
    expect([...AI_WRITE_ACTIONS]).toEqual(['continue', 'expand', 'rewrite', 'polish']);
    expect(AI_WRITE_ACTION_LABELS).toEqual({
      continue: '续写',
      expand: '扩写',
      rewrite: '改写',
      polish: '润色',
    });
    for (const action of AI_WRITE_ACTIONS) {
      expect(aiWriteActionSchema.safeParse(action).success).toBe(true);
    }
    expect(aiWriteActionSchema.safeParse('summarize').success).toBe(false);
  });

  it('3 种正文应用模式与中文标签符合契约', () => {
    expect([...AI_APPLY_MODES]).toEqual(['append', 'replace_all', 'replace_selection']);
    expect(AI_APPLY_MODE_LABELS).toEqual({
      append: '追加到文末',
      replace_all: '替换全文',
      replace_selection: '替换选中片段',
    });
  });

  it('SSE 帧名固定为 start / delta / done / error', () => {
    expect(AI_STREAM_EVENT_NAMES).toEqual({
      start: 'start',
      delta: 'delta',
      done: 'done',
      error: 'error',
    });
    expect(new Set(Object.values(AI_STREAM_EVENT_NAMES)).size).toBe(4);
  });

  it('召回原因按「手动勾选 > 常驻置顶 > 自动召回」排序', () => {
    expect([...CONTEXT_CARD_RECALL_REASONS]).toEqual(['selected', 'pinned', 'recalled']);
    expect(CONTEXT_CARD_RECALL_REASON_LABELS.selected).toBe('手动勾选');
    expect(CONTEXT_CARD_RECALL_REASON_LABELS.pinned).toBe('常驻置顶');
    expect(CONTEXT_CARD_RECALL_REASON_LABELS.recalled).toBe('智能召回');
  });

  it('上下文预算默认值与设计文档一致，且区间自洽', () => {
    expect(DEFAULT_MAX_CONTEXT_TOKENS).toBe(8_000);
    expect(MIN_MAX_CONTEXT_TOKENS).toBe(1_000);
    expect(MAX_MAX_CONTEXT_TOKENS).toBe(128_000);
    expect(MIN_MAX_CONTEXT_TOKENS).toBeLessThan(DEFAULT_MAX_CONTEXT_TOKENS);
    expect(DEFAULT_MAX_CONTEXT_TOKENS).toBeLessThan(MAX_MAX_CONTEXT_TOKENS);

    expect(DEFAULT_RECENT_SUMMARIES_COUNT).toBe(3);
    expect(MAX_RECENT_SUMMARIES_COUNT).toBe(10);
    expect(DEFAULT_RECENT_SUMMARIES_COUNT).toBeLessThanOrEqual(MAX_RECENT_SUMMARIES_COUNT);

    expect(DEFAULT_PREV_CHAPTER_TAIL_CHARS).toBe(800);
    expect(MAX_PREV_CHAPTER_TAIL_CHARS).toBe(4_000);
    expect(DEFAULT_PREV_CHAPTER_TAIL_CHARS).toBeLessThanOrEqual(MAX_PREV_CHAPTER_TAIL_CHARS);

    expect(MAX_RECALLED_CARDS).toBe(8);
  });

  it('字段长度上限覆盖总大纲 / 设定卡 / 章节摘要 / 指令', () => {
    expect(MAX_BOOK_OUTLINE_FIELD_LENGTH).toBe(50_000);
    expect(MAX_CARD_TITLE_LENGTH).toBe(100);
    expect(MAX_CARD_SUMMARY_LENGTH).toBe(1_000);
    expect(MAX_CARD_CONTENT_LENGTH).toBe(20_000);
    expect(MAX_CARD_ALIAS_LENGTH).toBe(60);
    expect(MAX_CARD_ALIASES_COUNT).toBe(20);
    expect(MAX_CARD_TAG_LENGTH).toBe(40);
    expect(MAX_CARD_TAGS_COUNT).toBe(20);
    expect(MAX_CHAPTER_OUTLINE_LENGTH).toBe(10_000);
    expect(MAX_CHAPTER_SUMMARY_LENGTH).toBe(10_000);
    expect(MAX_CARD_SUMMARY_LENGTH).toBeLessThan(MAX_CARD_CONTENT_LENGTH);
  });
});

describe('bookOutlineDtoSchema', () => {
  it('接受未填写大纲的新书结构（updatedAt 为 null）', () => {
    const parsed = bookOutlineDtoSchema.parse({
      bookId: BOOK_ID,
      mainPlot: '',
      worldSetting: '',
      styleGuide: '',
      endingPlan: '',
      updatedAt: null,
    });
    expect(parsed.updatedAt).toBeNull();
    expect(parsed.mainPlot).toBe('');
  });

  it('拒绝未知字段与非法 bookId', () => {
    const base = {
      bookId: BOOK_ID,
      mainPlot: '主角复仇',
      worldSetting: '斗气大陆',
      styleGuide: '爽文快节奏',
      endingPlan: '登顶巅峰',
      updatedAt: UPDATED_AT,
    };
    expect(bookOutlineDtoSchema.safeParse(base).success).toBe(true);
    expect(bookOutlineDtoSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(bookOutlineDtoSchema.safeParse({ ...base, bookId: 'not-a-uuid' }).success).toBe(false);
    expect(bookOutlineDtoSchema.safeParse({ ...base, updatedAt: '2026-02-02' }).success).toBe(false);
  });

  it('拒绝超长总大纲字段', () => {
    const result = bookOutlineDtoSchema.safeParse({
      bookId: BOOK_ID,
      mainPlot: 'x'.repeat(MAX_BOOK_OUTLINE_FIELD_LENGTH + 1),
      worldSetting: '',
      styleGuide: '',
      endingPlan: '',
      updatedAt: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('upsertBookOutlineSchema', () => {
  it('缺省字段全部填充为空字符串', () => {
    const parsed = upsertBookOutlineSchema.parse({});
    expect(parsed).toEqual({ mainPlot: '', worldSetting: '', styleGuide: '', endingPlan: '' });
  });

  it('接受四个分段并拒绝未知字段', () => {
    const payload = {
      mainPlot: '主线',
      worldSetting: '世界观',
      styleGuide: '文风',
      endingPlan: '结局',
    };
    expect(upsertBookOutlineSchema.parse(payload)).toEqual(payload);
    expect(upsertBookOutlineSchema.safeParse({ ...payload, bookId: BOOK_ID }).success).toBe(false);
  });

  it('拒绝单字段超长', () => {
    expect(
      upsertBookOutlineSchema.safeParse({
        endingPlan: 'x'.repeat(MAX_BOOK_OUTLINE_FIELD_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe('knowledgeCardDtoSchema', () => {
  it('接受合法设定卡（含常驻置顶与空向量信息）', () => {
    const parsed = knowledgeCardDtoSchema.parse(knowledgeCardDto());
    expect(parsed.pinned).toBe(true);
    expect(parsed.hasEmbedding).toBe(false);
    expect(parsed.embeddingModelRef).toBeNull();
    expect(parsed.aliases).toEqual(['炎帝']);
  });

  it('接受已向量化的设定卡', () => {
    const parsed = knowledgeCardDtoSchema.parse(
      knowledgeCardDto({ hasEmbedding: true, embeddingModelRef: 'openai/text-embedding-3-small' }),
    );
    expect(parsed.hasEmbedding).toBe(true);
    expect(parsed.embeddingModelRef).toBe('openai/text-embedding-3-small');
  });

  it('拒绝未知分类、空标题与超长字段', () => {
    expect(knowledgeCardDtoSchema.safeParse(knowledgeCardDto({ category: 'magic' })).success).toBe(false);
    expect(knowledgeCardDtoSchema.safeParse(knowledgeCardDto({ title: '' })).success).toBe(false);
    expect(
      knowledgeCardDtoSchema.safeParse(knowledgeCardDto({ title: 'x'.repeat(MAX_CARD_TITLE_LENGTH + 1) }))
        .success,
    ).toBe(false);
    expect(
      knowledgeCardDtoSchema.safeParse(
        knowledgeCardDto({ content: 'x'.repeat(MAX_CARD_CONTENT_LENGTH + 1) }),
      ).success,
    ).toBe(false);
  });

  it('拒绝别名 / 标签中的空串与原始向量字段', () => {
    expect(knowledgeCardDtoSchema.safeParse(knowledgeCardDto({ aliases: [''] })).success).toBe(false);
    expect(knowledgeCardDtoSchema.safeParse(knowledgeCardDto({ tags: [''] })).success).toBe(false);
    expect(knowledgeCardDtoSchema.safeParse(knowledgeCardDto({ embedding: [0.1, 0.2] })).success).toBe(
      false,
    );
  });
});

describe('knowledgeCardListQuerySchema', () => {
  it('空查询串全部视为未传', () => {
    expect(knowledgeCardListQuerySchema.parse({})).toEqual({
      category: undefined,
      q: undefined,
      pinned: undefined,
    });
    expect(knowledgeCardListQuerySchema.parse({ category: '', q: '', pinned: '' })).toEqual({
      category: undefined,
      q: undefined,
      pinned: undefined,
    });
  });

  it('接受分类 / 关键字 / 常驻筛选，并兼容 Fastify 字符串布尔', () => {
    expect(knowledgeCardListQuerySchema.parse({ category: 'foreshadowing' })).toMatchObject({
      category: 'foreshadowing',
    });
    expect(knowledgeCardListQuerySchema.parse({ q: '  萧炎  ' }).q).toBe('萧炎');
    expect(knowledgeCardListQuerySchema.parse({ pinned: 'true' }).pinned).toBe(true);
    expect(knowledgeCardListQuerySchema.parse({ pinned: 'false' }).pinned).toBe(false);
    expect(knowledgeCardListQuerySchema.parse({ pinned: true }).pinned).toBe(true);
  });

  it('拒绝非法分类、超长关键字、非法布尔与未知字段', () => {
    expect(knowledgeCardListQuerySchema.safeParse({ category: 'magic' }).success).toBe(false);
    expect(knowledgeCardListQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    expect(knowledgeCardListQuerySchema.safeParse({ pinned: 'yes' }).success).toBe(false);
    expect(knowledgeCardListQuerySchema.safeParse({ bookId: BOOK_ID }).success).toBe(false);
  });
});

describe('knowledgeCardListResponseSchema', () => {
  it('接受列表响应并拒绝缺字段', () => {
    expect(
      knowledgeCardListResponseSchema.parse({ items: [knowledgeCardDto()], total: 1 }).total,
    ).toBe(1);
    expect(knowledgeCardListResponseSchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      knowledgeCardListResponseSchema.safeParse({ items: [], total: -1 }).success,
    ).toBe(false);
  });
});

describe('createKnowledgeCardSchema', () => {
  it('仅需分类与标题，其余字段填充默认值', () => {
    const parsed = createKnowledgeCardSchema.parse({ category: 'world', title: '  斗气大陆  ' });
    expect(parsed).toEqual({
      category: 'world',
      title: '斗气大陆',
      summary: '',
      content: '',
      aliases: [],
      tags: [],
      pinned: false,
    });
  });

  it('别名 / 标签自动去空白并拒绝超量与超长', () => {
    const parsed = createKnowledgeCardSchema.parse({
      category: 'item',
      title: '异火',
      aliases: ['  陨落心炎  '],
      tags: [' 金手指 '],
    });
    expect(parsed.aliases).toEqual(['陨落心炎']);
    expect(parsed.tags).toEqual(['金手指']);

    expect(
      createKnowledgeCardSchema.safeParse({
        category: 'item',
        title: '异火',
        aliases: Array.from({ length: MAX_CARD_ALIASES_COUNT + 1 }, (_, index) => `别名${index}`),
      }).success,
    ).toBe(false);
    expect(
      createKnowledgeCardSchema.safeParse({
        category: 'item',
        title: '异火',
        tags: Array.from({ length: MAX_CARD_TAGS_COUNT + 1 }, (_, index) => `标签${index}`),
      }).success,
    ).toBe(false);
    expect(
      createKnowledgeCardSchema.safeParse({
        category: 'item',
        title: '异火',
        aliases: ['x'.repeat(MAX_CARD_ALIAS_LENGTH + 1)],
      }).success,
    ).toBe(false);
    expect(
      createKnowledgeCardSchema.safeParse({
        category: 'item',
        title: '异火',
        tags: ['x'.repeat(MAX_CARD_TAG_LENGTH + 1)],
      }).success,
    ).toBe(false);
  });

  it('拒绝空标题 / 空白标题 / 非法分类 / 未知字段', () => {
    expect(createKnowledgeCardSchema.safeParse({ category: 'item', title: '   ' }).success).toBe(false);
    expect(createKnowledgeCardSchema.safeParse({ category: 'item' }).success).toBe(false);
    expect(createKnowledgeCardSchema.safeParse({ category: 'magic', title: '异火' }).success).toBe(false);
    expect(createKnowledgeCardSchema.safeParse({ category: 'item', title: '异火', id: CARD_ID }).success).toBe(
      false,
    );
  });
});

describe('updateKnowledgeCardSchema', () => {
  it('拒绝空更新体', () => {
    expect(updateKnowledgeCardSchema.safeParse({}).success).toBe(false);
  });

  it('接受置顶切换、排序与内容更新', () => {
    expect(updateKnowledgeCardSchema.parse({ pinned: false })).toEqual({ pinned: false });
    expect(updateKnowledgeCardSchema.parse({ sortOrder: 3 }).sortOrder).toBe(3);
    expect(updateKnowledgeCardSchema.parse({ title: '  萧炎  ' }).title).toBe('萧炎');
  });

  it('拒绝非法字段值', () => {
    expect(updateKnowledgeCardSchema.safeParse({ pinned: 'yes' }).success).toBe(false);
    expect(updateKnowledgeCardSchema.safeParse({ sortOrder: -1 }).success).toBe(false);
    expect(updateKnowledgeCardSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(updateKnowledgeCardSchema.safeParse({ category: 'magic' }).success).toBe(false);
  });
});

describe('chapterSummaryDtoSchema', () => {
  it('接受手工摘要与 AI 摘要', () => {
    expect(chapterSummaryDtoSchema.parse(chapterSummaryDto()).source).toBe('manual');
    expect(chapterSummaryDtoSchema.parse(chapterSummaryDto({ source: 'ai' })).source).toBe('ai');
  });

  it('接受未填写的空默认结构', () => {
    const parsed = chapterSummaryDtoSchema.parse({
      chapterId: CHAPTER_ID,
      bookId: BOOK_ID,
      outline: '',
      summary: '',
      keyEvents: [],
      charactersPresent: [],
      source: 'manual',
      updatedAt: null,
    });
    expect(parsed.updatedAt).toBeNull();
  });

  it('拒绝未知字段、非法来源与超长字段', () => {
    expect(chapterSummaryDtoSchema.safeParse(chapterSummaryDto({ extra: 1 })).success).toBe(false);
    expect(chapterSummaryDtoSchema.safeParse(chapterSummaryDto({ source: 'auto' })).success).toBe(false);
    expect(
      chapterSummaryDtoSchema.safeParse(
        chapterSummaryDto({ outline: 'x'.repeat(MAX_CHAPTER_OUTLINE_LENGTH + 1) }),
      ).success,
    ).toBe(false);
    expect(
      chapterSummaryDtoSchema.safeParse(
        chapterSummaryDto({ summary: 'x'.repeat(MAX_CHAPTER_SUMMARY_LENGTH + 1) }),
      ).success,
    ).toBe(false);
    expect(chapterSummaryDtoSchema.safeParse(chapterSummaryDto({ keyEvents: [''] })).success).toBe(false);
  });
});

describe('upsertChapterSummarySchema', () => {
  it('拒绝空更新体', () => {
    expect(upsertChapterSummarySchema.safeParse({}).success).toBe(false);
  });

  it('接受单字段更新并裁剪列表项空白', () => {
    expect(upsertChapterSummarySchema.parse({ summary: '剧情摘要' }).summary).toBe('剧情摘要');
    expect(
      upsertChapterSummarySchema.parse({ keyEvents: ['  负剑出山  '], charactersPresent: [' 萧炎 '] }),
    ).toEqual({ keyEvents: ['负剑出山'], charactersPresent: ['萧炎'] });
  });

  it('拒绝超量 / 超长关键事件与未知字段', () => {
    expect(
      upsertChapterSummarySchema.safeParse({
        keyEvents: Array.from({ length: 31 }, (_, index) => `事件${index}`),
      }).success,
    ).toBe(false);
    expect(
      upsertChapterSummarySchema.safeParse({ keyEvents: ['x'.repeat(201)] }).success,
    ).toBe(false);
    expect(
      upsertChapterSummarySchema.safeParse({
        charactersPresent: Array.from({ length: 51 }, (_, index) => `角色${index}`),
      }).success,
    ).toBe(false);
    expect(upsertChapterSummarySchema.safeParse({ source: 'ai' }).success).toBe(false);
  });
});

describe('extractChapterSummarySchema', () => {
  it('默认落盘（save=true）', () => {
    expect(extractChapterSummarySchema.parse({})).toEqual({ save: true });
  });

  it('接受指令与温度', () => {
    const parsed = extractChapterSummarySchema.parse({
      save: false,
      instruction: '  只提炼主线  ',
      temperature: 0.3,
    });
    expect(parsed.instruction).toBe('只提炼主线');
    expect(parsed.temperature).toBe(0.3);
  });

  it('拒绝越界温度 / 超长指令 / 未知字段', () => {
    expect(extractChapterSummarySchema.safeParse({ temperature: 2.5 }).success).toBe(false);
    expect(extractChapterSummarySchema.safeParse({ temperature: -0.1 }).success).toBe(false);
    expect(
      extractChapterSummarySchema.safeParse({ instruction: 'x'.repeat(1001) }).success,
    ).toBe(false);
    expect(extractChapterSummarySchema.safeParse({ model: 'gpt-4o' }).success).toBe(false);
  });
});

describe('extractChapterSummaryResponseSchema', () => {
  it('接受带用量与审计日志 ID 的响应', () => {
    const parsed = extractChapterSummaryResponseSchema.parse({
      summary: chapterSummaryDto({ source: 'ai' }),
      usage: { inputTokens: 1200, outputTokens: 260, estimatedCostUsd: 0.00042, latencyMs: 1450 },
      modelRef: 'openai/gpt-4o-mini',
      usageLogId: '66666666-6666-4666-8666-666666666666',
    });
    expect(parsed.summary.source).toBe('ai');
    expect(parsed.usage.inputTokens).toBe(1200);
  });

  it('允许 usageLogId 为 null，但拒绝负 Token / 未知字段', () => {
    const base = {
      summary: chapterSummaryDto(),
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: 0 },
      modelRef: 'openai/gpt-4o-mini',
      usageLogId: null,
    };
    expect(extractChapterSummaryResponseSchema.safeParse(base).success).toBe(true);
    expect(
      extractChapterSummaryResponseSchema.safeParse({
        ...base,
        usage: { ...base.usage, inputTokens: -1 },
      }).success,
    ).toBe(false);
    expect(
      extractChapterSummaryResponseSchema.safeParse({ ...base, extra: true }).success,
    ).toBe(false);
  });
});
