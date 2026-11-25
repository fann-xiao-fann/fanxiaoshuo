/**
 * 统一网文字数统计（前后端唯一真相来源）。
 *
 * 采用国内网文平台通用口径：
 * 1. 忽略所有空白与不可见字符（空格、Tab、`\r`/`\n`、全角空格 `\u3000`、零宽字符等）；
 * 2. 连续的 ASCII 字母 / 数字串（`[A-Za-z0-9]+`）整体记为 1 词；
 * 3. 其余每个非空白字符（汉字、中文标点、其他符号、emoji）按 Unicode 码点各记 1 字。
 *
 * 前端用于实时展示（零延迟），服务端在写入前独立重算，绝不信任客户端上报值。
 */

/** ASCII 可打印区间内参与「按词计数」的字符（0-9 / A-Z / a-z）。 */
function isAsciiAlphanumeric(codePoint: number): boolean {
  return (
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a)
  );
}

/**
 * 是否属于需要忽略的空白 / 不可见字符。
 * 覆盖 `\s` 全部字符 + 零宽字符（`\u200b`–`\u200f`、`\u2060`）与 BOM。
 */
function isIgnorableCodePoint(codePoint: number): boolean {
  switch (codePoint) {
    // 空格、Tab、LF、VT、FF、CR
    case 0x20:
    case 0x09:
    case 0x0a:
    case 0x0b:
    case 0x0c:
    case 0x0d:
    // 不换行空格、欧甘空格、行/段分隔符、窄不换行空格、中蒙文元音分隔符
    case 0x00a0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    // 零宽字符（空格 / 非连接符 / 连接符 / 左右书写标记）、词连接符
    case 0x200b:
    case 0x200c:
    case 0x200d:
    case 0x200e:
    case 0x200f:
    case 0x2060:
    // 全角空格与 BOM
    case 0x3000:
    case 0xfeff:
      return true;
    default:
      // en quad ~ hair space（\u2000–\u200a）
      return codePoint >= 0x2000 && codePoint <= 0x200a;
  }
}

/**
 * 统计网文字数：空白与不可见字符不计，连续 ASCII 字母数字串记 1 词，
 * 其余每个非空白字符按 Unicode 码点记 1 字。
 *
 * @example
 * countNovelWords('第一章 风起'); // 5
 * countNovelWords('Hello 世界'); // 3（Hello 为 1 词，世界 2 字）
 */
export function countNovelWords(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  let count = 0;
  let inAsciiWord = false;

  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) ?? 0;
    // 代理对（emoji 等星平面字符）占 2 个 UTF-16 码元，按 1 个码点计
    index += codePoint > 0xffff ? 2 : 1;

    if (isAsciiAlphanumeric(codePoint)) {
      if (!inAsciiWord) {
        count += 1;
        inAsciiWord = true;
      }
      continue;
    }

    inAsciiWord = false;
    if (isIgnorableCodePoint(codePoint)) {
      continue;
    }
    count += 1;
  }

  return count;
}

/**
 * 是否为空内容（仅由空白 / 不可见字符组成）。
 * 服务端据此判断是否需要生成自动快照（空正文不留底）。
 */
export function isBlankNovelText(text: string): boolean {
  return countNovelWords(text) === 0;
}
