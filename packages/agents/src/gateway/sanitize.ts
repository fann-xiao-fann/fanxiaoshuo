import { API_ERROR_CODES } from '@fanxiaoshuo/shared';
import {
  GATEWAY_ERROR_CODE_BY_CATEGORY,
  ModelGatewayError,
  asRecord,
  isModelGatewayError,
  readStatusCode,
  type GatewayErrorCategory,
} from './errors.js';

/** 错误摘要最大长度（与 `llm_usage_logs.error_message` / `TestModelResponse` 契约一致）。 */
export const MAX_ERROR_MESSAGE_LENGTH = 2000;

/** 脱敏占位符。 */
export const REDACTED_SECRET = '[REDACTED]';

/**
 * 常见 API Key / Bearer Token 形态。注意所有表达式都带 `g`，且每次调用前重置 `lastIndex`
 * （JS `RegExp` 字面量带 `g` 时存在状态，跨调用复用必须小心）。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI / OpenAI-compatible / Anthropic：sk-xxx、sk-proj-xxx、sk-ant-xxx
  /\bsk-[A-Za-z0-9_-]{2,}\b/g,
  // Google AI Studio：AIza...
  /\bAIza[0-9A-Za-z_-]{8,}\b/g,
  // 其它常见平台前缀（Groq / xAI / Fireworks 等）
  /\b(?:gsk_|xai-|fw_|hf_)[A-Za-z0-9_-]{8,}\b/g,
  // Authorization: Bearer xxx
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi,
  // apiKey / api_key / x-api-key / access_token = xxx
  /\b((?:api[_-]?key|apikey|access[_-]?token|x-api-key)\s*[:=]\s*)["']?[^\s"',}]+/gi,
  // URL query：?key=xxx / &api_key=xxx
  /([?&](?:key|api_key|apikey|access_token)=)[^&\s]+/gi,
];

/** 读取错误对象中可读的原始文本（消息 + 上游响应体 + cause）。 */
export function extractRawErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error === null || error === undefined) {
    return '未知上游错误';
  }

  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.name ? `${error.name}: ${error.message}` : error.message);
  } else {
    parts.push(describeValue(error));
  }

  const record = asRecord(error);
  if (record) {
    const responseBody = record.responseBody ?? record.body ?? record.data;
    if (typeof responseBody === 'string' && responseBody.trim().length > 0) {
      parts.push(responseBody);
    } else if (responseBody !== undefined && typeof responseBody === 'object') {
      parts.push(describeValue(responseBody));
    }

    const cause = record.cause;
    if (cause !== undefined && cause !== error) {
      const causeMessage = cause instanceof Error ? cause.message : describeValue(cause);
      if (causeMessage.length > 0) {
        parts.push(`cause: ${causeMessage}`);
      }
    }
  }

  const joined = parts.filter((part) => part.trim().length > 0).join(' | ');
  return joined.length > 0 ? joined : '未知上游错误';
}

/**
 * 抹除错误文本中的敏感信息：
 * 1. 先替换调用方显式传入的密钥原串（长度 >= 3，避免误伤短字符串）；
 * 2. 再按常见 Key / Bearer / query 参数模式兜底；
 * 3. 截断至契约上限。
 *
 * 该函数永不抛错，适合直接用于日志与 API 响应。
 */
export function sanitizeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  let message = extractRawErrorMessage(error);

  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length >= 3) {
      message = message.split(trimmed).join(REDACTED_SECRET);
      // 同时处理 URL 编码后的形态
      const encoded = encodeURIComponent(trimmed);
      if (encoded !== trimmed) {
        message = message.split(encoded).join(REDACTED_SECRET);
      }
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    message = message.replace(pattern, (_match, prefix: unknown) => {
      if (typeof prefix === 'string' && prefix.length > 0) {
        return `${prefix}${REDACTED_SECRET}`;
      }
      return REDACTED_SECRET;
    });
    pattern.lastIndex = 0;
  }

  const trimmed = message.trim();
  const normalized = trimmed.length > 0 ? trimmed : '未知上游错误';
  return normalized.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
    : normalized;
}

/**
 * 将任意错误归类为网关错误分类。
 * 判定优先级：已是网关错误 → HTTP 鉴权码 → 超时/取消 → 限流 → 其他。
 */
export function classifyGatewayError(error: unknown): GatewayErrorCategory {
  if (isModelGatewayError(error)) {
    return error.category;
  }

  const statusCode = readStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    return 'PROVIDER_AUTH_ERROR';
  }
  if (statusCode === 408 || statusCode === 504) {
    return 'PROVIDER_TIMEOUT';
  }
  if (statusCode === 429) {
    return 'PROVIDER_RATE_LIMIT';
  }

  const record = asRecord(error);
  const name = error instanceof Error ? error.name : String(record?.name ?? '');
  const message = extractRawErrorMessage(error);
  const haystack = `${name} ${message}`.toLowerCase();

  if (
    /timeout|timed out|etimedout|abort|cancel/.test(haystack) ||
    name === 'TimeoutError' ||
    name === 'AbortError'
  ) {
    return 'PROVIDER_TIMEOUT';
  }
  if (/unauthorized|forbidden|invalid api key|incorrect api key|authentication|401|403/.test(haystack)) {
    return 'PROVIDER_AUTH_ERROR';
  }
  if (/rate limit|too many requests|429/.test(haystack)) {
    return 'PROVIDER_RATE_LIMIT';
  }
  return 'PROVIDER_ERROR';
}

/** 一次完整的错误归一化结果。 */
export interface SanitizedGatewayError {
  readonly message: string;
  readonly category: GatewayErrorCategory;
  readonly code: ModelGatewayError['code'];
  readonly statusCode: number | null;
}

/**
 * 归一化错误：分类 + 脱敏 + 映射共享错误码。
 * 若输入已是 `ModelGatewayError`，保留其分类与状态码。
 */
export function toSanitizedGatewayError(
  error: unknown,
  secrets: readonly string[] = [],
): SanitizedGatewayError {
  const category = classifyGatewayError(error);
  const message = sanitizeErrorMessage(error, secrets);
  if (isModelGatewayError(error)) {
    return {
      message,
      category: error.category,
      code: error.code,
      statusCode: error.statusCode,
    };
  }
  return {
    message,
    category,
    code: GATEWAY_ERROR_CODE_BY_CATEGORY[category] ?? API_ERROR_CODES.UPSTREAM_ERROR,
    statusCode: readStatusCode(error),
  };
}

/** 把任意错误包装为 `ModelGatewayError`（若已包装则原样返回）。 */
export function toModelGatewayError(error: unknown, secrets: readonly string[] = []): ModelGatewayError {
  if (isModelGatewayError(error)) {
    return error;
  }
  const sanitized = toSanitizedGatewayError(error, secrets);
  return new ModelGatewayError(sanitized.message, {
    category: sanitized.category,
    code: sanitized.code,
    statusCode: sanitized.statusCode,
    cause: error,
  });
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}
