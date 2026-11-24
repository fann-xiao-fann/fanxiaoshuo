import type { ZodType } from 'zod';
import { API_BASE_URL } from './config';
import {
  invalidResponseError,
  networkError,
  normalizeApiError,
} from './errors';

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** 将筛选对象序列化为查询串，自动忽略 undefined / null / 空字符串。 */
export function buildQueryString(query?: Record<string, QueryValue>): string {
  if (query === undefined) {
    return '';
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized.length > 0 ? `?${serialized}` : '';
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) {
    return undefined;
  }
  const text = await response.text();
  if (text.trim().length === 0) {
    return undefined;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function execute(path: string, options: RequestOptions = {}): Promise<Response> {
  const { method = 'GET', body, query, signal, headers } = options;
  const url = `${API_BASE_URL}${path}${buildQueryString(query)}`;
  const requestInit: RequestInit = {
    method,
    signal,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
  };
  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  }

  try {
    return await fetch(url, requestInit);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw networkError(error);
  }
}

/**
 * 发起请求并用共享 Zod Schema 校验响应。
 * 所有非 2xx 响应都会转换为 `ApiClientError`，视图层无需重复判断状态码。
 */
export async function apiRequest<T>(
  path: string,
  schema: ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const response = await execute(path, options);
  const payload = await readResponseBody(response);

  if (!response.ok) {
    throw normalizeApiError(response.status, payload);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw invalidResponseError(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
      parsed.error,
    );
  }
  return parsed.data;
}

/** 无响应体请求（DELETE / PUT 忽略响应）。 */
export async function apiRequestVoid(
  path: string,
  options: RequestOptions = {},
): Promise<void> {
  const response = await execute(path, options);
  const payload = await readResponseBody(response);
  if (!response.ok) {
    throw normalizeApiError(response.status, payload);
  }
}
