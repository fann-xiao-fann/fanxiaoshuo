import {
  EXPORT_FORMAT_META,
  type ExportFormat,
} from '@fanxiaoshuo/shared';
import type { BookRecord, ChapterRecord, VolumeRecord } from '../repositories/types.js';

/**
 * 整本导出渲染（纯函数，便于单元测试）。
 *
 * 输入必须是「已按卷 `sortOrder` 升序 + 卷内章 `sortOrder` 升序」排好序、
 * 且已剔除软删节点的数据（排序与过滤由路由层依据仓储结果完成）。
 */

export interface BookExportVolumeNode {
  readonly volume: VolumeRecord;
  readonly chapters: readonly ChapterRecord[];
}

export interface BookExportInput {
  readonly book: BookRecord;
  readonly volumes: readonly BookExportVolumeNode[];
  /** `volumeId` 为 null 的未分卷章节 */
  readonly ungroupedChapters: readonly ChapterRecord[];
}

/** 章节正文归一化：去掉行尾空白与多余空段落，保留段落间隔。 */
function normalizeChapterBody(contentText: string): string {
  return contentText
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectBlocks(input: BookExportInput, format: ExportFormat): string[] {
  const blocks: string[] = [];
  const { book } = input;

  if (format === 'md') {
    blocks.push(`# ${book.title}`);
  } else {
    blocks.push(book.title);
  }

  const synopsis = book.synopsis.trim();
  if (synopsis.length > 0) {
    blocks.push(synopsis);
  }

  const pushChapter = (chapter: ChapterRecord): void => {
    const heading =
      format === 'md' ? `### ${chapter.title}` : chapter.title;
    blocks.push(heading);
    const body = normalizeChapterBody(chapter.contentText);
    if (body.length > 0) {
      blocks.push(body);
    }
  };

  const pushVolume = (node: BookExportVolumeNode, index: number): void => {
    const heading =
      format === 'md' ? `## ${node.volume.title}` : `第 ${index + 1} 卷 ${node.volume.title}`;
    blocks.push(heading);
    for (const chapter of node.chapters) {
      pushChapter(chapter);
    }
  };

  input.volumes.forEach(pushVolume);
  input.ungroupedChapters.forEach(pushChapter);

  return blocks;
}

/** 渲染整本导出文本（TXT / Markdown），末尾统一以单个换行收尾。 */
export function renderBookExport(input: BookExportInput, format: ExportFormat): string {
  return `${collectBlocks(input, format).join('\n\n')}\n`;
}

/** RFC 5987 `ext-value` 编码（`'`、`(`、`)`、`*` 也需百分号编码）。 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 导出文件名（`<书名>.<ext>`，仅用于 RFC 5987 参数）。 */
export function buildExportFileName(title: string, format: ExportFormat): string {
  const safeTitle = title.trim().length > 0 ? title.trim() : 'book';
  return `${safeTitle}.${EXPORT_FORMAT_META[format].extension}`;
}

/**
 * 构造 `Content-Disposition`：
 * `attachment; filename="book.txt"; filename*=UTF-8''<encoded>`。
 * ASCII 回退名保证老客户端也能正确落盘，中文名经 RFC 5987 编码。
 */
export function buildContentDisposition(title: string, format: ExportFormat): string {
  const fallback = `book.${EXPORT_FORMAT_META[format].extension}`;
  const encoded = encodeRfc5987(buildExportFileName(title, format));
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
