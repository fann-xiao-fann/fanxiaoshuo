import { resolveAgentRoleLabel } from '@fanxiaoshuo/shared';

const numberFormatter = new Intl.NumberFormat('zh-CN');

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 千分位整数（Token、请求数等）。 */
export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return numberFormatter.format(Math.round(value));
}

/** Token 数简写：1.2K / 3.4M，用于紧凑卡片。 */
export function formatCompactInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  const abs = Math.abs(value);
  if (abs < 1_000) {
    return String(Math.round(value));
  }
  if (abs < 1_000_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

/**
 * USD 金额：保留最多 `maxDigits` 位小数并去除末尾 0。
 * 单价常为 0.000015 级别，固定 2 位会全部显示为 $0.00，因此需要更高精度。
 */
export function formatUsd(value: number | null | undefined, maxDigits = 6): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  if (value === 0) {
    return '$0';
  }
  const digits = Math.min(Math.max(maxDigits, 2), 12);
  const fixed = value.toFixed(digits);
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return `$${trimmed === '' || trimmed === '-0' ? '0' : trimmed}`;
}

/** 单价（USD / 1M tokens）。 */
export function formatPricePer1M(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  if (value === 0) {
    return '$0 / 1M';
  }
  const fixed = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return `$${fixed} / 1M`;
}

/** 延迟毫秒数。 */
export function formatLatency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  if (value < 1_000) {
    return `${Math.round(value)} ms`;
  }
  return `${(value / 1_000).toFixed(2)} s`;
}

/** 任务耗时（可能为 null）。 */
export function formatDuration(value: number | null | undefined): string {
  return formatLatency(value);
}

/** 日期时间；非法输入回退为 `—`。 */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return dateTimeFormatter.format(date);
}

/** 仅时分秒（时间线使用）。 */
export function formatTimeOnly(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

/** 上下文窗口：128K 形式。 */
export function formatContextWindow(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) {
    return '—';
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  return String(value);
}

/** 角色中文名：复用共享包的唯一文案来源，未知角色原样回退。 */
export function formatRoleLabel(role: string | null | undefined): string {
  if (role === null || role === undefined || role === '') {
    return '—';
  }
  return resolveAgentRoleLabel(role);
}

/** 文本截断（保留首尾以便识别模型名）。 */
export function truncateMiddle(value: string, maxLength = 48): string {
  if (value.length <= maxLength) {
    return value;
  }
  const head = Math.ceil((maxLength - 1) / 2);
  const tail = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/**
 * 网文字数格式化：中文语境下「1.2 万字」「12.3 万字」比千分位更易读。
 * 小于 1 万保留原样数字 + 「字」。
 */
export function formatWordCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  const words = Math.max(0, Math.round(value));
  if (words < 10_000) {
    return `${numberFormatter.format(words)} 字`;
  }
  const scaled = words / 10_000;
  const digits = scaled >= 100 ? 0 : 1;
  return `${scaled.toFixed(digits).replace(/\.0$/, '')} 万字`;
}

/** 写作进度百分比（0–100，用于目标字数进度条）。 */
export function formatProgressPercent(value: number, target: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(target) || target <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((value / target) * 100)));
}
