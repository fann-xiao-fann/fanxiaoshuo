import { describe, expect, it } from 'vitest';
import {
  aiContextPreviewResponseSchema,
  aiContextSectionPreviewSchema,
} from '@fanxiaoshuo/shared';
import {
  assembleChapterContext,
  type AssembleChapterContextInput,
  type ContextKnowledgeCardInput,
} from '../index.js';

/**
 * 上下文组装器单测：
 * 覆盖完整组装的分段顺序、与共享 `aiContextPreviewResponseSchema` 的字段契合、
 * 超预算时的确定性裁剪顺序与 `truncated` 标记，以及选区 / 总大纲 / 前情开关。
 */

const SELECTED_CARD_ID = '11111111-1111-4111-8111-111111111111';
const PINNED_CARD_ID = '22222222-2222-4222-8222-222222222222';
const RECALLED_CARD_ID = '33333333-3333-4333-8333-333333333333';

const LONG_CONTENT = '他自幼在青云宗外门打杂，直到那一夜剑冢异动才被长老注意。'.repeat(10);
const PINNED_CONTENT = '炼气、筑基、金丹、元婴四大境界，越阶而战必受反噬。'.repeat(6);

const CARDS: readonly ContextKnowledgeCardInput[] = [
  {
    id: SELECTED_CARD_ID,
    category: 'character',
    title: '沈砚',
    summary: '青云宗弃徒，持半枚断剑',
    content: LONG_CONTENT,
    aliases: ['砚哥'],
    tags: ['主角'],
    pinned: false,
    sortOrder: 3,
    embedding: null,
  },
  {
    id: PINNED_CARD_ID,
    category: 'world',
    title: '修行境界',
    summary: '境界划分与越阶代价',
    content: PINNED_CONTENT,
    aliases: [],
    tags: ['设定'],
    pinned: true,
    sortOrder: 1,
    embedding: null,
  },
  {
    id: RECALLED_CARD_ID,
    category: 'foreshadowing',
    title: '伏击',
    summary: '青石镇伏击的幕后主使尚未揭晓',
    content: '',
    aliases: [],
    tags: ['伏笔'],
    pinned: false,
    sortOrder: 2,
    embedding: null,
  },
];

function buildInput(overrides: Partial<AssembleChapterContextInput['options']> = {}): AssembleChapterContextInput {
  return {
    book: {
      title: '剑起青云',
      genre: '仙侠',
      synopsis: '弃徒重返九霄',
      targetChapterWords: 1_500,
    },
    outline: {
      mainPlot: '沈砚被逐出青云宗后重返剑道巅峰。',
      worldSetting: '九霄大陆，宗门林立，剑修与器修相争。',
      styleGuide: '冷峻克制，多用短句，禁忌：不得出现现代名词。',
      endingPlan: '终章于剑冢对决大师兄。',
    },
    cards: CARDS,
    recentSummaries: [
      { chapterTitle: '楔子', summary: '剑冢异动的起源。', keyEvents: ['剑冢开裂'] },
      {
        chapterTitle: '序章 入山',
        summary: '沈砚被收入外门。',
        keyEvents: ['拜入外门', '结识同门'],
      },
      { chapterTitle: '第1章 雨夜', summary: '雨夜夺剑，沈砚重伤。', keyEvents: ['雨夜夺剑'] },
      { chapterTitle: '第2章 断剑', summary: '断剑认主，长老震怒。', keyEvents: ['断剑认主'] },
    ],
    prevChapter: {
      title: '第2章 断剑',
      contentText: '他握紧剑柄。'.repeat(200),
    },
    chapter: {
      title: '第3章 青石镇伏击',
      contentText: '沈砚缓缓抬头。'.repeat(120),
      outline: '沈砚在青石镇遭遇伏击，断剑初鸣。',
    },
    options: {
      action: 'continue',
      instruction: '让伏击者露出真容',
      selectedText: '沈砚缓缓抬头。',
      cardIds: [SELECTED_CARD_ID],
      ...overrides,
    },
  };
}

