import { describe, expect, it } from 'vitest';
import { MAX_CHAPTER_OUTLINE_LENGTH } from '@fanxiaoshuo/shared';
import type { ContextKnowledgeCardInput } from '../context/card-recall.js';
import {
  buildChapterCriticPrompts,
  buildChapterOutlinePrompts,
  buildChapterReworkPrompts,
  parseCriticReview,
  parsePlannedOutline,
} from '../prompts/batch-workflow.js';

const CARDS: readonly ContextKnowledgeCardInput[] = [
  {
    id: 'card-1',
    category: 'character',
    title: '沈青梧',
    summary: '主角，剑修，性格克制',
    content: '出身寒门，凭一柄断剑入道。',
    aliases: ['青梧'],
    tags: ['主角'],
    pinned: true,
    sortOrder: 0,
  },
  {
    id: 'card-2',
    category: 'faction',
    title: '问剑宗',
    summary: '正道第一大派，规矩森严',
    content: '宗主闭关十年，内门三脉暗斗。',
    aliases: [],
    tags: ['势力'],
    pinned: false,
    sortOrder: 1,
  },
];

const BOOK_OUTLINE = {
  mainPlot: '少年持断剑北上问道，最终补全剑道',
  worldSetting: '九州灵气衰微，剑修以命换锋',
  styleGuide: '冷峻克制，不写市井插科打诨',
  endingPlan: '剑归九州，主角自断长生',
};

describe('buildChapterOutlinePrompts（showrunner 拆细纲）', () => {
  it('包含角色边界、总大纲、设定卡、前情、上一章尾部、本章标题与用户指令', () => {
    const prompts = buildChapterOutlinePrompts({
      bookTitle: '断剑问天',
      genre: '东方玄幻',
      bookOutline: BOOK_OUTLINE,
      cards: CARDS,
      recentSummaries: [
        { chapterTitle: '第一章 断剑', summary: '沈青梧得断剑', keyEvents: ['拾得断剑'] },
      ],
      prevChapter: { title: '第一章 断剑', contentText: '他握紧了剑柄。' },
      chapterTitle: '第二章 问剑',
      existingOutline: '旧细纲：上山问剑',
      instruction: '本章必须出现一次败北',
    });

    expect(prompts.system).toContain('总编策划');
    expect(prompts.system).toContain('单章细纲规划');
    expect(prompts.system).toContain('章末钩子');
    expect(prompts.system).toContain('{"outline"');

    expect(prompts.prompt).toContain('《断剑问天》');
    expect(prompts.prompt).toContain('东方玄幻');
    expect(prompts.prompt).toContain('九州灵气衰微');
    expect(prompts.prompt).toContain('【人物】沈青梧');
    expect(prompts.prompt).toContain('【势力】问剑宗');
    expect(prompts.prompt).toContain('第一章 断剑');
    expect(prompts.prompt).toContain('他握紧了剑柄。');
    expect(prompts.prompt).toContain('《第二章 问剑》');
    expect(prompts.prompt).toContain('旧细纲：上山问剑');
    expect(prompts.prompt).toContain('本章必须出现一次败北');
  });

  it('未提供任何可选上下文时仍产出兜底文案而不抛异常', () => {
    const prompts = buildChapterOutlinePrompts({ bookTitle: '', chapterTitle: '' });

    expect(prompts.prompt).toContain('（未命名作品）');
    expect(prompts.prompt).toContain('（未命名章节）');
    expect(prompts.prompt).toContain('（未提供全书总大纲）');
    expect(prompts.prompt).toContain('（本章尚无细纲，请从零规划）');
  });
});

