import { API_ERROR_CODES, type ApiErrorCode } from '@fanxiaoshuo/shared';

/**
 * 网关内部错误分类（面向运维与前端提示）。
 * 与共享契约 `ApiErrorCode` 通过 `GATEWAY_ERROR_CODE_BY_CATEGORY` 一一映射。
 */
export const GATEWAY_ERROR_CATEGORIES = {
  /** 上游鉴权失败（401 / 403 / Key 无效） */
  PROVIDER_AUTH_ERROR: 'PROVIDER_AUTH_ERROR',
  /** 上游限流（429） */
  PROVIDER_RATE_LIMIT: 'PROVIDER_RATE_LIMIT',
  /** 上游超时或请求被取消 */
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  /** 上游其它错误（5xx、网络错误、响应解析失败等） */
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  /** 预算熔断（调用未真正发出） */
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
} as const;

export type GatewayErrorCategory = keyof typeof GATEWAY_ERROR_CATEGORIES;

/** 网关错误分类 → 共享错误码（用于 `llm_usage_logs.error_code` 与 API 响应）。 */
export const GATEWAY_ERROR_CODE_BY_CATEGORY: Record<GatewayErrorCategory, ApiErrorCode> = {
  PROVIDER_AUTH_ERROR: API_ERROR_CODES.UPSTREAM_AUTH_ERROR,
  PROVIDER_RATE_LIMIT: API_ERROR_CODES.UPSTREAM_RATE_LIMIT,
  PROVIDER_TIMEOUT: API_ERROR_CODES.UPSTREAM_TIMEOUT,
  PROVIDER_ERROR: API_ERROR_CODES.UPSTREAM_ERROR,
  BUDGET_EXCEEDED: API_ERROR_CODES.BUDGET_EXCEEDED,
};

/** 网关统一错误对象：调用方按 `code` 直接映射 HTTP 状态，按 `category` 做运维分类。 */
export class ModelGatewayError extends Error {
  readonly category: GatewayErrorCategory;
  readonly code: ApiErrorCode;
  /** 上游 HTTP 状态码（若可获取） */
  readonly statusCode: number | null;
  override readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      category: GatewayErrorCategory;
      code?: ApiErrorCode;
      statusCode?: number | null;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'ModelGatewayError';
    this.category = options.category;
    this.code = options.code ?? GATEWAY_ERROR_CODE_BY_CATEGORY[options.category];
    this.statusCode = options.statusCode ?? null;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** 预算熔断错误：在真正调用上游之前抛出。 */
export class BudgetExceededError extends ModelGatewayError {
  readonly runId: string | null;
  readonly maxCostUsd: number;
  readonly spentCostUsd: number;

  constructor(options: {
    runId?: string;
    maxCostUsd: number;
    spentCostUsd: number;
    message?: string;
  }) {
    super(
      options.message ??
        `运行预算已耗尽：已花费 $${options.spentCostUsd}，上限 $${options.maxCostUsd}，已阻止本次模型调用。`,
      { category: 'BUDGET_EXCEEDED', code: API_ERROR_CODES.BUDGET_EXCEEDED },
    );
    this.name = 'BudgetExceededError';
    this.runId = options.runId ?? null;
    this.maxCostUsd = options.maxCostUsd;
    this.spentCostUsd = options.spentCostUsd;
  }
}

/** 类型守卫：判断是否为网关包装后的错误。 */
export function isModelGatewayError(error: unknown): error is ModelGatewayError {
  return error instanceof ModelGatewayError;
}

/** 读取错误对象上的 HTTP 状态码（兼容 APICallError / fetch 响应）。 */
export function readStatusCode(error: unknown): number | null {
  const record = asRecord(error);
  if (!record) {
    return null;
  }

  const direct = firstNumber(record.statusCode, record.status);
  if (direct !== null) {
    return direct;
  }

  const response = asRecord(record.response);
  const nested = response ? firstNumber(response.status, response.statusCode) : null;
  return nested;
}

/** 安全地把 unknown 转为可索引对象。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && /^\d{3}$/.test(value)) {
      return Number(value);
    }
  }
  return null;
}
