import { describe, expect, it } from 'vitest';
import { countNovelWords, isBlankNovelText } from '../index.js';

describe('countNovelWords（网文统一字数口径）', () => {
  it('纯中文按字计数', () => {
    expect(countNovelWords('第一章风起云涌')).toBe(7);
    expect(countNovelWords('龙')).toBe(1);
  });

  it('忽略半角空白与换行（空格 / Tab / \\r\\n）', () => {
    expect(countNovelWords('第一章 风起\n云涌')).toBe(7);
    expect(countNovelWords('  你好\t世界\r\n')).toBe(4);
    expect(countNovelWords('\n\n第一段\n\n第二段\n')).toBe(6);
  });

  it('忽略全角空格与零宽字符', () => {
    expect(countNovelWords('\u3000一\u3000二\u3000')).toBe(2);
    expect(countNovelWords('a\u200bb')).toBe(2);
    expect(countNovelWords('\ufeff你好\u2060')).toBe(2);
    expect(countNovelWords('\u00a0\u2000\u200a')).toBe(0);
  });

  it('中文标点逐字计入（与主流网文平台口径一致）', () => {
    expect(countNovelWords('“你好，世界！”')).toBe(8);
    expect(countNovelWords('……')).toBe(2);
  });

  it('连续 ASCII 字母/数字串记为 1 词', () => {
    expect(countNovelWords('Hello')).toBe(1);
    expect(countNovelWords('2024')).toBe(1);
    expect(countNovelWords('abc123def')).toBe(1);
    expect(countNovelWords('Hello World')).toBe(2);
  });

  it('中英数字混排：中文字字计数、英文按词计数', () => {
    expect(countNovelWords('Hello 世界')).toBe(3);
    expect(countNovelWords('第3章BOSS战')).toBe(5);
    expect(countNovelWords('iPhone15发布了')).toBe(4);
  });

  it('英文被标点或空白拆分为多个词', () => {
    expect(countNovelWords('abc-def')).toBe(3);
    expect(countNovelWords('Hi!')).toBe(2);
    expect(countNovelWords('a b c')).toBe(3);
  });

  it('emoji 按 Unicode 码点计 1 字（代理对不重复计数）', () => {
    expect(countNovelWords('😀')).toBe(1);
    expect(countNovelWords('😀😀')).toBe(2);
    expect(countNovelWords('你好😀')).toBe(3);
    expect(countNovelWords('😀abc😀')).toBe(3);
  });

  it('空字符串与纯空白返回 0', () => {
    expect(countNovelWords('')).toBe(0);
    expect(countNovelWords('   ')).toBe(0);
    expect(countNovelWords('\n\r\t\u3000\u200b')).toBe(0);
  });

  it('isBlankNovelText 与计数保持一致', () => {
    expect(isBlankNovelText('')).toBe(true);
    expect(isBlankNovelText(' \n\u3000 ')).toBe(true);
    expect(isBlankNovelText(' ')).toBe(true);
    expect(isBlankNovelText('一')).toBe(false);
    expect(isBlankNovelText('a')).toBe(false);
  });

  it('万字级大文本性能：1,000,000+ 字符在预算内完成', () => {
    // 每段：你(1) 好(1) world123(1) ，(1) 世(1) 界(1) ！(1) = 7 字
    const paragraph = '你好world123，世界！\n';
    const text = paragraph.repeat(70_000);
    expect(text.length).toBeGreaterThan(1_000_000);

    const startedAt = performance.now();
    const count = countNovelWords(text);
    const elapsedMs = performance.now() - startedAt;

    expect(count).toBe(7 * 70_000);
    expect(elapsedMs).toBeLessThan(3_000);
  });
});
