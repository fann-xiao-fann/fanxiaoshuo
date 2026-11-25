import type {
  AiStreamDoneEvent,
  AiStreamStartEvent,
  AiUsageSummary,
  BookOutlineDto,
  ChapterDetailDto,
  ChapterSummaryDto,
  KnowledgeCardDto,
} from '@fanxiaoshuo/shared';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/book-bible', () => ({
  getOutline: vi.fn(),
  saveOutline: vi.fn(),
  listCards: vi.fn(),
  createCard: vi.fn(),
  getCard: vi.fn(),
  updateCard: vi.fn(),
  deleteCard: vi.fn(),
  getChapterSummary: vi.fn(),
  saveChapterSummary: vi.fn(),
  extractChapterSummary: vi.fn(),
  previewContext: vi.fn(),
  applyAiContent: vi.fn(),
  streamChapterAi: vi.fn(),
}));

vi.mock('@/api/books', () => ({
  booksApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    purge: vi.fn(),
    restore: vi.fn(),
    tree: vi.fn(),
    trash: vi.fn(),
    exportUrl: vi.fn(),
    exportFile: vi.fn(),
  },
  volumesApi: {
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    restore: vi.fn(),
    reorder: vi.fn(),
  },
  chaptersApi: {
    create: vi.fn(),
    updateMeta: vi.fn(),
    remove: vi.fn(),
    restore: vi.fn(),
    reorder: vi.fn(),
    get: vi.fn(),
    saveContent: vi.fn(),
    listRevisions: vi.fn(),
    getRevision: vi.fn(),
    createRevision: vi.fn(),
    restoreRevision: vi.fn(),
  },
  downloadBookExport: vi.fn(),
}));

import * as bibleApi from '@/api/book-bible';
import { booksApi } from '@/api/books';
import { ApiClientError } from '@/api/errors';
import { useBookBibleStore } from '@/stores/book-bible';
import { useBookWorkspaceStore } from '@/stores/book-workspace';

const NOW = '2024-05-01T10:00:00.000Z';
const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const CHAPTER_ID = '22222222-2222-4222-8222-222222222222';
const CARD_ID = '44444444-4444-4444-8444-444444444444';
const CARD_ID_2 = '44444444-4444-4444-8444-444444444445';
const RUN_ID = '55555555-5555-4555-8555-555555555555';

const getOutlineMock = vi.mocked(bibleApi.getOutline);
const saveOutlineMock = vi.mocked(bibleApi.saveOutline);
const listCardsMock = vi.mocked(bibleApi.listCards);
const createCardMock = vi.mocked(bibleApi.createCard);
const updateCardMock = vi.mocked(bibleApi.updateCard);
const deleteCardMock = vi.mocked(bibleApi.deleteCard);
const getSummaryMock = vi.mocked(bibleApi.getChapterSummary);
const saveSummaryMock = vi.mocked(bibleApi.saveChapterSummary);
const extractSummaryMock = vi.mocked(bibleApi.extractChapterSummary);
const applyMock = vi.mocked(bibleApi.applyAiContent);
const streamMock = vi.mocked(bibleApi.streamChapterAi);
const treeMock = vi.mocked(booksApi.tree);

function makeOutline(overrides: Partial<BookOutlineDto> = {}): BookOutlineDto {
  return {
    bookId: BOOK_ID,
    mainPlot: '守夜人追查灯河旧案',
    worldSetting: '灯河横贯九州',
    styleGuide: '第三人称限知',
    endingPlan: '灯河熄灭，守夜人归乡',
    updatedAt: NOW,
    ...overrides,
  };
}

