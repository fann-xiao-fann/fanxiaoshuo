import {
  bookStatusSchema,
  chapterStatusSchema,
  revisionSourceSchema,
  type BookStatus,
  type ChapterStatus,
  type RevisionSource,
} from '@fanxiaoshuo/shared';

/**
 * 书库领域辅助函数（脏数据兜底解析 + 快照备注文案）。
 *
 * 数据库中的 `status` / `source` 为 text 列（便于后续扩展），
 * 读取时统一经共享契约枚举校验，脏数据回退到安全默认值，避免接口整体 500。
 */

/** 数据库文本 → 受控书籍状态（默认 `draft`）。 */
export function parseBookStatus(value: string | null | undefined): BookStatus {
  const parsed = bookStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : 'draft';
}

/** 数据库文本 → 受控章节状态（默认 `draft`）。 */
export function parseChapterStatus(value: string | null | undefined): ChapterStatus {
  const parsed = chapterStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : 'draft';
}

/** 数据库文本 → 受控快照来源（默认 `manual`）。 */
export function parseRevisionSource(value: string | null | undefined): RevisionSource {
  const parsed = revisionSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : 'manual';
}

/** 强制覆盖前自动留底的快照备注。 */
export const FORCE_OVERWRITE_BACKUP_NOTE = '强制覆盖前自动备份';

/** 回滚前自动留底的快照备注（可二次恢复）。 */
export function restoreBackupNote(targetVersion: number): string {
  return `回滚至 v${targetVersion} 前自动备份`;
}

/** 自动节流快照的默认备注。 */
export function autoRevisionNote(intervalMinutes: number): string {
  return `编辑中自动留底（节流 ${intervalMinutes} 分钟）`;
}
