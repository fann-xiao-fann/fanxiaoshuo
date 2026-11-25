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

/**
 * 是否为章节乐观锁版本冲突（`409 CHAPTER_VERSION_CONFLICT`）。
 * 编辑器据此弹出「重新加载 / 强制覆盖」冲突处理弹窗。
 */
export function isChapterVersionConflict(error: unknown): boolean {
  return isApiClientError(error) && error.code === 'CHAPTER_VERSION_CONFLICT';
}

/**
 * 从冲突响应的 `details` 中提取服务端最新版本号。
 * 服务端约定以 `currentVersion` 字段回传；缺失时回退扫描任意可解析的整数明细。
 */
export function extractConflictVersion(error: unknown): number | null {
  if (!isApiClientError(error) || error.details === undefined) {
    return null;
  }
  const pick = (issue: { path: string; message: string }): number | null => {
    const matched = /\d+/.exec(issue.message);
    if (matched === null) {
      return null;
    }
    const parsed = Number.parseInt(matched[0], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  for (const issue of error.details) {
    if (issue.path.toLowerCase().includes('currentversion')) {
      const version = pick(issue);
      if (version !== null) {
        return version;
      }
    }
  }
  for (const issue of error.details) {
    const version = pick(issue);
    if (version !== null) {
      return version;
    }
  }
  return null;
}