describe('parsePlannedOutline（细纲容错解析）', () => {
  it('剥离代码块并取 JSON 的 outline 字段', () => {
    const raw = '```json\n{"outline": "核心目标：夺剑\\n章末钩子：剑鸣"}\n```';
    expect(parsePlannedOutline(raw)).toBe('核心目标：夺剑\n章末钩子：剑鸣');
  });

  it('模型夹杂说明文本时抽取首个 JSON 对象', () => {
    const raw = '好的，细纲如下：{"outline": "核心目标：破阵"} 请查收。';
    expect(parsePlannedOutline(raw)).toBe('核心目标：破阵');
  });

  it('纯文本细纲直接采用清理后的正文', () => {
    const raw = '【核心目标】守住山门\n【核心冲突】内门叛变';
    expect(parsePlannedOutline(raw)).toBe('【核心目标】守住山门\n【核心冲突】内门叛变');
  });

  it('JSON 缺少 outline 或 outline 为空时回退到纯文本', () => {
    expect(parsePlannedOutline('{"outline": "   "}')).toBe('{"outline": "   "}');
    expect(parsePlannedOutline('{"score": 1}')).toBe('{"score": 1}');
  });

  it('超长细纲截断到共享契约上限，且损坏输入不抛异常', () => {
    const raw = 'x'.repeat(MAX_CHAPTER_OUTLINE_LENGTH + 50);
    expect(parsePlannedOutline(raw)).toHaveLength(MAX_CHAPTER_OUTLINE_LENGTH);

    expect(() => parsePlannedOutline('{{{ broken json')).not.toThrow();
    expect(parsePlannedOutline('')).toBe('');
  });
});

describe('buildChapterCriticPrompts（critic 审稿）', () => {
  it('明确及格分阈值与严格 JSON 字段契约', () => {
    const prompts = buildChapterCriticPrompts({
      bookTitle: '断剑问天',
      chapterTitle: '第二章 问剑',
      minPassScore: 80,
      bookOutline: BOOK_OUTLINE,
      cards: CARDS,
      recentSummaries: [{ chapterTitle: '第一章 断剑', summary: '得断剑' }],
      chapterOutline: '核心目标：上山问剑',
      contentText: '他一剑劈开山门。',
      instruction: '重点看人物口吻',
    });

    expect(prompts.system).toContain('审稿质检');
    expect(prompts.system).toContain('及格分阈值：80 分');
    expect(prompts.system).toContain('"reworkGuidance"');
    expect(prompts.system).toContain('水文');

    expect(prompts.prompt).toContain('《断剑问天》');
    expect(prompts.prompt).toContain('《第二章 问剑》');
    expect(prompts.prompt).toContain('核心目标：上山问剑');
    expect(prompts.prompt).toContain('他一剑劈开山门。');
    expect(prompts.prompt).toContain('重点看人物口吻');
  });
});

describe('parseCriticReview（审稿 JSON 容错解析与阈值硬规则）', () => {
  it('解析代码块包裹的合法 JSON', () => {
    const raw = [
      '```json',
      '{"score": 88, "passed": true, "summary": "推进扎实", "issues": ["章末钩子偏弱"], "reworkGuidance": "补一个危机"}',
      '```',
    ].join('\n');

    const review = parseCriticReview(raw, 75);

    expect(review).toEqual({
      score: 88,
      passed: true,
      summary: '推进扎实',
      issues: ['章末钩子偏弱'],
      reworkGuidance: '补一个危机',
    });
  });

  it('得分低于及格分时强制判为不通过（即使模型自称 passed: true）', () => {
    const review = parseCriticReview(
      '{"score": 60, "passed": true, "summary": "节奏拖沓", "issues": [], "reworkGuidance": "压缩开场"}',
      75,
    );

    expect(review.score).toBe(60);
    expect(review.passed).toBe(false);
  });

  it('得分达标但模型显式给出 passed: false 时保持不通过', () => {
    const review = parseCriticReview('{"score": 90, "passed": false}', 75);
    expect(review.passed).toBe(false);
  });

  it('缺失 passed 时按及格分阈值推导', () => {
    expect(parseCriticReview('{"score": 90, "summary": "可用"}', 75).passed).toBe(true);
    expect(parseCriticReview('{"score": 40, "summary": "硬伤"}', 75).passed).toBe(false);
    expect(parseCriticReview('{"summary": "只有评价"}', 75)).toMatchObject({
      score: 75,
      passed: true,
    });
  });

  it('归一化得分范围并兼容数字字符串', () => {
    expect(parseCriticReview('{"score": 150}', 75).score).toBe(100);
    expect(parseCriticReview('{"score": -20}', 75).score).toBe(0);
    expect(parseCriticReview('{"score": "83.4"}', 75).score).toBe(83);
  });

  it('问题清单去空白、去重、逐条限长并限制条数', () => {
    const issues = ['  重复问题  ', '重复问题', '', '第三个问题', 42, null];
    for (let index = 0; index < 20; index += 1) {
      issues.push(`问题${index}`);
    }

    const review = parseCriticReview(
      JSON.stringify({
        score: 50,
        passed: false,
        summary: '多问题',
        issues,
        reworkGuidance: '逐条修改',
      }),
      75,
    );

    expect(review.issues.length).toBe(15);
    expect(review.issues[0]).toBe('重复问题');
    expect(review.issues).not.toContain('  重复问题  ');
    expect(review.issues.filter((issue) => issue === '重复问题')).toHaveLength(1);

    const longIssue = parseCriticReview(
      JSON.stringify({ score: 50, issues: ['x'.repeat(600)] }),
      75,
    );
    expect(longIssue.issues[0]).toHaveLength(500);
  });

  it('summary 与 reworkGuidance 截断到 2000 字', () => {
    const review = parseCriticReview(
      JSON.stringify({ score: 50, summary: 'y'.repeat(2500), reworkGuidance: 'z'.repeat(2500) }),
      75,
    );

    expect(review.summary).toHaveLength(2000);
    expect(review.reworkGuidance).toHaveLength(2000);
  });

  it('完全非 JSON 时优雅降级为不阻断批次的通过结论', () => {
    const review = parseCriticReview('  整体尚可，但开场略慢。  ', 75);

    expect(review).toEqual({
      score: 75,
      passed: true,
      summary: '整体尚可，但开场略慢。',
      issues: [],
      reworkGuidance: '',
    });
  });

  it('空输出回落到「审稿完成」摘要且不抛异常', () => {
    expect(parseCriticReview('', 80)).toEqual({
      score: 80,
      passed: true,
      summary: '审稿完成',
      issues: [],
      reworkGuidance: '',
    });
    expect(() => parseCriticReview('{{ not json ', 80)).not.toThrow();
  });
});

