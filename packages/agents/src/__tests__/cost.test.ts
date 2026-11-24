import { describe, expect, it } from 'vitest';
import { calculateEstimatedCostUsd, roundUsd6 } from '../gateway/cost.js';

describe('calculateEstimatedCostUsd', () => {
  it('按 USD / 1M tokens 单价精确计算并保留 6 位小数', () => {
    expect(calculateEstimatedCostUsd(1_000, 500, 0.15, 0.6)).toBe(0.00045);
    expect(calculateEstimatedCostUsd(123_456, 789, 0.123456, 0.654321)).toBe(0.015758);
  });

  it('对 0 token / 0 单价返回 0', () => {
    expect(calculateEstimatedCostUsd(0, 0, 12.5, 30)).toBe(0);
    expect(calculateEstimatedCostUsd(100, 200, 0, 0)).toBe(0);
  });

  it('对浮点误差做 6 位小数四舍五入', () => {
    // 333333 * 0.3 / 1M = 0.09999989999999999
    expect(calculateEstimatedCostUsd(333_333, 0, 0.3, 0)).toBe(0.1);
    expect(roundUsd6(0.0000004)).toBe(0);
    expect(roundUsd6(0.0000005)).toBe(0.000001);
  });

  it('拒绝负数 / 非整数 / 非有限数字，避免脏数据写入账本', () => {
    expect(() => calculateEstimatedCostUsd(-1, 0, 1, 1)).toThrow(TypeError);
    expect(() => calculateEstimatedCostUsd(1.5, 0, 1, 1)).toThrow(TypeError);
    expect(() => calculateEstimatedCostUsd(0, 0, Number.NaN, 1)).toThrow(TypeError);
    expect(() => calculateEstimatedCostUsd(0, 0, -0.1, 1)).toThrow(TypeError);
  });
});
