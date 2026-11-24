import { describe, expect, it } from 'vitest';
import {
  ApiClientError,
  describeError,
  fallbackErrorCode,
  fieldErrorsOf,
  isApiClientError,
  networkError,
  normalizeApiError,
} from '@/api/errors';

describe('API 错误解析', () => {
  it('严格解析共享 ApiError 契约并保留冲突语义', () => {
    const error = normalizeApiError(409, {
      code: 'MODEL_IN_USE',
      message: '模型仍被写书角色绑定，无法删除',
      details: [{ path: 'modelId', message: '仍被 writer 角色引用' }],
      requestId: 'req-1',
    });

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.code).toBe('MODEL_IN_USE');
    expect(error.status).toBe(409);
    expect(error.message).toBe('模型仍被写书角色绑定，无法删除');
    expect(error.isConflict).toBe(true);
    expect(error.details).toEqual([{ path: 'modelId', message: '仍被 writer 角色引用' }]);
    expect(error.requestId).toBe('req-1');
    expect(fieldErrorsOf(error)).toEqual({ modelId: '仍被 writer 角色引用' });
  });

  it('非契约响应体按 HTTP 状态码兜底', () => {
    const error = normalizeApiError(400, { message: '字段非法' });
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('字段非法');

    const htmlError = normalizeApiError(503, '<html>gateway down</html>');
    expect(htmlError.code).toBe('SERVICE_UNAVAILABLE');
    expect(htmlError.message).toContain('gateway down');

    const emptyError = normalizeApiError(500, undefined);
    expect(emptyError.code).toBe('INTERNAL_ERROR');
    expect(emptyError.message).toBe('请求失败（HTTP 500）');
  });

  it('错误码映射覆盖常见状态', () => {
    expect(fallbackErrorCode(404)).toBe('NOT_FOUND');
    expect(fallbackErrorCode(409)).toBe('CONFLICT');
    expect(fallbackErrorCode(429)).toBe('UPSTREAM_RATE_LIMIT');
    expect(fallbackErrorCode(504)).toBe('UPSTREAM_TIMEOUT');
    expect(fallbackErrorCode(418)).toBe('INTERNAL_ERROR');
  });

  it('网络异常归一为 NETWORK_ERROR 且带可读提示', () => {
    const error = networkError(new Error('ECONNREFUSED 127.0.0.1:3001'));
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.status).toBe(0);
    expect(error.isNetworkError).toBe(true);
    expect(error.message).toContain('无法连接后端服务');
    expect(error.message).toContain('ECONNREFUSED');
    expect(describeError(error)).toBe(error.message);
  });

  it('isApiClientError / describeError 可安全处理未知异常', () => {
    expect(isApiClientError(new Error('x'))).toBe(false);
    expect(describeError('boom')).toBe('boom');
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(fieldErrorsOf(new Error('x'))).toEqual({});
  });
});
