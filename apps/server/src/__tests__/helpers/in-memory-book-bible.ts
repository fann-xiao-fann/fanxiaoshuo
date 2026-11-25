import { randomUUID } from 'node:crypto';
import type {
  BookOutlineRepository,
  BookOutlineRecord,
  ChapterSummaryRecord,
  ChapterSummaryRepository,
  CreateKnowledgeCardRecordInput,
  KnowledgeCardListFilter,
  KnowledgeCardRecord,
  KnowledgeCardRepository,
  UpdateKnowledgeCardRecordPatch,
  UpsertBookOutlineRecordInput,
  UpsertChapterSummaryRecordInput,
} from '../../repositories/types.js';

/**
 * Book Bible 三仓储的内存实现（测试专用，与 Drizzle 实现语义逐条对齐）：
 * - 总大纲 / 章节摘要为 1:1 覆盖写入（upsert）；
 * - 设定卡 `q` 在标题 / 别名 / 摘要 / 正文上做大小写不敏感模糊匹配；
 * - 列表排序：`pinned` 优先，其次 `sortOrder` 升序、`createdAt` 升序。
 */

export interface InMemoryBookBibleState {
  readonly outlines: Map<string, BookOutlineRecord>;
  readonly cards: Map<string, KnowledgeCardRecord>;
  readonly summaries: Map<string, ChapterSummaryRecord>;
}

export interface InMemoryBookBibleRepositories {
  readonly bookOutlines: BookOutlineRepository;
  readonly knowledgeCards: KnowledgeCardRepository;
  readonly chapterSummaries: ChapterSummaryRepository;
  readonly state: InMemoryBookBibleState;
}

function compareCards(a: KnowledgeCardRecord, b: KnowledgeCardRecord): number {
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }
  return a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime();
}

export function createInMemoryBookBibleRepositories(options: {
  now: () => Date;
}): InMemoryBookBibleRepositories {
  const now = options.now;

  const outlineMap = new Map<string, BookOutlineRecord>();
  const cardMap = new Map<string, KnowledgeCardRecord>();
  const summaryMap = new Map<string, ChapterSummaryRecord>();

  function nextCardSortOrder(bookId: string): number {
    const orders = [...cardMap.values()]
      .filter((card) => card.bookId === bookId)
      .map((card) => card.sortOrder);
    return orders.length === 0 ? 0 : Math.max(...orders) + 1;
  }

  function matchesKeyword(card: KnowledgeCardRecord, keyword: string): boolean {
    if (keyword.length === 0) {
      return true;
    }
    const haystack = [card.title, card.summary, card.content, ...card.aliases]
      .join('\n')
      .toLowerCase();
    return haystack.includes(keyword);
  }

  const bookOutlineRepository: BookOutlineRepository = {
    async findByBookId(bookId) {
      return outlineMap.get(bookId) ?? null;
    },

    async upsert(input: UpsertBookOutlineRecordInput) {
      const record: BookOutlineRecord = {
        bookId: input.bookId,
        mainPlot: input.mainPlot,
        worldSetting: input.worldSetting,
        styleGuide: input.styleGuide,
        endingPlan: input.endingPlan,
        updatedAt: now(),
      };
      outlineMap.set(record.bookId, record);
      return record;
    },
  };

  const knowledgeCardRepository: KnowledgeCardRepository = {
    async listByBook(bookId: string, filter: KnowledgeCardListFilter = {}) {
      const keyword = filter.q?.trim().toLowerCase() ?? '';
      return [...cardMap.values()]
        .filter((card) => card.bookId === bookId)
        .filter((card) => filter.category === undefined || card.category === filter.category)
        .filter((card) => filter.pinned === undefined || card.pinned === filter.pinned)
        .filter((card) => matchesKeyword(card, keyword))
        .sort(compareCards);
    },

    async findById(id) {
      return cardMap.get(id) ?? null;
    },

    async create(input: CreateKnowledgeCardRecordInput) {
      const at = now();
      const record: KnowledgeCardRecord = {
        id: randomUUID(),
        bookId: input.bookId,
        category: input.category,
        title: input.title,
        summary: input.summary,
        content: input.content,
        aliases: [...input.aliases],
        tags: [...input.tags],
        pinned: input.pinned,
        sortOrder: input.sortOrder ?? nextCardSortOrder(input.bookId),
        embedding: input.embedding ?? null,
        embeddingModelRef: input.embeddingModelRef ?? null,
        createdAt: at,
        updatedAt: at,
      };
      cardMap.set(record.id, record);
      return record;
    },

    async update(id: string, patch: UpdateKnowledgeCardRecordPatch) {
      const current = cardMap.get(id);
      if (!current) {
        return null;
      }
      const next: KnowledgeCardRecord = { ...current, ...patch, updatedAt: now() };
      cardMap.set(id, next);
      return next;
    },

    async delete(id) {
      return cardMap.delete(id);
    },
  };

  const chapterSummaryRepository: ChapterSummaryRepository = {
    async findByChapterId(chapterId) {
      return summaryMap.get(chapterId) ?? null;
    },

    async listByBook(bookId) {
      return [...summaryMap.values()]
        .filter((summary) => summary.bookId === bookId)
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
    },

    async upsert(input: UpsertChapterSummaryRecordInput) {
      const record: ChapterSummaryRecord = {
        chapterId: input.chapterId,
        bookId: input.bookId,
        outline: input.outline,
        summary: input.summary,
        keyEvents: [...input.keyEvents],
        charactersPresent: [...input.charactersPresent],
        source: input.source,
        updatedAt: now(),
      };
      summaryMap.set(record.chapterId, record);
      return record;
    },
  };

  return {
    bookOutlines: bookOutlineRepository,
    knowledgeCards: knowledgeCardRepository,
    chapterSummaries: chapterSummaryRepository,
    state: {
      outlines: outlineMap,
      cards: cardMap,
      summaries: summaryMap,
    },
  };
}
