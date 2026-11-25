import type { ChapterSaveStatus } from '@/stores/book-workspace';

/** 保存徽章的语义色调（映射到全局 CSS 类 `fx-save-badge--<tone>`）。 */
export type SaveBadgeTone = 'idle' | 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface SaveBadgeState {
  label: string;
  tone: SaveBadgeTone;
}

function timeLabel(value: string | null): string {
  if (value === null || value === '') {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 编辑器保存状态 → 徽章文案与色调。
 *
 * 抽成纯函数便于单测锁定「未保存 / 保存中 / 已保存 + 时间 / 冲突 / 失败」五种关键状态的文案，
 * 避免文案与状态机在组件里各写一份。
 */
export function describeSaveStatus(
  status: ChapterSaveStatus,
  lastSavedAt: string | null,
): SaveBadgeState {
  switch (status) {
    case 'dirty':
      return { label: '未保存', tone: 'dirty' };
    case 'saving':
      return { label: '保存中…', tone: 'saving' };
    case 'saved': {
      const time = timeLabel(lastSavedAt);
      return { label: time.length > 0 ? `已保存 ${time}` : '已保存', tone: 'saved' };
    }
    case 'error':
      return { label: '保存失败', tone: 'error' };
    case 'conflict':
      return { label: '版本冲突', tone: 'conflict' };
    default:
      return { label: '无改动', tone: 'idle' };
  }
}
