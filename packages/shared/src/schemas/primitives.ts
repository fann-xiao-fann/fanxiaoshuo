import { z } from 'zod';

/** UUID v1–v8（RFC 4122/9562）校验。 */
export const uuidSchema = z.uuid();

export type Uuid = z.infer<typeof uuidSchema>;

/** ISO-8601 时间戳（允许带时区偏移，前端直接 `new Date()` 解析）。 */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

/** 仅允许 http / https 的绝对 URL（拒绝 `file:`、`javascript:` 等）。 */
export const httpUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => /^https?:\/\/[^/\s]+/i.test(value), '必须是 http(s) 绝对地址');

/** 去除首尾空白后的非空文本。 */
export function trimmedText(maxLength: number) {
  return z.string().trim().min(1).max(maxLength);
}

/** Token 数：非负整数。 */
export const tokenCountSchema = z.number().int().nonnegative();

/** 金额（USD）：非负有限数，允许高精度小数（如 0.000015）。 */
export const usdAmountSchema = z.number().nonnegative();

/** 非负整数（毫秒、上下文窗口等）。 */
export const nonNegativeIntSchema = z.number().int().nonnegative();

/** 单位价格（USD / 1M tokens）：非负，上限防止误输入天文数字。 */
export const pricePerMillionSchema = z.number().nonnegative().max(1_000_000);
