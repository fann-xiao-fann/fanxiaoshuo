import type { TiptapJson } from '@fanxiaoshuo/shared';

/**
 * TipTap（ProseMirror）文档与纯文本之间的双向转换。
 *
 * 契约约定：章节正文的纯文本以空行（`\n\n`）分隔段落，段落内换行视为软换行（`hardBreak`）。
 * 历史数据可能只落盘了 `contentText`（例如外部导入或早期记录），此时按上述规则重建文档，
 * 保证编辑器打开即可继续写作，不会因为缺少 JSON 而丢正文。
 */

/** 编辑器节点最宽松的形状（ProseMirror JSON 的局部视图）。 */
interface NodeLike {
  type?: string;
  text?: string;
  content?: NodeLike[];
  [key: string]: unknown;
}

/** 把 `\r\n` / `\r` 统一成 `\n`，避免 Windows 剪贴板内容被拆成多余段落。 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function asNode(value: unknown): NodeLike | null {
  return value !== null && typeof value === 'object' ? (value as NodeLike) : null;
}

function asChildNodes(node: NodeLike): NodeLike[] {
  return Array.isArray(node.content) ? node.content : [];
}

/** 空文档：一个空段落，保证 TipTap 有可聚焦的输入位。 */
export function createEmptyDoc(): TiptapJson {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/** 判断共享包解析出的 JSON 是否像一个可用的 ProseMirror 文档。 */
export function isTiptapDocument(value: TiptapJson | null | undefined): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  const node = asNode(value);
  if (node === null) {
    return false;
  }
  return node.type === 'doc' || Array.isArray(node.content);
}

function blockToNodes(block: string): NodeLike {
  const lines = block.split('\n');
  const content: NodeLike[] = [];
  lines.forEach((line, index) => {
    if (index > 0) {
      content.push({ type: 'hardBreak' });
    }
    if (line.length > 0) {
      content.push({ type: 'text', text: line });
    }
  });
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
}

/** 纯文本 → TipTap 文档：按空行切分段落，段内换行转为 `hardBreak`。 */
export function plainTextToTiptapDoc(text: string): TiptapJson {
  const normalized = normalizeNewlines(text);
  if (normalized.trim().length === 0) {
    return createEmptyDoc();
  }
  const blocks = normalized.split(/\n{2,}/);
  return {
    type: 'doc',
    content: blocks.map((block) => blockToNodes(block)),
  };
}

/** 收集单个节点的行内文本（`hardBreak` 记作 `\n`）。 */
function inlineText(node: NodeLike): string {
  if (typeof node.text === 'string') {
    return node.text;
  }
  if (node.type === 'hardBreak') {
    return '\n';
  }
  const children = asChildNodes(node);
  if (children.length === 0) {
    return '';
  }
  return children.map((child) => inlineText(child)).join('');
}

/** 块级节点 → 一段纯文本（列表项按行拼接）。 */
function blockText(node: NodeLike): string {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return inlineText(node);
    case 'bulletList':
    case 'orderedList':
      return asChildNodes(node)
        .map((item) => blockText(item))
        .filter((line) => line.length > 0)
        .join('\n');
    case 'listItem':
    case 'blockquote':
      return asChildNodes(node)
        .map((child) => blockText(child))
        .join('\n');
    default:
      return inlineText(node);
  }
}

/** TipTap 文档 → 纯文本：块级节点之间以空行分隔。 */
export function tiptapDocToPlainText(doc: TiptapJson | null | undefined): string {
  if (doc === null || doc === undefined) {
    return '';
  }
  const root = asNode(doc);
  if (root === null) {
    return '';
  }
  const blocks = asChildNodes(root);
  const lines = blocks.map((block) => blockText(block));
  return lines.join('\n\n');
}

/**
 * 解析章节正文的编辑器初始内容：
 * 优先使用结构化 `contentJson`，缺失（或形状非法）时由纯文本重建。
 */
export function resolveEditorContent(chapter: {
  contentJson: TiptapJson | null;
  contentText: string;
}): TiptapJson {
  if (isTiptapDocument(chapter.contentJson)) {
    return chapter.contentJson ?? createEmptyDoc();
  }
  return plainTextToTiptapDoc(chapter.contentText);
}

/** 编辑器文档是否等同空稿（用于「空章节」友好提示与快照防抖判断）。 */
export function isEmptyDoc(doc: TiptapJson | null | undefined): boolean {
  return tiptapDocToPlainText(doc).trim().length === 0;
}
