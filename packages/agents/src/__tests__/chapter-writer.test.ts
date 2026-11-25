import { describe, expect, it } from 'vitest';
import { AI_WRITE_ACTION_LABELS, MAX_CHAPTER_SUMMARY_LENGTH, type AiWriteAction } from '@fanxiaoshuo/shared';
import {
  buildActionTaskInstruction,
  buildChapterWriterSystemPrompt,
  buildSummaryExtractPrompts,
  parseExtractedSummary,
} from '../index.js';

/**
 * 章内写作 Prompt 与摘要解析单测：
 * 覆盖 4 种写作动作的系统提示词差异、任务指令段、lorekeeper 摘要提炼提示词，
 * 以及 `parseExtractedSummary` 的「标准 JSON / 代码块 JSON / 夹杂说明文本 / 纯文本兜底」四条路径。
 */

const ALL_ACTIONS: readonly AiWriteAction[] = ['continue', 'expand', 'rewrite', 'polish'];

/** 每种动作独有的一句话，用于验证 4 套规则互不串味。 */
const ACTION_SIGNATURES: Record<AiWriteAction, string> = {
  continue: '承接当前章节正文的最后一段自然续写',
  expand: '扩写范围严格限定在编辑器当前选中片段',
  rewrite: '改写对象是编辑器当前选中片段',
  polish: '仅做文字级打磨',
};

describe('buildChapterWriterSystemPrompt', () => {
  it('4 种动作各自生成对应规则且互不串味', () => {
    const prompts = ALL_ACTIONS.map((action) =>
      buildChapterWriterSystemPrompt({
        action,
        bookTitle: '剑起青云',
        genre: '仙侠',
        targetWords: 1_500,
      }),
    );

    ALL_ACTIONS.forEach((action, index) => {
      const prompt = prompts[index] ?? '';
      expect(prompt).toContain('剑起青云');
      expect(prompt).toContain('仙侠');
      expect(prompt).toContain(`${AI_WRITE_ACTION_LABELS[action]}（${action}）`);
      expect(prompt).toContain(ACTION_SIGNATURES[action]);
      expect(prompt).toContain('直接输出小说正文段落');
      expect(prompt).toContain('约 1500 字');

      for (const other of ALL_ACTIONS) {
        if (other === action) continue;
        expect(prompt).not.toContain(ACTION_SIGNATURES[other]);
      }
    });

    expect(new Set(prompts).size).toBe(ALL_ACTIONS.length);
  });

  it('默认使用执笔写手角色，可显式覆盖为其它角色', () => {
    const writerPrompt = buildChapterWriterSystemPrompt({
      action: 'continue',
      bookTitle: '剑起青云',
    });
    expect(writerPrompt).toContain('执笔写手');

    const criticPrompt = buildChapterWriterSystemPrompt({
      role: 'critic',
      action: 'polish',
      bookTitle: '剑起青云',
    });
    expect(criticPrompt).toContain('审稿质检');
    expect(criticPrompt).not.toContain('你是「梵小说」的执笔写手');
  });

  it('注入文风与禁忌', () => {
    const prompt = buildChapterWriterSystemPrompt({
      action: 'rewrite',
      bookTitle: '剑起青云',
      styleGuide: '冷峻克制，禁忌：不得出现现代名词。',
    });
    expect(prompt).toContain('文风与禁忌');
    expect(prompt).toContain('冷峻克制，禁忌：不得出现现代名词。');
  });
});

describe('buildActionTaskInstruction', () => {
  it('续写：默认期望字数 + 用户指令', () => {
    const instruction = buildActionTaskInstruction({
      action: 'continue',
      instruction: '让伏击者露出真容',
    });

    expect(instruction).toContain('续写（continue）');
    expect(instruction).toContain('约 1200 字');
    expect(instruction).toContain('让伏击者露出真容');
    expect(instruction).toContain('最后一段');
  });

  it('扩写：有选区时聚焦选区，并尊重显式目标字数', () => {
    const instruction = buildActionTaskInstruction({
      action: 'expand',
      selectedText: '沈砚缓缓抬头。',
      targetWords: 900,
    });

    expect(instruction).toContain('约 900 字');
    expect(instruction).toContain('选中片段');
    expect(instruction).toContain('用户未补充额外指令');
  });

  it('润色：无选区时给出自行定位处理对象的指引', () => {
    const instruction = buildActionTaskInstruction({ action: 'polish' });
    expect(instruction).toContain('润色（polish）');
    expect(instruction).toContain('没有选区');
  });
});

