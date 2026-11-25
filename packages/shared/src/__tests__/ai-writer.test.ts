import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_RECENT_SUMMARIES_COUNT,
  MAX_MAX_CONTEXT_TOKENS,
  MAX_RECENT_SUMMARIES_COUNT,
  MIN_MAX_CONTEXT_TOKENS,
  aiChapterStreamRequestSchema,
  aiContextPreviewRequestSchema,
  aiContextPreviewResponseSchema,
  aiStreamDeltaEventSchema,
  aiStreamDoneEventSchema,
  aiStreamErrorEventSchema,
  aiStreamStartEventSchema,
  applyAiChapterContentResponseSchema,
  applyAiChapterContentSchema,
} from '../index.js';

const RUN_ID = '77777777-7777-4777-8777-777777777777';
const CHAPTER_ID = '44444444-4444-4444-8444-444444444444';
const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const CARD_ID = '33333333-3333-4333-8333-333333333333';
const VOLUME_ID = '22222222-2222-4222-8222-222222222222';
const REVISION_ID = '88888888-8888-4888-8888-888888888888';
const USAGE_LOG_ID = '99999999-9999-4999-8999-999999999999';
const CREATED_AT = '2026-02-01T10:00:00.000Z';
const UPDATED_AT = '2026-02-02T11:30:00.000Z';

/** 合法章节详情 DTO 夹具（与 `chapter.test.ts` 保持一致）。 */
function chapterDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: CHAPTER_ID,
    bookId: BOOK_ID,
    volumeId: VOLUME_ID,
    title: '第一章 风起',
    sortOrder: 0,
    status: 'draft',
    contentText: '少年负剑出山。',
    contentJson: { type: 'doc', content: [] },
    wordCount: 7,
    version: 4,
    deletedAt: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function revisionSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: REVISION_ID,
    chapterId: CHAPTER_ID,
    version: 4,
    source: 'ai',
    note: 'AI 应用前留底',
    titleSnapshot: '第一章 风起',
    wordCount: 7,
    createdAt: UPDATED_AT,
    ...overrides,
  };
}

describe('aiContextPreviewRequestSchema', () => {
  it('仅需 action，其余上下文选项填充默认值', () => {
    const parsed = aiContextPreviewRequestSchema.parse({ action: 'continue' });
    expect(parsed).toEqual({
      action: 'continue',
      instruction: '',
      selectedText: undefined,
      currentContentText: undefined,
      cardIds: undefined,
      includeOutline: true,
      includePrevChapterTail: true,
      maxRecentSummaries: DEFAULT_RECENT_SUMMARIES_COUNT,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      targetWords: undefined,
    });
  });

  it('接受完整的上下文选项', () => {
    const parsed = aiContextPreviewRequestSchema.parse({
      action: 'rewrite',
      instruction: '  更冷峻一些  ',
      selectedText: '他抬头望去。',
      currentContentText: '当前未保存正文',
      cardIds: [CARD_ID],
      includeOutline: false,
      includePrevChapterTail: false,
      maxRecentSummaries: 0,
      maxContextTokens: MIN_MAX_CONTEXT_TOKENS,
      targetWords: 1_500,
    });
    expect(parsed.instruction).toBe('更冷峻一些');
    expect(parsed.cardIds).toEqual([CARD_ID]);
    expect(parsed.maxRecentSummaries).toBe(0);
    expect(parsed.maxContextTokens).toBe(MIN_MAX_CONTEXT_TOKENS);
    expect(parsed.targetWords).toBe(1_500);
  });

  it('拒绝未知字段（strictObject）', () => {
    expect(
      aiContextPreviewRequestSchema.safeParse({ action: 'continue', chapterId: CHAPTER_ID }).success,
    ).toBe(false);
  });

  it('拒绝非法动作 / 超预算 / 越界摘要条数 / 越界目标字数 / 非法卡片 ID', () => {
    expect(aiContextPreviewRequestSchema.safeParse({ action: 'summarize' }).success).toBe(false);
    expect(aiContextPreviewRequestSchema.safeParse({}).success).toBe(false);
    expect(
      aiContextPreviewRequestSchema.safeParse({ action: 'continue', maxContextTokens: MIN_MAX_CONTEXT_TOKENS - 1 })
        .success,
    ).toBe(false);
    expect(
      aiContextPreviewRequestSchema.safeParse({ action: 'continue', maxContextTokens: MAX_MAX_CONTEXT_TOKENS + 1 })
        .success,
    ).toBe(false);
    expect(
      aiContextPreviewRequestSchema.safeParse({
        action: 'continue',
        maxRecentSummaries: MAX_RECENT_SUMMARIES_COUNT + 1,
      }).success,
    ).toBe(false);
    expect(
      aiContextPreviewRequestSchema.safeParse({ action: 'continue', targetWords: 99 }).success,
    ).toBe(false);
    expect(
      aiContextPreviewRequestSchema.safeParse({ action: 'continue', targetWords: 10_001 }).success,
    ).toBe(false);
    expect(
      aiContextPreviewRequestSchema.safeParse({ action: 'continue', cardIds: ['not-a-uuid'] }).success,
    ).toBe(false);
    expect(
      aiContextPreviewRequestSchema.safeParse({
        action: 'continue',
        instruction: 'x'.repeat(4_001),
      }).success,
    ).toBe(false);
  });

  it('拒绝超过 50 张手动勾选卡片', () => {
    const cardIds = Array.from(
      { length: 51 },
      (_, index) => `3333333${index.toString().padStart(1, '0')}-3333-4333-8333-333333333333`,
    );
    expect(aiContextPreviewRequestSchema.safeParse({ action: 'continue', cardIds }).success).toBe(false);
  });
});

