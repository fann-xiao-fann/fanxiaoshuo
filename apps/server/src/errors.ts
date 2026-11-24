import {
  API_ERROR_CODES,
  apiErrorStatus,
  type ApiErrorCode,
  type ApiErrorIssue,
} from '@fanxiaoshuo/shared';
import { ZodError } from 'zod';

/**
 * 业务错误：由路由抛出，统一错误处理器映射为 `apiErrorSchema` 响应。
 * `message` 必须已脱敏，禁止包含明文 API Key。
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: readonly ApiErrorIssue[];

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { details?: readonly ApiErrorIssue[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = apiErrorStatus(code);
    if (options.details !== undefined) {
      this.details = options.details;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** 把 ZodError 转换为字段级 400 错误。 */
export function validationErrorFromZod(error: ZodError): ApiError {
  const details: ApiErrorIssue[] = error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
  const first = details[0];
  const message = first
    ? `请求参数校验失败：${first.path ? `${first.path} - ` : ''}${first.message}`
    : '请求参数校验失败';
  return new ApiError(API_ERROR_CODES.VALIDATION_ERROR, message, { details });
}

/** 读取任意错误对象上的 PG / 驱动错误码。 */
export function readDatabaseErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const record = error as Record<string, unknown>;
  const direct = record.code;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const cause = record.cause;
  if (cause !== error && typeof cause === 'object' && cause !== null) {
    const nested = (cause as Record<string, unknown>).code;
    if (typeof nested === 'string' && nested.length > 0) {
      return nested;
    }
  }
  return null;
}

/** PG 外键约束冲突（23503）：删除被引用资源 / 写入不存在的引用。 */
export function isForeignKeyViolation(error: unknown): boolean {
  return readDatabaseErrorCode(error) === '23503';
}

/** PG 唯一约束冲突（23505）。 */
export function isUniqueViolation(error: unknown): boolean {
  return readDatabaseErrorCode(error) === '23505';
}

/** 把任意错误归一化为 `ApiError`（不泄露底层细节）。 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof ZodError) {
    return validationErrorFromZod(error);
  }
  if (isForeignKeyViolation(error)) {
    return new ApiError(
      API_ERROR_CODES.CONFLICT,
      '操作被外键约束阻止：目标资源仍被其他记录引用，请先解除引用后重试。',
      { cause: error },
    );
  }
  if (isUniqueViolation(error)) {
    return new ApiError(API_ERROR_CODES.CONFLICT, '资源已存在：唯一约束冲突。', { cause: error });
  }
  return new ApiError(API_ERROR_CODES.INTERNAL_ERROR, '服务内部错误，请查看服务端日志。', {
    cause: error,
  });
}