describe('buildChapterReworkPrompts（writer 按意见返工）', () => {
  it('在首稿提示词之上追加审稿得分、问题清单、返工指导与原始初稿', () => {
    const prompts = buildChapterReworkPrompts({
      baseSystemPrompt: '【首个系统提示词】执笔写手边界',
      baseUserPrompt: '【首个用户提示词】第一卷上下文',
      previousDraft: '他一剑劈开山门，风吹过。',
      review: {
        score: 60,
        passed: false,
        summary: '开场铺垫过长',
        issues: ['开场铺垫过长', '对话缺乏信息量'],
        reworkGuidance: '把前两段压缩成一段并加入冲突',
      },
      round: 1,
      maxRounds: 2,
      chapterTitle: '第二章 问剑',
      targetWords: 2000,
    });

    expect(prompts.system).toContain('【首个系统提示词】执笔写手边界');
    expect(prompts.system).toContain('返工模式附加纪律');
    expect(prompts.system).toContain('不是重写一个全新的章节');

    expect(prompts.prompt).toContain('【首个用户提示词】第一卷上下文');
    expect(prompts.prompt).toContain('【返工任务：第 1/2 轮】');
    expect(prompts.prompt).toContain('《第二章 问剑》');
    expect(prompts.prompt).toContain('2000 字');
    expect(prompts.prompt).toContain('- 得分：60 分');
    expect(prompts.prompt).toContain('开场铺垫过长');
    expect(prompts.prompt).toContain('2. 对话缺乏信息量');
    expect(prompts.prompt).toContain('把前两段压缩成一段并加入冲突');
    expect(prompts.prompt).toContain('他一剑劈开山门，风吹过。');
    expect(prompts.prompt).toContain('请输出修订后的完整本章正文段落。');
  });

  it('问题清单或返工指导为空时给出可执行的兜底指令', () => {
    const prompts = buildChapterReworkPrompts({
      baseSystemPrompt: 'system',
      baseUserPrompt: 'prompt',
      previousDraft: '初稿',
      review: { score: 70, passed: false, summary: '', issues: [], reworkGuidance: '' },
      round: 2,
      maxRounds: 3,
    });

    expect(prompts.prompt).toContain('（审稿官未列出具体问题');
    expect(prompts.prompt).toContain('（未提供具体返工指导');
    expect(prompts.prompt).toContain('第 2/3 轮');
  });
});