describe('aiContextPreviewResponseSchema', () => {
  it('接受完整的上下文预览响应', () => {
    const parsed = aiContextPreviewResponseSchema.parse({
      estimatedTokens: 3_200,
      maxContextTokens: 8_000,
      truncated: false,
      sections: [
        {
          key: 'book-outline',
          label: '全书总大纲',
          estimatedTokens: 900,
          truncated: false,
          preview: '主线：少年复仇。',
        },
      ],
      selectedCards: [
        {
          id: CARD_ID,
          title: '萧炎',
          category: 'character',
          reason: 'selected',
          score: 0,
          estimatedTokens: 210,
        },
      ],
      recentSummariesCount: 3,
      prevChapterTitle: '序章 山雨',
      systemPromptPreview: '你是资深网文写手。',
      userPromptPreview: '请续写以下内容……',
    });
    expect(parsed.truncated).toBe(false);
    expect(parsed.selectedCards[0]?.reason).toBe('selected');
    expect(parsed.prevChapterTitle).toBe('序章 山雨');
  });

  it('允许无上一章（prevChapterTitle 为 null）', () => {
    const parsed = aiContextPreviewResponseSchema.parse({
      estimatedTokens: 0,
      maxContextTokens: 8_000,
      truncated: true,
      sections: [],
      selectedCards: [],
      recentSummariesCount: 0,
      prevChapterTitle: null,
      systemPromptPreview: '',
      userPromptPreview: '',
    });
    expect(parsed.prevChapterTitle).toBeNull();
  });

  it('拒绝非法召回原因 / 负 Token / 未知字段', () => {
    const base = {
      estimatedTokens: 0,
      maxContextTokens: 8_000,
      truncated: false,
      sections: [],
      selectedCards: [
        { id: CARD_ID, title: '萧炎', category: 'character', reason: 'selected', score: 0, estimatedTokens: 0 },
      ],
      recentSummariesCount: 0,
      prevChapterTitle: null,
      systemPromptPreview: '',
      userPromptPreview: '',
    };
    expect(aiContextPreviewResponseSchema.safeParse(base).success).toBe(true);
    expect(
      aiContextPreviewResponseSchema.safeParse({
        ...base,
        selectedCards: [{ ...base.selectedCards[0], reason: 'random' }],
      }).success,
    ).toBe(false);
    expect(
      aiContextPreviewResponseSchema.safeParse({
        ...base,
        selectedCards: [{ ...base.selectedCards[0], score: -1 }],
      }).success,
    ).toBe(false);
    expect(aiContextPreviewResponseSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe('aiChapterStreamRequestSchema', () => {
  it('默认角色为 writer，并继承上下文选项默认值', () => {
    const parsed = aiChapterStreamRequestSchema.parse({ action: 'continue' });
    expect(parsed.role).toBe('writer');
    expect(parsed.instruction).toBe('');
    expect(parsed.maxContextTokens).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
    expect(parsed.maxRecentSummaries).toBe(DEFAULT_RECENT_SUMMARIES_COUNT);
    expect(parsed.includeOutline).toBe(true);
  });

  it('接受显式角色与生成参数', () => {
    const parsed = aiChapterStreamRequestSchema.parse({
      action: 'expand',
      role: 'lorekeeper',
      selectedText: '他抬头望去。',
      temperature: 0.8,
      maxOutputTokens: 4_096,
    });
    expect(parsed.role).toBe('lorekeeper');
    expect(parsed.temperature).toBe(0.8);
    expect(parsed.maxOutputTokens).toBe(4_096);
  });

  it('拒绝非法角色 / 越界温度 / 越界输出 Token / 未知字段', () => {
    expect(aiChapterStreamRequestSchema.safeParse({ action: 'continue', role: 'admin' }).success).toBe(false);
    expect(
      aiChapterStreamRequestSchema.safeParse({ action: 'continue', temperature: 2.1 }).success,
    ).toBe(false);
    expect(
      aiChapterStreamRequestSchema.safeParse({ action: 'continue', maxOutputTokens: 63 }).success,
    ).toBe(false);
    expect(
      aiChapterStreamRequestSchema.safeParse({ action: 'continue', maxOutputTokens: 32_001 }).success,
    ).toBe(false);
    expect(
      aiChapterStreamRequestSchema.safeParse({ action: 'continue', apiKey: 'sk-xxx' }).success,
    ).toBe(false);
  });
});

describe('AI 写作 SSE 帧', () => {
  it('start 帧包含模型、预算与召回卡片清单', () => {
    const start = {
      runId: RUN_ID,
      chapterId: CHAPTER_ID,
      action: 'continue',
      role: 'writer',
      modelRef: 'openai/gpt-4o',
      estimatedContextTokens: 3_200,
      truncated: false,
      includedCardIds: [CARD_ID],
    };
    expect(aiStreamStartEventSchema.parse(start)).toEqual(start);
    expect(aiStreamStartEventSchema.safeParse({ ...start, extra: 1 }).success).toBe(false);
    expect(aiStreamStartEventSchema.safeParse({ ...start, action: 'summarize' }).success).toBe(false);
    expect(aiStreamStartEventSchema.safeParse({ ...start, estimatedContextTokens: -1 }).success).toBe(false);
    expect(aiStreamStartEventSchema.safeParse({ ...start, role: 'admin' }).success).toBe(false);
  });

  it('delta 帧允许空增量文本，并拒绝未知字段', () => {
    expect(aiStreamDeltaEventSchema.parse({ runId: RUN_ID, text: '' }).text).toBe('');
    expect(aiStreamDeltaEventSchema.parse({ runId: RUN_ID, text: '少年负剑' }).text).toBe('少年负剑');
    expect(aiStreamDeltaEventSchema.safeParse({ runId: RUN_ID, text: 'x', index: 1 }).success).toBe(false);
    expect(aiStreamDeltaEventSchema.safeParse({ runId: 'bad', text: 'x' }).success).toBe(false);
  });

  it('done 帧含用量、耗时与 usageLogId（可为 null）', () => {
    const done = {
      runId: RUN_ID,
      fullText: '少年负剑出山。',
      finishReason: 'stop',
      inputTokens: 3_200,
      outputTokens: 480,
      estimatedCostUsd: 0.0012,
      latencyMs: 2_100,
      modelRef: 'openai/gpt-4o',
      usageLogId: USAGE_LOG_ID,
    };
    expect(aiStreamDoneEventSchema.parse(done)).toEqual(done);
    expect(aiStreamDoneEventSchema.safeParse({ ...done, usageLogId: null }).success).toBe(true);
    expect(aiStreamDoneEventSchema.safeParse({ ...done, outputTokens: -1 }).success).toBe(false);
    expect(aiStreamDoneEventSchema.safeParse({ ...done, finishReason: '' }).success).toBe(false);
    expect(aiStreamDoneEventSchema.safeParse({ ...done, extra: true }).success).toBe(false);
  });

  it('error 帧必须是已知错误码且 message 非空', () => {
    const err = { runId: RUN_ID, code: 'UPSTREAM_TIMEOUT', message: '上游请求超时，请稍后重试' };
    expect(aiStreamErrorEventSchema.parse(err)).toEqual(err);
    expect(aiStreamErrorEventSchema.safeParse({ ...err, code: 'UNKNOWN_CODE' }).success).toBe(false);
    expect(aiStreamErrorEventSchema.safeParse({ ...err, message: '' }).success).toBe(false);
    expect(aiStreamErrorEventSchema.safeParse({ ...err, message: 'x'.repeat(2001) }).success).toBe(false);
    expect(aiStreamErrorEventSchema.safeParse({ ...err, stack: 'trace' }).success).toBe(false);
  });
});

describe('applyAiChapterContentSchema', () => {
  it('接受三种应用模式与可选备注', () => {
    for (const mode of ['append', 'replace_all', 'replace_selection'] as const) {
      const parsed = applyAiChapterContentSchema.parse({
        expectedVersion: 4,
        action: 'rewrite',
        mode,
        contentText: '少年负剑出山。',
        contentJson: { type: 'doc', content: [] },
        note: '  应用 AI 改写  ',
      });
      expect(parsed.mode).toBe(mode);
      expect(parsed.note).toBe('应用 AI 改写');
    }
  });

  it('接受省略 contentJson / note 的最小请求', () => {
    const parsed = applyAiChapterContentSchema.parse({
      expectedVersion: 1,
      action: 'continue',
      mode: 'append',
      contentText: '',
    });
    expect(parsed.contentJson).toBeUndefined();
    expect(parsed.note).toBeUndefined();
  });

  it('拒绝非法模式 / 非正版本号 / 超长备注 / 未知字段', () => {
    const base = {
      expectedVersion: 1,
      action: 'continue',
      mode: 'append',
      contentText: '正文',
    };
    expect(applyAiChapterContentSchema.safeParse({ ...base, mode: 'merge' }).success).toBe(false);
    expect(applyAiChapterContentSchema.safeParse({ ...base, expectedVersion: 0 }).success).toBe(false);
    expect(applyAiChapterContentSchema.safeParse({ ...base, note: 'x'.repeat(201) }).success).toBe(false);
    expect(applyAiChapterContentSchema.safeParse({ ...base, forceOverwrite: true }).success).toBe(false);
    expect(applyAiChapterContentSchema.safeParse({ ...base, action: 'summarize' }).success).toBe(false);
  });
});

describe('applyAiChapterContentResponseSchema', () => {
  it('接受章节详情与 AI 留底快照', () => {
    const parsed = applyAiChapterContentResponseSchema.parse({
      chapter: chapterDetail({ version: 5 }),
      backupRevision: revisionSummary(),
    });
    expect(parsed.chapter.version).toBe(5);
    expect(parsed.backupRevision.source).toBe('ai');
  });

  it('拒绝缺少 backupRevision 或含未知字段的响应', () => {
    expect(
      applyAiChapterContentResponseSchema.safeParse({ chapter: chapterDetail() }).success,
    ).toBe(false);
    expect(
      applyAiChapterContentResponseSchema.safeParse({
        chapter: chapterDetail(),
        backupRevision: revisionSummary(),
        truncated: false,
      }).success,
    ).toBe(false);
  });
});
