import { z } from 'zod';
import { apiErrorCodeSchema } from '../errors.js';
import {
  isoDateTimeSchema,
  nonNegativeIntSchema,
  pricePerMillionSchema,
  tokenCountSchema,
  trimmedText,
  usdAmountSchema,
  uuidSchema,
} from './primitives.js';

/** 模型单价与元信息：USD / 1M tokens 口径（界面需标注清晰）。 */
export const modelDtoSchema = z.strictObject({
  id: uuidSchema,
  providerId: uuidSchema,
  /** 上游模型标识，如 `gpt-4o-mini`、`deepseek-chat` */
  modelId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  /** 上下文窗口（tokens），未知时为 null */
  contextWindow: nonNegativeIntSchema.nullable(),
  inputPricePer1M: pricePerMillionSchema,
  outputPricePer1M: pricePerMillionSchema,
  isEnabled: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type ModelDto = z.infer<typeof modelDtoSchema>;

/** 模型轻量摘要（角色路由面板展示绑定模型）。 */
export const modelSummarySchema = z.strictObject({
  id: uuidSchema,
  modelId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  contextWindow: nonNegativeIntSchema.nullable(),
  inputPricePer1M: pricePerMillionSchema,
  outputPricePer1M: pricePerMillionSchema,
  isEnabled: z.boolean(),
});

export type ModelSummary = z.infer<typeof modelSummarySchema>;

/** `POST /api/v1/models` 请求体。 */
export const createModelSchema = z
  .strictObject({
    providerId: uuidSchema,
    modelId: trimmedText(128),
    displayName: trimmedText(128),
    contextWindow: nonNegativeIntSchema.max(10_000_000).nullable().optional(),
    inputPricePer1M: pricePerMillionSchema.default(0),
    outputPricePer1M: pricePerMillionSchema.default(0),
    isEnabled: z.boolean().default(true),
  })
  .describe('在指定供应商下注册模型');

export type CreateModelInput = z.infer<typeof createModelSchema>;
export type CreateModelInputPayload = z.input<typeof createModelSchema>;

/** `PATCH /api/v1/models/:id` 请求体（`providerId` 不允许变更）。 */
export const updateModelSchema = z
  .strictObject({
    modelId: trimmedText(128).optional(),
    displayName: trimmedText(128).optional(),
    contextWindow: nonNegativeIntSchema.max(10_000_000).nullable().optional(),
    inputPricePer1M: pricePerMillionSchema.optional(),
    outputPricePer1M: pricePerMillionSchema.optional(),
    isEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: '至少需要提供一个待更新字段',
  })
  .describe('更新模型请求');

export type UpdateModelInput = z.infer<typeof updateModelSchema>;
export type UpdateModelInputPayload = z.input<typeof updateModelSchema>;

/** 模型列表响应。 */
export const modelListResponseSchema = z.strictObject({
  items: z.array(modelDtoSchema),
  total: z.number().int().nonnegative(),
});

export type ModelListResponse = z.infer<typeof modelListResponseSchema>;

/**
 * `POST /api/v1/models/:id/test` 响应（一键测通）。
 * 成功时回传预览/延迟/Token/费用；失败时回传脱敏错误分类，绝不回传明文 Key。
 */
export const testModelResponseSchema = z
  .strictObject({
    success: z.boolean(),
    /** 上游回复文本预览（截断），失败时为 null */
    replyPreview: z.string().max(2000).nullable(),
    latencyMs: nonNegativeIntSchema,
    inputTokens: tokenCountSchema,
    outputTokens: tokenCountSchema,
    estimatedCostUsd: usdAmountSchema,
    errorCode: apiErrorCodeSchema.nullable(),
    /** 脱敏后的错误摘要 */
    errorMessage: z.string().max(2000).nullable(),
    /** 本次测通落盘的用量日志 ID（便于在用量页核对） */
    usageLogId: uuidSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.success ? value.errorCode === null && value.errorMessage === null : value.errorCode !== null,
    { message: 'success 为 true 时不得携带错误码；为 false 时必须给出错误码' },
  )
  .describe('模型连通性测试结果');

export type TestModelResponse = z.infer<typeof testModelResponseSchema>;
