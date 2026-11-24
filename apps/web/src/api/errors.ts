import {
  apiErrorSchema,
  type ApiError,
  type ApiErrorCode,
  type ApiErrorIssue,
} from '@fanxiaoshuo/shared';

/** 前端侧扩展错误码：网络不可达与响应不符合契约。 */
export type FrontendErrorCode = ApiErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE';

export interface ApiClientErrorOptions {
  code: FrontendErrorCode;
  status: number;
  details?: ApiErrorIssue[];
  requestId?: string;
  cause?: unknown;
}

/**
 * 强类型 API 错误：统一承载后端 `ApiError` 契约与前端网络错误，
 * 视图层据此展示冲突提示（如 `MODEL_IN_USE`）或降级文案。
 */
export class ApiClientError extends Error {
  readonly code: FrontendErrorCode;
  readonly status: number;
  readonly details: ApiErrorIssue[] | undefined;
  readonly requestId: string | undefined;
  override readonly cause: unknown;

  constructor(message: string, options: ApiClientErrorOptions) {
    super(message);
    this.name = 'ApiClientError';
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
    this.requestId = options.requestId;
    this.cause = options.cause;
  }

  get isNetworkError(): boolean {
    return this.code === 'NETWORK_ERROR';
  }

  get isConflict(): boolean {
    return this.code === 'CONFLICT' || this.code === 'MODEL_IN_USE';
  }
}

export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError;
}

/** HTTP 状态码兜底映射（响应体不符合 `ApiError` 契约时使用）。 */
export function fallbackErrorCode(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'UPSTREAM_RATE_LIMIT';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    case 504:
      return 'UPSTREAM_TIMEOUT';
    default:
      return 'INTERNAL_ERROR';
  }
}

function readFallbackMessage(body: unknown, status: number): string {
  if (typeof body === 'string' && body.trim().length > 0) {
    return body.trim().slice(0, 500);
  }
  if (body !== null && typeof body === 'object') {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim().slice(0, 500);
    }
  }
  return `请求失败（HTTP ${status}）`;
}

/**
 * 将非 2xx 响应体解析为 `ApiClientError`。
 * 优先严格解析共享 `apiErrorSchema`；解析失败时按 HTTP 状态码兜底，绝不抛二次异常。
 */
export function normalizeApiError(
  status: number,
  body: unknown,
  fallbackMessage?: string,
): ApiClientError {
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) {
    const apiError: ApiError = parsed.data;
    return new ApiClientError(apiError.message, {
      code: apiError.code,
      status,
      details: apiError.details,
      requestId: apiError.requestId,
    });
  }
  return new ApiClientError(fallbackMessage ?? readFallbackMessage(body, status), {
    code: fallbackErrorCode(status),
    status,
  });
}

/** 网络层异常（断网、DNS、代理未启动、请求被中止）。 */
export function networkError(cause: unknown): ApiClientError {
  const detail =
    cause instanceof Error && cause.message.length > 0 ? `（${cause.message}）` : '';
  return new ApiClientError(`无法连接后端服务${detail}，请确认 API 与 Docker 依赖已启动。`, {
    code: 'NETWORK_ERROR',
    status: 0,
    cause,
  });
}

/** 响应体未通过 Zod 契约校验。 */
export function invalidResponseError(message: string, cause?: unknown): ApiClientError {
  return new ApiClientError(`接口响应不符合契约：${message}`, {
    code: 'INVALID_RESPONSE',
    status: 0,
    cause,
  });
}

/** 视图层统一错误文案（拉平 unknown）。 */
export function describeError(error: unknown): string {
  if (isApiClientError(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** 表单字段级错误（由共享 Zod Schema 的 issues 投影而来）。 */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!isApiClientError(error) || error.details === undefined) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const issue of error.details) {
    if (!(issue.path in result)) {
      result[issue.path] = issue.message;
    }
  }
  return result;
}
