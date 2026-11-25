import {
  MAX_RECALLED_CARDS,
  type ContextCardRecallReason,
  type KnowledgeCardCategory,
} from '@fanxiaoshuo/shared';

/**
 * 设定卡召回（Book Bible → 写作上下文）。
 *
 * 召回优先级（与 `openspec/changes/book-bible-and-ai-writer/design.md` 一致）：
 * 1. `selected`：用户在请求中显式勾选的卡片（最高优先级，按勾选顺序）；
 * 2. `pinned`：常驻置顶卡片（按 `sortOrder` 升序）；
 * 3. `recalled`：其余卡片按查询文本相关性打分（标题 / 别名 / 标签 / 摘要与正文关键词）
 *    并可选叠加向量余弦相似度，取分数为正的 Top-K。
 *
 * 全流程纯函数、确定性，不触碰数据库与网络（向量由调用方从仓储层取出后传入）。
 */

/** 召回器可接受的设定卡输入（`embedding` 缺省表示尚未向量化）。 */
export interface ContextKnowledgeCardInput {
  readonly id: string;
  readonly category: KnowledgeCardCategory;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly pinned: boolean;
  readonly sortOrder: number;
  readonly embedding?: readonly number[] | null;
}

/** `recallKnowledgeCards` 入参。 */
export interface RecallKnowledgeCardsOptions {
  readonly cards: readonly ContextKnowledgeCardInput[];
  /** 用户手动勾选的卡片 ID（按此顺序优先纳入） */
  readonly selectedCardIds?: readonly string[];
  /** 查询文本：当前章标题 + 本章细纲 + 选区/正文尾部 + 用户指令 */
  readonly queryText: string;
  /** 查询向量（与卡片的 `embedding` 同维度时参与加权） */
  readonly queryEmbedding?: readonly number[] | null;
  /** 自动召回卡片上限（不含手动勾选与常驻置顶） */
  readonly maxRecalledCards?: number;
}

/** 单张被召回卡片（含纳入原因与相关性得分）。 */
export interface RecalledKnowledgeCard {
  readonly card: ContextKnowledgeCardInput;
  readonly reason: ContextCardRecallReason;
  readonly score: number;
}

/** 标题整体命中的加权分。 */
const TITLE_HIT_SCORE = 10;

/** 单个别名命中的加权分。 */
const ALIAS_HIT_SCORE = 8;

/** 单个标签命中的加权分。 */
const TAG_HIT_SCORE = 3;

/** 别名最多计入命中数量（防御别名数组过长导致得分虚高）。 */
const MAX_ALIAS_HITS = 3;

/** 标签最多计入命中数量。 */
const MAX_TAG_HITS = 3;

/** 摘要 / 正文关键词最多计入命中数量。 */
const MAX_KEYWORD_HITS = 6;

/** 向量相似度参与加权的下限（低于该值视为语义无关）。 */
const EMBEDDING_SIMILARITY_THRESHOLD = 0.2;

/** 向量相似度加权系数（`sim * 1200 / 100` 即保留两位小数的 0–12 分）。 */
const EMBEDDING_SCORE_SCALE = 1200;

/** CJK 连续片段（用于从查询文本中提取中文关键词）。 */
const CJK_RUN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

/** 拉丁 / 数字词（长度 ≥ 2 才作为关键词）。 */
const LATIN_WORD_PATTERN = /[A-Za-z0-9]{2,}/g;

/** 中文长片段切分为二元组时保留的最长整段长度（短于等于该长度直接整段作为关键词）。 */
const MAX_WHOLE_CJK_KEYWORD_LENGTH = 4;

/**
 * 余弦相似度。
 *
 * 任一向量为空、长度不等或任一范数为 0 时返回 `null`（表示「不可比较」而非「不相似」），
 * 其余情况返回夹紧到 `[-1, 1]` 的相似度。
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) return null;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) return null;

  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (!Number.isFinite(similarity)) return null;

  return Math.min(1, Math.max(-1, similarity));
}

/**
 * 从查询文本中提取去重后的关键词。
 *
 * - 中文：短片段（≤ 4 字）整段保留，长片段按二元组切分（无需分词器即可命中人名 / 地名 / 术语）；
 * - 拉丁与数字：长度 ≥ 2 的整词，统一转小写。
 */
