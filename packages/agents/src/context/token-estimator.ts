/**
 * 确定性 Token 估算与预算截断工具。
 *
 * 设计目标：
 * 1. **纯函数**：相同输入永远得到相同输出，便于单测与「预览所见 = 生成所用」的一致性验收。
 * 2. **零重依赖**：不引入 WASM tokenizer（体积大、模型绑定强、Windows 下加载不稳定），
 *    只用字符类别加权近似网文场景（以中文正文为主）的 token 数。
 * 3. **保守偏大**：宁可略微高估，也不要低估后把上游上下文窗口打爆。
 *
 * 权重口径（与 `openspec/changes/book-bible-and-ai-writer/design.md` 一致）：
 * - 空白字符：不计费
 * - CJK 表意文字 / 中文标点 / 全角符号：约 `1.0` token / 字
 * - 拉丁字母与数字词：约 `1.3` token / 词
 * - 其余可见符号（英文标点、箭头、emoji 等）：约 `0.5` token / 字符
 */

/** 预算截断结果。 */
export interface TokenBudgetTruncation {
  /** 截断后的文本（未截断时为原文） */
  readonly text: string;
  /** 是否发生了截断 */
  readonly truncated: boolean;
  /** 截断后文本的估算 Token 数 */
  readonly estimatedTokens: number;
}

/** CJK 表意文字 / 中文标点 / 全角符号（含部首与兼容表意文字）。 */
const CJK_CHAR_PATTERN =
  /[\u2e80-\u2eff\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/** 拉丁字母与阿拉伯数字（组成「词」的基本单位）。 */
const WORD_CHAR_PATTERN = /[A-Za-z0-9]/;

/** 任意空白字符（空格 / 换行 / 制表符 / 全角空格在进入此分支前已被 CJK 捕获）。 */
const WHITESPACE_PATTERN = /\s/;

/** 中文正文的单字权重。 */
const CJK_TOKEN_WEIGHT = 1.0;

/** 拉丁 / 数字单词的单词语权重。 */
const WORD_TOKEN_WEIGHT = 1.3;

/** 其余可见符号的单字符权重。 */
const SYMBOL_TOKEN_WEIGHT = 0.5;

/** 截断标记。 */
const ELLIPSIS = '…';

/**
 * 估算一段文本的 Token 数。
 *
 * 空串或纯空白串返回 `0`；其余情况按字符类别加权后向上取整，返回值恒为非负整数。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cjkCount = 0;
  let wordCount = 0;
  let symbolCount = 0;
  let insideWord = false;

  // 按码点迭代，避免把 emoji 等代理对拆成两个字符重复计费。
  for (const char of text) {
    if (WHITESPACE_PATTERN.test(char)) {
      insideWord = false;
      continue;
    }
    if (CJK_CHAR_PATTERN.test(char)) {
      cjkCount += 1;
      insideWord = false;
      continue;
    }
    if (WORD_CHAR_PATTERN.test(char)) {
      if (!insideWord) {
        wordCount += 1;
        insideWord = true;
      }
      continue;
    }
    symbolCount += 1;
    insideWord = false;
  }

  if (cjkCount === 0 && wordCount === 0 && symbolCount === 0) return 0;

  const weighted =
    cjkCount * CJK_TOKEN_WEIGHT + wordCount * WORD_TOKEN_WEIGHT + symbolCount * SYMBOL_TOKEN_WEIGHT;

  return Math.max(0, Math.ceil(weighted));
}

/**
 * 在 Token 预算内截断文本。
 *
 * - `mode = 'end'`（默认）：保留开头、截断尾部并追加 `…`，用于大纲、摘要等「从头读」的内容。
 * - `mode = 'start'`：保留结尾、截断头部并前置 `…`，用于上一章尾部衔接与当前章最新正文。
 *
 * 原文已在预算内时原样返回且 `truncated: false`；`maxTokens <= 0` 时返回空串。
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
  mode: 'end' | 'start' = 'end',
): TokenBudgetTruncation {
  const budget = Number.isFinite(maxTokens) ? Math.floor(maxTokens) : 0;
  if (budget <= 0) {
    return { text: '', truncated: text.length > 0, estimatedTokens: 0 };
  }

  const estimatedTokens = estimateTokens(text);
  if (estimatedTokens <= budget) {
    return { text, truncated: false, estimatedTokens };
  }

  const chars = Array.from(text);

  const build = (keep: number): string => {
    if (keep <= 0) return ELLIPSIS;
    if (mode === 'start') return `${ELLIPSIS}${chars.slice(chars.length - keep).join('')}`;
    return `${chars.slice(0, keep).join('')}${ELLIPSIS}`;
  };

  // 二分查找「加入省略号后仍在预算内」的最大保留长度：估算值随长度单调不减。
  let low = 0;
  let high = chars.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateTokens(build(middle)) <= budget) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const truncatedText = build(best);
  return {
    text: truncatedText,
    truncated: true,
    estimatedTokens: estimateTokens(truncatedText),
  };
}
