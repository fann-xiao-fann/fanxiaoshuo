import { z } from 'zod';
import { providerProtocolSchema } from '../constants/provider-protocols.js';
import { isoDateTimeSchema, httpUrlSchema, trimmedText, uuidSchema } from './primitives.js';

/**
 * Provider 响应 DTO。
 *
 * ⚠️ 契约红线：**只允许** 出现 `apiKeyMask`，任何 `apiKey` / `apiKeyEncrypted` 字段
 * 都不得出现在对外响应中。此处使用 strictObject，使携带明文密钥的对象在解析时直接失败。
 */
export const providerDtoSchema = z
  .strictObject({
    id: uuidSchema,
    name: z.string().min(1).max(64),
    protocol: providerProtocolSchema,
    baseUrl: httpUrlSchema,
    /** 脱敏指纹，如 `sk-***9f2a`；绝不包含明文 */
    apiKeyMask: z.string().min(1).max(64),
    isEnabled: z.boolean(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .describe('LLM 供应商对外 DTO（密钥仅脱敏指纹）');

export type ProviderDto = z.infer<typeof providerDtoSchema>;

/** 供应商轻量摘要：角色路由面板展示「所属供应商状态」时使用。 */
export const providerSummarySchema = z.strictObject({
  id: uuidSchema,
  name: z.string().min(1).max(64),
  protocol: providerProtocolSchema,
  isEnabled: z.boolean(),
});

export type ProviderSummary = z.infer<typeof providerSummarySchema>;

/** `POST /api/v1/providers` 请求体。 */
export const createProviderSchema = z
  .strictObject({
    name: trimmedText(64),
    protocol: providerProtocolSchema,
    baseUrl: httpUrlSchema,
    /** 明文 API Key，仅用于入站；落库前由服务端 AES-256-GCM 加密 */
    apiKey: z.string().trim().min(1).max(512),
    isEnabled: z.boolean().default(true),
  })
  .describe('新增供应商请求');

export type CreateProviderInput = z.infer<typeof createProviderSchema>;
/** 解析前的输入类型（`isEnabled` 可省略）。 */
export type CreateProviderInputPayload = z.input<typeof createProviderSchema>;

/**
 * `PATCH /api/v1/providers/:id` 请求体。
 * `apiKey` 留空（`''` 或省略）表示保留原密钥；提供值时覆盖。
 */
export const updateProviderSchema = z
  .strictObject({
    name: trimmedText(64).optional(),
    protocol: providerProtocolSchema.optional(),
    baseUrl: httpUrlSchema.optional(),
    apiKey: z.string().trim().max(512).optional(),
    isEnabled: z.boolean().optional(),
  })
  .refine(
    (value) =>
      Object.entries(value).some(([key, field]) => key !== 'apiKey' && field !== undefined) ||
      (typeof value.apiKey === 'string' && value.apiKey.length > 0),
    { message: '至少需要提供一个待更新字段', path: [] },
  )
  .describe('更新供应商请求（apiKey 留空则保留原密钥）');

export type UpdateProviderInput = z.infer<typeof updateProviderSchema>;
export type UpdateProviderInputPayload = z.input<typeof updateProviderSchema>;

/** 供应商列表响应。 */
export const providerListResponseSchema = z.strictObject({
  items: z.array(providerDtoSchema),
  total: z.number().int().nonnegative(),
});

export type ProviderListResponse = z.infer<typeof providerListResponseSchema>;
