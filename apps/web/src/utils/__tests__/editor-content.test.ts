import { describe, expect, it } from 'vitest';
import {
  createEmptyDoc,
  isEmptyDoc,
  normalizeNewlines,
  plainTextToTiptapDoc,
  resolveEditorContent,
  tiptapDocToPlainText,
} from '@/utils/editor-content';

interface DocNode {
  type?: string;
  text?: string;
  content?: DocNode[];
}

function paragraphs(doc: { type?: string; content?: unknown }): DocNode[] {
  return (doc.content as DocNode[] | undefined) ?? [];
}

describe('normalizeNewlines', () => {
  it('统一 CRLF / CR 为 LF', () => {
    expect(normalizeNewlines('a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('plainTextToTiptapDoc', () => {
  it('按空行拆分为多个段落', () => {
    const doc = plainTextToTiptapDoc('第一段正文\n\n第二段正文\n\n第三段');
    const blocks = paragraphs(doc);

    expect(doc.type).toBe('doc');
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.type).toBe('paragraph');
    expect(blocks[0]?.content?.[0]?.text).toBe('第一段正文');
    expect(blocks[2]?.content?.[0]?.text).toBe('第三段');
  });

  it('段落内单换行转为 hardBreak 节点', () => {
    const doc = plainTextToTiptapDoc('上句\n下句');
    const block = paragraphs(doc)[0];

    expect(block?.content).toEqual([
      { type: 'text', text: '上句' },
      { type: 'hardBreak' },
      { type: 'text', text: '下句' },
    ]);
  });

  it('空文本生成仅含一个空段落的可编辑文档', () => {
    expect(plainTextToTiptapDoc('')).toEqual(createEmptyDoc());
    expect(plainTextToTiptapDoc('   \n\n  ')).toEqual(createEmptyDoc());
  });

  it('Windows 换行不会被拆成多余空段落', () => {
    const doc = plainTextToTiptapDoc('第一段\r\n\r\n第二段');
    expect(paragraphs(doc)).toHaveLength(2);
  });
});

describe('tiptapDocToPlainText', () => {
  it('段落之间以空行拼接', () => {
    const doc = plainTextToTiptapDoc('第一段\n\n第二段\n\n第三段');
    expect(tiptapDocToPlainText(doc)).toBe('第一段\n\n第二段\n\n第三段');
  });

  it('hardBreak 还原为单换行', () => {
    const doc = plainTextToTiptapDoc('上句\n下句');
    expect(tiptapDocToPlainText(doc)).toBe('上句\n下句');
  });

  it('兼容标题 / 列表等额外节点', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: '标题' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '一' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '二' }] }] },
          ],
        },
      ],
    };
    expect(tiptapDocToPlainText(doc)).toBe('标题\n\n一\n二');
  });

  it('空值安全返回空字符串', () => {
    expect(tiptapDocToPlainText(null)).toBe('');
    expect(tiptapDocToPlainText(undefined)).toBe('');
    expect(tiptapDocToPlainText({})).toBe('');
  });

  it('纯文本 → JSON → 纯文本可无损往返', () => {
    const text = '第一章 风起\n\n他说：“走吧。”\n\nHello 世界 42';
    expect(tiptapDocToPlainText(plainTextToTiptapDoc(text))).toBe(text);
  });
});

describe('resolveEditorContent', () => {
  it('优先使用结构化 contentJson', () => {
    const contentJson = plainTextToTiptapDoc('结构化正文');
    const resolved = resolveEditorContent({ contentJson, contentText: '被忽略的纯文本' });
    expect(resolved).toEqual(contentJson);
  });

  it('缺少 contentJson 时按纯文本重建段落', () => {
    const resolved = resolveEditorContent({ contentJson: null, contentText: '甲\n\n乙' });
    expect(tiptapDocToPlainText(resolved)).toBe('甲\n\n乙');
  });

  it('contentJson 形状非法时回退到纯文本', () => {
    const resolved = resolveEditorContent({ contentJson: { foo: 'bar' }, contentText: '回退正文' });
    expect(tiptapDocToPlainText(resolved)).toBe('回退正文');
  });
});

describe('isEmptyDoc', () => {
  it('空段落文档视为空稿', () => {
    expect(isEmptyDoc(createEmptyDoc())).toBe(true);
    expect(isEmptyDoc(plainTextToTiptapDoc('   '))).toBe(true);
    expect(isEmptyDoc(plainTextToTiptapDoc('有内容'))).toBe(false);
  });
});
