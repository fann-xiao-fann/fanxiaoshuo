import { z } from 'zod';
import { agentRoleSchema } from '../constants/agent-roles.js';
import { PAGINATION } from '../constants/runtime.js';
import { apiErrorCodeSchema } from '../errors.js';
import {
  isoDateTimeSchema,
  nonNegativeIntSchema,
  tokenCountSchema,
  trimmedText,
  usdAmountSchema,
  uuidSchema,
} from './primitives.js';

/** 用量日志状态。 */
export const usageLogStatusSchema = z.enum(['success', 'error']);

export type UsageLogStatus = z.infer<typeof usageLogStatusSchema>;

/**
 * 用量日志 DTO（append-only 审计流水，对外只读）。
 * `modelRef` 为 `provider/modelId` 快照，避免模型删除后历史账本失真。
 */
export const usageLogDtoSchema = z.strictObject({
  id: uuidSchema,
  role: agentRoleSchema.nullable(),
  providerId: uuidSchema.nullable(),
  modelRef: z.string().min(1).max(256).nullable(),
  /** 业务场景，如 `connectivity-test` / `smoke-job` / `chapter-write` */
  scene: z.string().min(1).max(64),
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  estimatedCostUsd: usdAmountSchema,
  latencyMs: nonNegativeIntSchema.nullable(),
  status: usageLogStatusSchema,
  errorCode: apiErrorCodeSchema.nullable(),
  /** 已脱敏错误摘要，禁止包含明文 Key */
  errorMessage: z.string().max(2000).nullable(),
  createdAt: isoDateTimeSchema,
});

export type UsageLogDto = z.infer<typeof usageLogDtoSchema>;

/** 空字符串查询参数视为「未传」，便于 Fastify query 直接透传。 */
const optionalQueryNumber = <S extends z.ZodType>(inner: S) =>
  z.preprocess((value) => (value === '' || value === null ? undefined : value), inner);

/** `GET /api/v1/usage-logs` 查询串（数值允许字符串形式，自动强制转换）。 */
export const usageLogsQuerySchema = z
  .object({
    page: optionalQueryNumber(
      z.coerce.number().int().min(1).default(PAGINATION.defaultPage),
    ),
    pageSize: optionalQueryNumber(
      z.coerce
        .number()
        .int()
        .min(1)
        .max(PAGINATION.maxPageSize)
        .default(PAGINATION.defaultPageSize),
    ),
    status: usageLogStatusSchema.optional(),
    role: agentRoleSchema.optional(),
    scene: trimmedText(64).optional(),
    /** 起始时间（含） */
    from: isoDateTimeSchema.optional(),
    /** 结束时间（含） */
    to: isoDateTimeSchema.optional(),
  })
  .refine(
    (value) =>
      value.from === undefined || value.to === undefined
        ? true
        : new Date(value.from).getTime() <= new Date(value.to).getTime(),
    { message: 'from 不能晚于 to', path: ['from'] },
  )
  .describe('用量日志分页查询');

export type UsageLogsQuery = z.infer<typeof usageLogsQuerySchema>;
export type UsageLogsQueryPayload = z.input<typeof usageLogsQuerySchema>;

/** 筛选区间内的聚合汇总，供工作台汇总卡片展示。 */
export const usageSummarySchema = z.strictObject({
  totalRequests: nonNegativeIntSchema,
  successRequests: nonNegativeIntSchema,
  errorRequests: nonNegativeIntSchema,
  totalInputTokens: nonNegativeIntSchema,
  totalOutputTokens: nonNegativeIntSchema,
  totalCostUsd: usdAmountSchema,
});

export type UsageSummary = z.infer<typeof usageSummarySchema>;

/** `GET /api/v1/usage-logs` 响应：时间倒序明细 + 区间汇总。 */
export const usageLogsResponseSchema = z.strictObject({
  items: z.array(usageLogDtoSchema),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: nonNegativeIntSchema,
  totalPages: nonNegativeIntSchema,
  summary: usageSummarySchema,
  from: isoDateTimeSchema.nullable(),
  to: isoDateTimeSchema.nullable(),
});

export type UsageLogsResponse = z.infer<typeof usageLogsResponseSchema>;
