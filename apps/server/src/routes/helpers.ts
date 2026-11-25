import { API_ERROR_CODES, uuidSchema } from '@fanxiaoshuo/shared';
import { toModelGatewayError, sanitizeErrorMessage } from '@fanxiaoshuo/agents';
import { z, type ZodType } from 'zod';
import { ApiError, validationErrorFromZod } from '../errors.js';

/** 把网关异常归一化为标准 `ApiError`（错误文本已脱敏，绝不泄露明文 Key）。 */
export function toGatewayApiError(error: unknown, secrets: readonly string[] = []): ApiError {
  const gatewayError = toModelGatewayError(error, secrets);
  return new ApiError(gatewayError.code, sanitizeErrorMessage(gatewayError, secrets), {
    cause: error,
  });
}

/** 使用共享契约 Schema 校验任意外部输入，失败时抛出统一 400 错误。 */
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw validationErrorFromZod(result.error);
  }
  return result.data;
}

function invalidParam(field: string, message: string): ApiError {
  return new ApiError(API_ERROR_CODES.VALIDATION_ERROR, message, {
    details: [{ path: field, message }],
  });
}

/** 读取并校验路径参数 `:id`（UUID）。 */
export function parseIdParam(params: unknown, key = 'id'): string {
  const raw = params as Record<string, unknown> | undefined;
  const value = raw?.[key];
  if (typeof value !== 'string') {
    throw invalidParam(key, `路径参数 ${key} 必须是 UUID`);
  }
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidParam(key, `路径参数 ${key} 必须是合法 UUID`);
  }
  return parsed.data;
}

const jobIdParamsSchema = z.object({
  jobId: z.string().trim().min(1).max(128),
});

/** 读取并校验 BullMQ 任务 ID 路径参数。 */
export function parseJobIdParam(params: unknown): string {
  const raw = params as Record<string, unknown> | undefined;
  const parsed = jobIdParamsSchema.safeParse({ jobId: raw?.['jobId'] });
  if (!parsed.success) {
    throw validationErrorFromZod(parsed.error);
  }
  return parsed.data.jobId;
}

/** 查询串中的可选 UUID（空字符串视为未传）。 */
export function parseOptionalUuidQuery(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidParam(field, `${field} 必须是合法 UUID`);
  }
  return parsed.data;
}

/**
 * 查询串布尔开关（如 `?permanent=true`）。
 * 仅接受缺省 / `true` / `false`（兼容 Fastify 解析出的原生 boolean），其余一律 400。
 */
export function parseBooleanQuery(query: unknown, field: string): boolean {
  const raw = (query as Record<string, unknown> | undefined)?.[field];
  if (raw === undefined || raw === null || raw === '' || raw === false || raw === 'false') {
    return false;
  }
  if (raw === true || raw === 'true') {
    return true;
  }
  throw invalidParam(field, `${field} 只能是 true 或 false`);
}