function extractQueryKeywords(queryText: string): string[] {
  const keywords = new Set<string>();

  for (const run of queryText.match(CJK_RUN_PATTERN) ?? []) {
    if (run.length < 2) continue;
    if (run.length <= MAX_WHOLE_CJK_KEYWORD_LENGTH) {
      keywords.add(run);
      continue;
    }
    for (let index = 0; index + 2 <= run.length; index += 1) {
      keywords.add(run.slice(index, index + 2));
    }
  }

  for (const word of queryText.match(LATIN_WORD_PATTERN) ?? []) {
    keywords.add(word.toLowerCase());
  }

  return [...keywords];
}

/** 排序：`sortOrder` 升序，同序时按 id 升序（保证确定性）。 */
function compareCards(
  left: ContextKnowledgeCardInput,
  right: ContextKnowledgeCardInput,
): number {
  if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** 基于查询文本（及可选向量）给单张卡片打分。 */
function scoreCardAgainstQuery(
  card: ContextKnowledgeCardInput,
  queryTextLower: string,
  keywords: readonly string[],
  queryEmbedding: readonly number[] | null | undefined,
): number {
  let score = 0;

  const titleLower = card.title.trim().toLowerCase();
  if (titleLower.length > 0 && queryTextLower.includes(titleLower)) {
    score += TITLE_HIT_SCORE;
  }

  let aliasHits = 0;
  for (const alias of card.aliases) {
    if (aliasHits >= MAX_ALIAS_HITS) break;
    const aliasLower = alias.trim().toLowerCase();
    if (aliasLower.length > 0 && queryTextLower.includes(aliasLower)) {
      score += ALIAS_HIT_SCORE;
      aliasHits += 1;
    }
  }

  let tagHits = 0;
  for (const tag of card.tags) {
    if (tagHits >= MAX_TAG_HITS) break;
    const tagLower = tag.trim().toLowerCase();
    if (tagLower.length > 0 && queryTextLower.includes(tagLower)) {
      score += TAG_HIT_SCORE;
      tagHits += 1;
    }
  }

  const summaryLower = card.summary.toLowerCase();
  const contentLower = card.content.toLowerCase();
  let keywordHits = 0;
  for (const keyword of keywords) {
    if (keywordHits >= MAX_KEYWORD_HITS) break;
    const hitSummary = summaryLower.length > 0 && summaryLower.includes(keyword);
    const hitContent = contentLower.length > 0 && contentLower.includes(keyword);
    if (hitSummary || hitContent) keywordHits += 1;
  }
  score += keywordHits;

  if (queryEmbedding && queryEmbedding.length > 0 && card.embedding && card.embedding.length > 0) {
    const similarity = cosineSimilarity(queryEmbedding, card.embedding);
    if (similarity !== null && similarity > EMBEDDING_SIMILARITY_THRESHOLD) {
      score += Math.max(0, Math.round(similarity * EMBEDDING_SCORE_SCALE) / 100);
    }
  }

  return score;
}

/**
 * 召回设定卡：手动勾选 → 常驻置顶 → 相关性 Top-K。
 *
 * 重复 `id` 只保留首次出现的卡片；`maxRecalledCards <= 0` 时仅返回勾选与置顶卡片。
 */
export function recallKnowledgeCards(
  options: RecallKnowledgeCardsOptions,
): RecalledKnowledgeCard[] {
  const rawLimit = options.maxRecalledCards ?? MAX_RECALLED_CARDS;
  const maxRecalledCards = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 0;

  const cardById = new Map<string, ContextKnowledgeCardInput>();
  for (const card of options.cards) {
    if (!cardById.has(card.id)) cardById.set(card.id, card);
  }

  const consumed = new Set<string>();
  const result: RecalledKnowledgeCard[] = [];

  for (const cardId of options.selectedCardIds ?? []) {
    const card = cardById.get(cardId);
    if (!card || consumed.has(card.id)) continue;
    consumed.add(card.id);
    result.push({ card, reason: 'selected', score: 0 });
  }

  const pinnedCards = [...cardById.values()]
    .filter((card) => !consumed.has(card.id) && card.pinned)
    .sort(compareCards);

  for (const card of pinnedCards) {
    consumed.add(card.id);
    result.push({ card, reason: 'pinned', score: 0 });
  }

  if (maxRecalledCards === 0) return result;

  const queryTextLower = options.queryText.toLowerCase();
  const keywords = extractQueryKeywords(options.queryText);

  const recalled = [...cardById.values()]
    .filter((card) => !consumed.has(card.id))
    .map((card) => ({
      card,
      reason: 'recalled' as const,
      score: scoreCardAgainstQuery(card, queryTextLower, keywords, options.queryEmbedding),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return compareCards(left.card, right.card);
    })
    .slice(0, maxRecalledCards);

  result.push(...recalled);

  return result;
}