function makeCard(overrides: Partial<KnowledgeCardDto> = {}): KnowledgeCardDto {
  return {
    id: CARD_ID,
    bookId: BOOK_ID,
    category: 'character',
    title: '沈照夜',
    summary: '守夜人少主',
    content: '背负旧案',
    aliases: ['夜哥'],
    tags: ['主角'],
    pinned: true,
    sortOrder: 0,
    hasEmbedding: false,
    embeddingModelRef: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<ChapterSummaryDto> = {}): ChapterSummaryDto {
  return {
    chapterId: CHAPTER_ID,
    bookId: BOOK_ID,
    outline: '雨夜追凶',
    summary: '沈照夜在雨夜追上黑衣人',
    keyEvents: ['黑衣人现身'],
    charactersPresent: ['沈照夜'],
    source: 'manual',
    updatedAt: NOW,
    ...overrides,
  };
}

function makeUsage(overrides: Partial<AiUsageSummary> = {}): AiUsageSummary {
  return {
    inputTokens: 1200,
    outputTokens: 800,
    estimatedCostUsd: 0.0012,
    latencyMs: 2400,
    ...overrides,
  };
}

function makeStart(overrides: Partial<AiStreamStartEvent> = {}): AiStreamStartEvent {
  return {
    runId: RUN_ID,
    chapterId: CHAPTER_ID,
    action: 'continue',
    role: 'writer',
    modelRef: 'openai/gpt-4o-mini',
    estimatedContextTokens: 4200,
    truncated: false,
    includedCardIds: [CARD_ID],
    ...overrides,
  };
}

function makeDone(overrides: Partial<AiStreamDoneEvent> = {}): AiStreamDoneEvent {
  return {
    runId: RUN_ID,
    fullText: '雨夜追凶',
    finishReason: 'stop',
    inputTokens: 1200,
    outputTokens: 800,
    estimatedCostUsd: 0.0012,
    latencyMs: 2400,
    modelRef: 'openai/gpt-4o-mini',
    usageLogId: '66666666-6666-4666-8666-666666666666',
    ...overrides,
  };
}

function makeChapterDetail(overrides: Partial<ChapterDetailDto> = {}): ChapterDetailDto {
  return {
    id: CHAPTER_ID,
    bookId: BOOK_ID,
    volumeId: null,
    title: '第一章 雨夜',
    sortOrder: 0,
    status: 'draft',
    contentText: '旧正文',
    contentJson: null,
    wordCount: 3,
    version: 2,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

afterEach(() => {
  useBookBibleStore().reset();
  useBookWorkspaceStore().cancelAutoSave();
});

describe('useBookBibleStore · 总大纲', () => {
  it('加载并保存全书总大纲', async () => {
    getOutlineMock.mockResolvedValue(makeOutline());
    const store = useBookBibleStore();

    await store.loadOutline(BOOK_ID);

    expect(store.outline?.mainPlot).toBe('守夜人追查灯河旧案');
    expect(store.outlineLoading).toBe(false);

    saveOutlineMock.mockResolvedValue(makeOutline({ mainPlot: '新的主线' }));
    const saved = await store.saveOutline(BOOK_ID, {
      mainPlot: '新的主线',
      worldSetting: '',
      styleGuide: '',
      endingPlan: '',
    });

    expect(saved?.mainPlot).toBe('新的主线');
    expect(store.outline?.mainPlot).toBe('新的主线');
    expect(store.outlineSaving).toBe(false);
  });

  it('加载失败写入 outlineError 且不抛出', async () => {
    getOutlineMock.mockRejectedValue(new ApiClientError('书籍不存在', { code: 'NOT_FOUND', status: 404 }));
    const store = useBookBibleStore();

    await store.loadOutline(BOOK_ID);

    expect(store.outlineError).toBe('书籍不存在');
    expect(store.outlineLoading).toBe(false);
  });
});

describe('useBookBibleStore · 设定卡', () => {
  it('按分类 / 关键字 / 常驻状态加载设定卡', async () => {
    listCardsMock.mockResolvedValue({ items: [makeCard()], total: 1 });
    const store = useBookBibleStore();
    store.categoryFilter = 'character';
    store.searchQuery = '  沈照夜  ';
    store.pinnedOnly = true;

    await store.loadCards(BOOK_ID);

    expect(listCardsMock).toHaveBeenCalledWith(BOOK_ID, {
      category: 'character',
      q: '沈照夜',
      pinned: true,
    });
    expect(store.cards).toHaveLength(1);
    expect(store.cardsBookId).toBe(BOOK_ID);
  });

  it('创建、置顶切换、更新与删除设定卡', async () => {
    createCardMock.mockResolvedValue(makeCard({ id: CARD_ID_2, title: '灯河' }));
    const store = useBookBibleStore();

    await store.createCard(BOOK_ID, { category: 'world', title: '灯河' });
    expect(store.cards.map((card) => card.id)).toContain(CARD_ID_2);

    updateCardMock.mockResolvedValue(makeCard({ id: CARD_ID_2, title: '灯河', pinned: false }));
    await store.updateCard(BOOK_ID, CARD_ID_2, { pinned: false });
    expect(store.cards.find((card) => card.id === CARD_ID_2)?.pinned).toBe(false);

    deleteCardMock.mockResolvedValue(undefined);
    store.selectedCardIds = [CARD_ID_2];
    await store.deleteCard(BOOK_ID, CARD_ID_2);
    expect(store.cards.some((card) => card.id === CARD_ID_2)).toBe(false);
    expect(store.selectedCardIds).not.toContain(CARD_ID_2);
  });

  it('仅看常驻模式下取消置顶会从列表移除', async () => {
    listCardsMock.mockResolvedValue({ items: [makeCard()], total: 1 });
    const store = useBookBibleStore();
    store.pinnedOnly = true;
    await store.loadCards(BOOK_ID);

    updateCardMock.mockResolvedValue(makeCard({ pinned: false }));
    await store.toggleCardPinned(BOOK_ID, CARD_ID);

    expect(updateCardMock).toHaveBeenCalledWith(BOOK_ID, CARD_ID, { pinned: false });
    expect(store.cards).toHaveLength(0);
  });

  it('手动勾选与清除设定卡', () => {
    const store = useBookBibleStore();
    store.toggleSelectedCard(CARD_ID);
    store.toggleSelectedCard(CARD_ID_2);
    expect(store.selectedCardIds).toEqual([CARD_ID, CARD_ID_2]);
    store.toggleSelectedCard(CARD_ID);
    expect(store.selectedCardIds).toEqual([CARD_ID_2]);
    store.clearSelectedCards();
    expect(store.selectedCardIds).toEqual([]);
  });
});

describe('useBookBibleStore · 本章记忆', () => {
  it('加载并手工保存本章摘要', async () => {
    getSummaryMock.mockResolvedValue(makeSummary());
    const store = useBookBibleStore();
    await store.loadChapterSummary(CHAPTER_ID);
    expect(store.chapterSummary?.summary).toBe('沈照夜在雨夜追上黑衣人');

    saveSummaryMock.mockResolvedValue(makeSummary({ summary: '新摘要' }));
    const saved = await store.saveChapterSummary(CHAPTER_ID, { summary: '新摘要' });
    expect(saved?.summary).toBe('新摘要');
    expect(store.summarySaving).toBe(false);
  });

  it('AI 提炼成功写入摘要与用量', async () => {
    extractSummaryMock.mockResolvedValue({
      summary: makeSummary({ source: 'ai' }),
      usage: makeUsage(),
      modelRef: 'openai/gpt-4o-mini',
      usageLogId: null,
    });
    const store = useBookBibleStore();

    const usage = await store.extractChapterSummary(CHAPTER_ID, { save: true });

    expect(usage?.inputTokens).toBe(1200);
    expect(store.chapterSummary?.source).toBe('ai');
    expect(store.lastExtractUsage?.outputTokens).toBe(800);
    expect(store.summaryExtracting).toBe(false);
  });

  it('角色未绑定时保留错误码供面板引导', async () => {
    extractSummaryMock.mockRejectedValue(
      new ApiClientError('执笔写手未绑定', { code: 'AGENT_ROLE_UNBOUND', status: 409 }),
    );
    const store = useBookBibleStore();

    const usage = await store.extractChapterSummary(CHAPTER_ID, { save: true });

    expect(usage).toBeNull();
    expect(store.summaryErrorCode).toBe('AGENT_ROLE_UNBOUND');
    expect(store.summaryError).toBe('执笔写手未绑定');
  });
});

describe('useBookBibleStore · 流式生成', () => {
  it('逐帧累加增量并记录 start / done', async () => {
    streamMock.mockImplementation(async (_chapterId, _payload, callbacks) => {
      callbacks?.onStart?.(makeStart());
      callbacks?.onDelta?.({ runId: RUN_ID, text: '雨夜' });
      callbacks?.onDelta?.({ runId: RUN_ID, text: '追凶' });
      callbacks?.onDone?.(makeDone({ fullText: '雨夜追凶，灯河无声' }));
    });
    const store = useBookBibleStore();

    await store.startStream(CHAPTER_ID, { action: 'continue' });

    expect(store.streamStatus).toBe('done');
    expect(store.streamText).toBe('雨夜追凶，灯河无声');
    expect(store.streamStart?.modelRef).toBe('openai/gpt-4o-mini');
    expect(store.streamDone?.outputTokens).toBe(800);
    expect(store.streamAction).toBe('continue');
  });

  it('停止生成后保留已收到的预览文本', async () => {
    streamMock.mockImplementation(
      (_chapterId, _payload, callbacks, options) =>
        new Promise<void>((_resolve, reject) => {
          callbacks?.onStart?.(makeStart());
          callbacks?.onDelta?.({ runId: RUN_ID, text: '雨夜' });
          callbacks?.onDelta?.({ runId: RUN_ID, text: '追凶' });
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const store = useBookBibleStore();

    const pending = store.startStream(CHAPTER_ID, { action: 'continue' });
    expect(store.streamStatus).toBe('streaming');
    expect(store.streamText).toBe('雨夜追凶');

    store.stopStream();
    await pending;

    expect(store.streamStatus).toBe('aborted');
    expect(store.streamText).toBe('雨夜追凶');
  });

  it('非 2xx 角色未绑定错误保留错误码与信息', async () => {
    streamMock.mockRejectedValue(
      new ApiClientError('执笔写手未绑定可用模型', {
        code: 'AGENT_ROLE_UNBOUND',
        status: 409,
      }),
    );
    const store = useBookBibleStore();

    await store.startStream(CHAPTER_ID, { action: 'rewrite' });

    expect(store.streamStatus).toBe('error');
    expect(store.streamErrorCode).toBe('AGENT_ROLE_UNBOUND');
    expect(store.streamErrorMessage).toBe('执笔写手未绑定可用模型');
  });

  it('SSE error 帧写入错误码并停止累加', async () => {
    streamMock.mockImplementation(async (_chapterId, _payload, callbacks) => {
      callbacks?.onDelta?.({ runId: RUN_ID, text: '半句' });
      callbacks?.onError?.({
        runId: RUN_ID,
        code: 'UPSTREAM_TIMEOUT',
        message: '上游超时（密钥已脱敏）',
      });
    });
    const store = useBookBibleStore();

    await store.startStream(CHAPTER_ID, { action: 'expand' });

    expect(store.streamStatus).toBe('error');
    expect(store.streamErrorCode).toBe('UPSTREAM_TIMEOUT');
    expect(store.streamText).toBe('半句');
  });
});

describe('useBookBibleStore · 原子应用', () => {
  function prepareWorkspace(version = 2): ReturnType<typeof useBookWorkspaceStore> {
    const workspace = useBookWorkspaceStore();
    workspace.bookId = BOOK_ID;
    workspace.currentChapterId = CHAPTER_ID;
    workspace.currentChapter = makeChapterDetail({ version });
    workspace.isDirty = true;
    return workspace;
  }

  it('应用前自动冲刷脏草稿，并以最新版本号提交', async () => {
    const workspace = prepareWorkspace(2);
    vi.spyOn(workspace, 'saveContent').mockImplementation(async () => {
      workspace.currentChapter = makeChapterDetail({ version: 3 });
      workspace.isDirty = false;
      return true;
    });
    applyMock.mockResolvedValue({
      chapter: makeChapterDetail({ version: 4, contentText: '旧正文\n\n雨夜追凶' }),
      backupRevision: {
        id: '77777777-7777-4777-8777-777777777777',
        chapterId: CHAPTER_ID,
        version: 3,
        source: 'ai',
        note: '续写·追加到文末',
        titleSnapshot: '第一章 雨夜',
        wordCount: 8,
        createdAt: NOW,
      },
    });
    treeMock.mockResolvedValue({
      book: {
        id: BOOK_ID,
        title: '长夜灯河',
        authorPenName: '砚青',
        genre: '东方玄幻',
        status: 'ongoing',
        synopsis: '',
        targetChapterWords: 3000,
        volumeCount: 0,
        chapterCount: 1,
        totalWordCount: 8,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      volumes: [],
      ungroupedChapters: [
        {
          id: CHAPTER_ID,
          bookId: BOOK_ID,
          volumeId: null,
          title: '第一章 雨夜',
          sortOrder: 0,
          status: 'draft',
          wordCount: 8,
          version: 4,
          deletedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      trashCount: 0,
    });

    const store = useBookBibleStore();
    store.streamAction = 'continue';
    store.setSelection({ text: '旧正文', from: 1, to: 4 });

    const ok = await store.applyStreamResult({
      mode: 'append',
      contentText: '旧正文\n\n雨夜追凶',
    });

    expect(ok).toBe(true);
    expect(applyMock).toHaveBeenCalledWith(
      CHAPTER_ID,
      expect.objectContaining({
        expectedVersion: 3,
        action: 'continue',
        mode: 'append',
        contentText: '旧正文\n\n雨夜追凶',
      }),
    );
    expect(workspace.currentChapter?.version).toBe(4);
    expect(store.selection).toBeNull();
    expect(store.applying).toBe(false);
  });

  it('脏草稿冲刷失败则中止应用', async () => {
    const workspace = prepareWorkspace(2);
    vi.spyOn(workspace, 'saveContent').mockResolvedValue(false);
    workspace.saveError = '网络异常';
    const store = useBookBibleStore();

    const ok = await store.applyStreamResult({ mode: 'replace_all', contentText: '新正文' });

    expect(ok).toBe(false);
    expect(applyMock).not.toHaveBeenCalled();
    expect(store.applyError).toBe('网络异常');
  });

  it('409 版本冲突无缝转入既有冲突态', async () => {
    const workspace = prepareWorkspace(2);
    workspace.isDirty = false;
    applyMock.mockRejectedValue(
      new ApiClientError('章节版本过期', {
        code: 'CHAPTER_VERSION_CONFLICT',
        status: 409,
        details: [{ path: 'currentVersion', message: '7' }],
      }),
    );
    const store = useBookBibleStore();

    const ok = await store.applyStreamResult({ mode: 'replace_all', contentText: '新正文' });

    expect(ok).toBe(false);
    expect(workspace.saveStatus).toBe('conflict');
    expect(workspace.conflictCurrentVersion).toBe(7);
  });
});

describe('useBookBibleStore · 章节切换清理', () => {
  it('resetForChapter 清空摘要 / 预览 / 选区 / 流结果', async () => {
    const store = useBookBibleStore();
    getSummaryMock.mockResolvedValue(makeSummary());
    await store.loadChapterSummary(CHAPTER_ID);
    store.setSelection({ text: '旧正文', from: 1, to: 4 });
    store.streamText = '半句';
    store.streamStatus = 'aborted';

    store.resetForChapter();

    expect(store.chapterSummary).toBeNull();
    expect(store.selection).toBeNull();
    expect(store.contextPreview).toBeNull();
    expect(store.streamText).toBe('');
    expect(store.streamStatus).toBe('idle');
  });
});
