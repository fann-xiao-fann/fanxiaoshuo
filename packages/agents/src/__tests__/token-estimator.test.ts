import { describe, expect, it } from 'vitest';
import { estimateTokens, truncateToTokenBudget } from '../context/token-estimator.js';

/**
 * 确定性 Token 估算器单测：
 * 覆盖中英混合加权、空白串、非负整数契约与 start/end 两种预算截断方向。
 */
describe('estimateTokens', () => {
  it('空串与纯空白串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(0);
    expect(estimateTokens('\n\t\r\n')).toBe(0);
    expect(estimateTokens('　　')).toBe(0);
  });

  it('中文正文按每字 1 token 估算', () => {
    expect(estimateTokens('陆青拔剑')).toBe(4);
    expect(estimateTokens('风起于青萍之末')).toBe(7);
  });

  it('拉丁与数字按单词估算', () => {
    expect(estimateTokens('hello')).toBe(2);
    expect(estimateTokens('hello world')).toBe(3);
    expect(estimateTokens('GPT4o mini')).toBe(3);
  });

  it('中英混合时按字符类别加权并向上取整', () => {
    // 「第」「章」「登」「场」= 4；「1」「Luffy」= 2 词 × 1.3 = 2.6 → 6.6 → 7
    expect(estimateTokens('第1章 Luffy 登场')).toBe(7);
  });

  it('其余可见符号按半 token 估算并向上取整', () => {
    expect(estimateTokens('——')).toBe(1);
    expect(estimateTokens('……')).toBe(1);
    expect(estimateTokens('—— ……')).toBe(2);
  });

  it('恒为非负整数', () => {
    const samples = ['', 'a', '中文', '中英 mixed 123 —— 🐉', 'a'.repeat(1000)];
    for (const sample of samples) {
      const tokens = estimateTokens(sample);
      expect(Number.isInteger(tokens)).toBe(true);
      expect(tokens).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('truncateToTokenBudget', () => {
  const longText = '青'.repeat(200);

  it('预算内原样返回且不标记截断', () => {
    const result = truncateToTokenBudget('陆青拔剑', 10);
    expect(result).toEqual({ text: '陆青拔剑', truncated: false, estimatedTokens: 4 });
  });

  it('mode=end 保留开头并追加省略号', () => {
    const result = truncateToTokenBudget(longText, 10);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('青青青')).toBe(true);
    expect(result.text.endsWith('…')).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(10);
    expect(result.text.length).toBeLessThan(longText.length);
  });

  it('mode=start 保留结尾并前置省略号', () => {
    const text = `开头部分${'尾'.repeat(200)}`;
    const result = truncateToTokenBudget(text, 12, 'start');
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('…')).toBe(true);
    expect(result.text.endsWith('尾')).toBe(true);
    expect(result.text).not.toContain('开头');
    expect(result.estimatedTokens).toBeLessThanOrEqual(12);
  });

  it('maxTokens <= 0 时返回空串并标记截断', () => {
    expect(truncateToTokenBudget('陆青拔剑', 0)).toEqual({
      text: '',
      truncated: true,
      estimatedTokens: 0,
    });
    expect(truncateToTokenBudget('陆青拔剑', -5)).toEqual({
      text: '',
      truncated: true,
      estimatedTokens: 0,
    });
    expect(truncateToTokenBudget('', 0)).toEqual({
      text: '',
      truncated: false,
      estimatedTokens: 0,
    });
  });

  it('极小预算下仍返回不超过预算的文本', () => {
    const result = truncateToTokenBudget(longText, 1);
    expect(result.truncated).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(1);
  });
});
