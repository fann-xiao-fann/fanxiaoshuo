/** 金额精度：`llm_usage_logs.estimated_cost_usd` 为 `numeric(12,6)`。 */
export const USD_SCALE = 1_000_000;

/** 将 USD 金额四舍五入到 6 位小数（与数据库 `numeric(12,6)` 对齐）。 */
export function roundUsd6(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError('USD 金额必须是有限数字');
  }
  return Math.round(value * USD_SCALE) / USD_SCALE;
}

/**
 * 按「USD / 1M tokens」单价计算估算费用，并保留 6 位小数。
 *
 * `estimated = (inputTokens * inputPricePer1m + outputTokens * outputPricePer1m) / 1_000_000`
 *
 * 所有入参必须为非负有限数字（Token 数为非负整数），否则抛出 `TypeError`，
 * 避免把脏数据写入不可篡改的用量账本。
 */
export function calculateEstimatedCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputPricePer1m: number,
  outputPricePer1m: number,
): number {
  assertTokenCount('inputTokens', inputTokens);
  assertTokenCount('outputTokens', outputTokens);
  assertPrice('inputPricePer1m', inputPricePer1m);
  assertPrice('outputPricePer1m', outputPricePer1m);

  const raw = (inputTokens * inputPricePer1m + outputTokens * outputPricePer1m) / USD_SCALE;
  return roundUsd6(raw);
}

function assertTokenCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} 必须是非负整数，收到 ${String(value)}`);
  }
}

function assertPrice(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} 必须是非负有限数字，收到 ${String(value)}`);
  }
}