describe('assembleChapterContext 完整组装', () => {
  it('按固定顺序组装六个分段且不触发裁剪', () => {
    const assembled = assembleChapterContext(buildInput());

    expect(assembled.sections.map((section) => section.key)).toEqual([
      'book-outline',
      'knowledge-cards',
      'recent-summaries',
      'prev-chapter-tail',
      'current-chapter',
      'instruction',
    ]);
    expect(assembled.sections.map((section) => section.label)).toEqual([
      '全书总大纲与世界观',
      '设定卡记忆',
      '前序章节摘要',
      '上一章尾部衔接',
      '当前章节细纲与正文',
      '本轮写作任务与指令',
    ]);

    expect(assembled.truncated).toBe(false);
    expect(assembled.sections.every((section) => section.truncated === false)).toBe(true);
    expect(assembled.maxContextTokens).toBe(8_000);
    expect(assembled.estimatedTokens).toBeLessThanOrEqual(assembled.maxContextTokens);
    expect(assembled.recentSummariesCount).toBe(3);
    expect(assembled.prevChapterTitle).toBe('第2章 断剑');

    expect(assembled.systemPrompt).toContain('剑起青云');
    expect(assembled.systemPrompt).toContain('续写');
    expect(assembled.systemPrompt).toContain('不得出现现代名词');
    expect(assembled.userPrompt).toContain('让伏击者露出真容');
    expect(assembled.userPrompt).not.toContain('楔子');
  });

  it('按「手动勾选 > 常驻置顶 > 智能召回」纳入设定卡', () => {
    const assembled = assembleChapterContext(buildInput());

    expect(assembled.selectedCards.map((card) => card.id)).toEqual([
      SELECTED_CARD_ID,
      PINNED_CARD_ID,
      RECALLED_CARD_ID,
    ]);
    expect(assembled.selectedCards.map((card) => card.reason)).toEqual([
      'selected',
      'pinned',
      'recalled',
    ]);
    expect(assembled.selectedCards.every((card) => card.estimatedTokens > 0)).toBe(true);
    expect(assembled.selectedCards[2]?.score).toBeGreaterThan(0);
  });

  it('每个分段与整体预览均通过共享 Zod 契约校验', () => {
    const assembled = assembleChapterContext(buildInput());

    for (const section of assembled.sections) {
      expect(() => aiContextSectionPreviewSchema.parse(section)).not.toThrow();
    }

    const preview = aiContextPreviewResponseSchema.parse({
      estimatedTokens: assembled.estimatedTokens,
      maxContextTokens: assembled.maxContextTokens,
      truncated: assembled.truncated,
      sections: [...assembled.sections],
      selectedCards: [...assembled.selectedCards],
      recentSummariesCount: assembled.recentSummariesCount,
      prevChapterTitle: assembled.prevChapterTitle,
      systemPromptPreview: assembled.systemPrompt,
      userPromptPreview: assembled.userPrompt,
    });

    expect(preview.sections).toHaveLength(assembled.sections.length);
    expect(preview.systemPromptPreview).toBe(assembled.systemPrompt);
    expect(preview.userPromptPreview).toBe(assembled.userPrompt);
  });

  it('当前章分段包含本章细纲与编辑器选区', () => {
    const assembled = assembleChapterContext(buildInput());
    const currentSection = assembled.sections.find((section) => section.key === 'current-chapter');

    expect(currentSection?.preview).toContain('青石镇遭遇伏击');
    expect(currentSection?.preview).toContain('沈砚缓缓抬头。');
  });
});

describe('assembleChapterContext 预算裁剪', () => {
  it('刚超预算时优先把设定卡正文降级为仅摘要', () => {
    const full = assembleChapterContext(buildInput());
    const tightened = assembleChapterContext(
      buildInput({ maxContextTokens: full.estimatedTokens - 1 }),
    );

    expect(tightened.truncated).toBe(true);
    expect(tightened.estimatedTokens).toBeLessThan(full.estimatedTokens);

    const sectionTruncation = new Map(
      tightened.sections.map((section) => [section.key, section.truncated]),
    );
    expect(sectionTruncation.get('knowledge-cards')).toBe(true);
    expect(sectionTruncation.get('recent-summaries')).toBe(false);
    expect(sectionTruncation.get('prev-chapter-tail')).toBe(false);
    expect(sectionTruncation.get('current-chapter')).toBe(false);
    expect(sectionTruncation.get('book-outline')).toBe(false);
    expect(tightened.recentSummariesCount).toBe(full.recentSummariesCount);
  });

  it('预算极小时继续裁剪摘要、上一章尾部与当前正文并保留勾选卡', () => {
    const assembled = assembleChapterContext(buildInput({ maxContextTokens: 500 }));

    expect(assembled.truncated).toBe(true);
    expect(assembled.recentSummariesCount).toBe(0);
    expect(assembled.sections.map((section) => section.key)).toContain('current-chapter');
    expect(assembled.sections.map((section) => section.key)).toContain('instruction');

    // 手动勾选的卡片始终保留（最高优先级），常驻与自动召回卡可被裁掉
    expect(assembled.selectedCards.map((card) => card.id)).toContain(SELECTED_CARD_ID);
    expect(
      assembled.selectedCards.every((card) => card.reason === 'selected'),
    ).toBe(true);

    const summariesSection = assembled.sections.find((section) => section.key === 'recent-summaries');
    expect(summariesSection).toBeUndefined();
  });

  it('预算充足时不做任何裁剪', () => {
    const assembled = assembleChapterContext(buildInput({ maxContextTokens: 100_000 }));
    expect(assembled.truncated).toBe(false);
    expect(assembled.recentSummariesCount).toBe(3);
  });
});

describe('assembleChapterContext 开关与条数', () => {
  it('关闭总大纲后不再包含对应分段', () => {
    const assembled = assembleChapterContext(buildInput({ includeOutline: false }));
    expect(assembled.sections.some((section) => section.key === 'book-outline')).toBe(false);
  });

  it('关闭上一章尾部衔接口后不再包含对应分段', () => {
    const assembled = assembleChapterContext(buildInput({ includePrevChapterTail: false }));
    expect(assembled.sections.some((section) => section.key === 'prev-chapter-tail')).toBe(false);
    expect(assembled.prevChapterTitle).toBe('第2章 断剑');
  });

  it('maxRecentSummaries = 0 时不纳入任何前情摘要', () => {
    const assembled = assembleChapterContext(buildInput({ maxRecentSummaries: 0 }));
    expect(assembled.recentSummariesCount).toBe(0);
    expect(assembled.sections.some((section) => section.key === 'recent-summaries')).toBe(false);
  });

  it('maxRecentSummaries 只保留最近 N 条（从旧到新排列）', () => {
    const assembled = assembleChapterContext(buildInput({ maxRecentSummaries: 2 }));
    const summariesSection = assembled.sections.find((section) => section.key === 'recent-summaries');

    expect(assembled.recentSummariesCount).toBe(2);
    expect(summariesSection?.preview).toContain('第1章 雨夜');
    expect(summariesSection?.preview).toContain('第2章 断剑');
    expect(summariesSection?.preview).not.toContain('序章 入山');
  });
});