describe('buildSummaryExtractPrompts', () => {
  it('基于 lorekeeper 角色并要求严格 JSON 输出', () => {
    const { system, prompt } = buildSummaryExtractPrompts({
      bookTitle: '剑起青云',
      chapterTitle: '第3章 青石镇伏击',
      contentText: '沈砚缓缓抬头，断剑在雨中轻鸣。',
      existingOutline: '沈砚遭遇伏击，断剑初鸣。',
      instruction: '摘要控制在 200 字内',
    });

    expect(system).toContain('设定档案员');
    expect(system).toContain('JSON');
    expect(system).toContain('"summary"');
    expect(system).toContain('"keyEvents"');
    expect(system).toContain('"charactersPresent"');

    expect(prompt).toContain('剑起青云');
    expect(prompt).toContain('第3章 青石镇伏击');
    expect(prompt).toContain('沈砚缓缓抬头，断剑在雨中轻鸣。');
    expect(prompt).toContain('沈砚遭遇伏击，断剑初鸣。');
    expect(prompt).toContain('摘要控制在 200 字内');
  });
});

describe('parseExtractedSummary', () => {
  const standardJson = JSON.stringify({
    summary: '  沈砚在青石镇遭遇伏击，断剑初次出鞘退敌。  ',
    keyEvents: ['遭遇伏击', '断剑出鞘'],
    charactersPresent: ['沈砚', '蒙面人'],
  });

  it('解析标准 JSON 并去除首尾空白', () => {
    expect(parseExtractedSummary(standardJson)).toEqual({
      summary: '沈砚在青石镇遭遇伏击，断剑初次出鞘退敌。',
      keyEvents: ['遭遇伏击', '断剑出鞘'],
      charactersPresent: ['沈砚', '蒙面人'],
    });
  });

  it('解析 Markdown 代码块包裹的 JSON', () => {
    const fenced = ['```json', standardJson, '```'].join('\n');
    const parsed = parseExtractedSummary(fenced);
    expect(parsed.summary).toBe('沈砚在青石镇遭遇伏击，断剑初次出鞘退敌。');
    expect(parsed.keyEvents).toEqual(['遭遇伏击', '断剑出鞘']);
  });

  it('解析夹杂说明文本的 JSON', () => {
    const noisy = `好的，摘要如下：\n${standardJson}\n如需调整请告知。`;
    const parsed = parseExtractedSummary(noisy);
    expect(parsed.summary).toContain('断剑初次出鞘');
    expect(parsed.charactersPresent).toEqual(['沈砚', '蒙面人']);
  });

  it('纯文本时降级为清理后的文本与空数组', () => {
    const parsed = parseExtractedSummary('\n  沈砚在青石镇遭遇伏击，断剑初鸣。  \n');
    expect(parsed).toEqual({
      summary: '沈砚在青石镇遭遇伏击，断剑初鸣。',
      keyEvents: [],
      charactersPresent: [],
    });
  });

  it('非法 JSON 不抛异常且降级为纯文本', () => {
    const parsed = parseExtractedSummary('```json\n{ this is not json \n```');
    expect(parsed.keyEvents).toEqual([]);
    expect(parsed.charactersPresent).toEqual([]);
    expect(parsed.summary).toBe('{ this is not json');
  });

  it('summary 为空时同样走纯文本兜底', () => {
    const parsed = parseExtractedSummary(
      JSON.stringify({ summary: '   ', keyEvents: ['遭遇伏击'], charactersPresent: ['沈砚'] }),
    );
    expect(parsed.keyEvents).toEqual([]);
    expect(parsed.charactersPresent).toEqual([]);
    expect(parsed.summary.startsWith('{"summary"')).toBe(true);
  });

  it('规范化数组：去空白、去重、单条限长与条数上限', () => {
    const keyEvents = [
      '  遭遇伏击  ',
      '遭遇伏击',
      '',
      '断剑出鞘',
      'x'.repeat(300),
      ...Array.from({ length: 40 }, (_unused, index) => `事件${index}`),
    ];
    const charactersPresent = Array.from(
      { length: 60 },
      (_unused, index) => `角色${index}`,
    );

    const parsed = parseExtractedSummary(
      JSON.stringify({ summary: '本章剧情摘要。', keyEvents, charactersPresent }),
    );

    expect(parsed.keyEvents.length).toBeLessThanOrEqual(30);
    expect(parsed.keyEvents[0]).toBe('遭遇伏击');
    expect(parsed.keyEvents[1]).toBe('断剑出鞘');
    expect(parsed.keyEvents[2]).toHaveLength(200);
    expect(new Set(parsed.keyEvents).size).toBe(parsed.keyEvents.length);
    expect(parsed.charactersPresent).toHaveLength(50);
  });

  it('keyEvents / charactersPresent 非数组时降级为空数组', () => {
    const parsed = parseExtractedSummary(
      JSON.stringify({ summary: '本章剧情摘要。', keyEvents: '遭遇伏击', charactersPresent: 42 }),
    );
    expect(parsed.summary).toBe('本章剧情摘要。');
    expect(parsed.keyEvents).toEqual([]);
    expect(parsed.charactersPresent).toEqual([]);
  });

  it('summary 超过共享长度上限时被截断', () => {
    const parsed = parseExtractedSummary(
      JSON.stringify({ summary: '摘'.repeat(MAX_CHAPTER_SUMMARY_LENGTH + 500) }),
    );
    expect(parsed.summary).toHaveLength(MAX_CHAPTER_SUMMARY_LENGTH);
  });
});
