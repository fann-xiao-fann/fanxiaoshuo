import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  recallKnowledgeCards,
  type ContextKnowledgeCardInput,
} from '../context/card-recall.js';

/**
 * 设定卡召回单测：
 * 覆盖「手动勾选 > 常驻置顶 > 相关性打分」三层优先级、关键词 / 别名 / 标签计分、
 * 余弦相似度加权、id 去重与召回条数上限。
 */

const BASE_CARD: ContextKnowledgeCardInput = {
  id: '00000000-0000-4000-8000-000000000000',
  category: 'character',
  title: '',
  summary: '',
  content: '',
  aliases: [],
  tags: [],
  pinned: false,
  sortOrder: 0,
  embedding: null,
};

function makeCard(overrides: Partial<ContextKnowledgeCardInput> & { id: string }): ContextKnowledgeCardInput {
  return { ...BASE_CARD, ...overrides };
}

describe('cosineSimilarity', () => {
  it('相同向量为 1，正交为 0，反向为 -1', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('不可比较的输入返回 null', () => {
    expect(cosineSimilarity([], [1])).toBeNull();
    expect(cosineSimilarity([1], [])).toBeNull();
    expect(cosineSimilarity([1, 2], [1])).toBeNull();
    expect(cosineSimilarity([0, 0], [1, 1])).toBeNull();
    expect(cosineSimilarity([1, 1], [0, 0])).toBeNull();
    expect(cosineSimilarity([Number.NaN, 1], [1, 1])).toBeNull();
  });

  it('结果夹紧在 [-1, 1] 内', () => {
    const similarity = cosineSimilarity([3, 4], [6, 8]);
    expect(similarity).not.toBeNull();
    expect(similarity as number).toBeLessThanOrEqual(1);
    expect(similarity as number).toBeGreaterThanOrEqual(-1);
  });
});

describe('recallKnowledgeCards 优先级', () => {
  it('手动勾选 > 常驻置顶 > 智能召回，并按 score / sortOrder 排序', () => {
    const selected = makeCard({ id: 'card-selected', title: '完全无关' });
    const pinnedLater = makeCard({ id: 'card-pinned-2', title: '常驻乙', pinned: true, sortOrder: 2 });
    const pinnedEarlier = makeCard({ id: 'card-pinned-1', title: '常驻甲', pinned: true, sortOrder: 1 });
    const recalledHigh = makeCard({ id: 'card-recalled-high', title: '陆青', sortOrder: 9 });
    const recalledLow = makeCard({ id: 'card-recalled-low', tags: ['剑修'], sortOrder: 1 });
    const ignored = makeCard({ id: 'card-ignored', title: '毫无关联' });

    const result = recallKnowledgeCards({
      cards: [ignored, recalledLow, pinnedLater, selected, recalledHigh, pinnedEarlier],
      selectedCardIds: ['card-selected'],
      queryText: '陆青 剑修',
      maxRecalledCards: 5,
    });

    expect(result.map((entry) => entry.card.id)).toEqual([
      'card-selected',
      'card-pinned-1',
      'card-pinned-2',
      'card-recalled-high',
      'card-recalled-low',
    ]);
    expect(result.map((entry) => entry.reason)).toEqual([
      'selected',
      'pinned',
      'pinned',
      'recalled',
      'recalled',
    ]);
    expect(result[0]?.score).toBe(0);
    expect(result[1]?.score).toBe(0);
    expect(result[3]?.score).toBeGreaterThan(result[4]?.score ?? 0);
  });

  it('按 id 去重：重复卡片与重复勾选只保留一次', () => {
    const card = makeCard({ id: 'dup-card', title: '陆青' });
    const result = recallKnowledgeCards({
      cards: [card, { ...card, title: '陆青（重复）' }],
      selectedCardIds: ['dup-card', 'dup-card'],
      queryText: '陆青',
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toBe('selected');
    expect(result[0]?.card.title).toBe('陆青');
  });

  it('maxRecalledCards 限制自动召回数量，0 时只返回勾选与置顶卡', () => {
    const cards = [
      makeCard({ id: 'pin', title: '常驻', pinned: true }),
      makeCard({ id: 'r1', title: '陆青' }),
      makeCard({ id: 'r2', tags: ['剑修'] }),
      makeCard({ id: 'r3', summary: '青云宗外门弟子' }),
    ];

    const limited = recallKnowledgeCards({
      cards,
      queryText: '陆青 剑修 青云宗外门弟子',
      maxRecalledCards: 1,
    });
    expect(limited.map((entry) => entry.card.id)).toEqual(['pin', 'r1']);

    const none = recallKnowledgeCards({
      cards,
      queryText: '陆青 剑修 青云宗外门弟子',
      maxRecalledCards: 0,
    });
    expect(none.map((entry) => entry.card.id)).toEqual(['pin']);
  });
});

describe('recallKnowledgeCards 相关性打分', () => {
  it('标题命中 +10', () => {
    const card = makeCard({ id: 'title-card', title: '陆青' });
    const [entry] = recallKnowledgeCards({ cards: [card], queryText: '陆青出场' });
    expect(entry?.score).toBe(10);
  });

  it('别名命中 +8，且最多计 3 个别名', () => {
    const aliasCard = makeCard({ id: 'alias-card', title: '无关', aliases: ['青哥'] });
    const [single] = recallKnowledgeCards({ cards: [aliasCard], queryText: '青哥' });
    expect(single?.score).toBe(8);

    const manyAliases = makeCard({
      id: 'alias-card-many',
      title: '无关',
      aliases: ['甲一', '乙二', '丙三', '丁四'],
    });
    const [capped] = recallKnowledgeCards({ cards: [manyAliases], queryText: '甲一 乙二 丙三 丁四' });
    expect(capped?.score).toBe(24);
  });

  it('标签命中 +3，且最多计 3 个标签', () => {
    const tagCard = makeCard({ id: 'tag-card', title: '无关', tags: ['剑修'] });
    const [single] = recallKnowledgeCards({ cards: [tagCard], queryText: '剑修' });
    expect(single?.score).toBe(3);

    const manyTags = makeCard({
      id: 'tag-card-many',
      title: '无关',
      tags: ['甲', '乙', '丙', '丁'],
    });
    const [capped] = recallKnowledgeCards({ cards: [manyTags], queryText: '甲 乙 丙 丁' });
    expect(capped?.score).toBe(9);
  });

  it('摘要 / 正文关键词命中每个 +1，上限 +6', () => {
    const card = makeCard({
      id: 'keyword-card',
      title: '无关',
      summary: '身世成谜',
      content: '随身携带半枚玉佩',
    });
    // 「身世」命中摘要，「半枚」「玉佩」命中正文 → 3 分
    const [entry] = recallKnowledgeCards({ cards: [card], queryText: '身世 半枚 玉佩' });
    expect(entry?.score).toBe(3);

    const richCard = makeCard({
      id: 'keyword-card-many',
      title: '无关',
      summary: '甲乙丙丁戊己庚辛壬癸',
      content: '',
    });
    const [capped] = recallKnowledgeCards({
      cards: [richCard],
      queryText: '甲乙 乙丙 丙丁 丁戊 戊己 己庚 庚辛 辛壬 壬癸',
    });
    expect(capped?.score).toBe(6);
  });

  it('零分卡片不会被自动召回', () => {
    const card = makeCard({ id: 'zero-card', title: '无关' });
    expect(recallKnowledgeCards({ cards: [card], queryText: '陆青' })).toEqual([]);
  });

  it('向量相似度超过阈值时叠加两位小数的加权分', () => {
    const card = makeCard({ id: 'embedding-card', title: '无关', embedding: [1, 0] });
    const [entry] = recallKnowledgeCards({
      cards: [card],
      queryText: '随便看看',
      queryEmbedding: [1, 0],
    });
    // sim = 1 → Math.round(1 * 1200) / 100 = 12
    expect(entry?.score).toBe(12);
  });

  it('向量相似度低于阈值时不参与召回', () => {
    const card = makeCard({ id: 'weak-embedding', title: '无关', embedding: [1, 0] });
    const result = recallKnowledgeCards({
      cards: [card],
      queryText: '随便看看',
      queryEmbedding: [0, 1],
    });
    expect(result).toEqual([]);
  });

  it('向量加权与关键词得分可以叠加', () => {
    const card = makeCard({
      id: 'merged-card',
      title: '无关',
      summary: '身世成谜',
      embedding: [1, 0],
    });
    const [entry] = recallKnowledgeCards({
      cards: [card],
      queryText: '身世',
      queryEmbedding: [1, 0],
    });
    expect(entry?.score).toBe(13);
  });
});
