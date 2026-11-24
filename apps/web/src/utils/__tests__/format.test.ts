import { describe, expect, it } from 'vitest';
import {
  formatCompactInteger,
  formatContextWindow,
  formatInteger,
  formatPricePer1M,
  formatRoleLabel,
  formatUsd,
  truncateMiddle,
} from '@/utils/format';

describe('格式化工具', () => {
  it('Token 数按千分位与紧凑格式展示', () => {
    expect(formatInteger(1234567)).toBe('1,234,567');
    expect(formatInteger(null)).toBe('—');
    expect(formatCompactInteger(950)).toBe('950');
    expect(formatCompactInteger(1500)).toBe('1.5K');
    expect(formatCompactInteger(2_500_000)).toBe('2.5M');
  });

  it('USD 费用保留足够精度并去除末尾 0', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.000015)).toBe('$0.000015');
    expect(formatUsd(12.5)).toBe('$12.5');
    expect(formatUsd(null)).toBe('—');
  });

  it('单价、上下文窗口与角色名可读化', () => {
    expect(formatPricePer1M(0)).toBe('$0 / 1M');
    expect(formatPricePer1M(0.5)).toBe('$0.5 / 1M');
    expect(formatContextWindow(128000)).toBe('128K');
    expect(formatContextWindow(null)).toBe('—');
    expect(formatRoleLabel('writer')).toBe('执笔写手');
    expect(formatRoleLabel(null)).toBe('—');
  });

  it('超长文本中段截断', () => {
    const text = 'provider-name/very-long-model-identifier-2025';
    expect(truncateMiddle(text, 20)).toContain('…');
    expect(truncateMiddle('short', 20)).toBe('short');
  });
});
