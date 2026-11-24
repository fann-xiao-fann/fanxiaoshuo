import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  API_ERROR_HTTP_STATUS,
  apiErrorCodeSchema,
  apiErrorSchema,
  apiErrorStatus,
} from '../errors.js';

describe('API_ERROR_CODES', () => {
  it('键与值完全一致（便于日志与前端 switch）', () => {
    for (const [key, value] of Object.entries(API_ERROR_CODES)) {
      expect(value).toBe(key);
    }
  });

  it('schema 接受全部错误码并拒绝未知码', () => {
    for (const code of Object.values(API_ERROR_CODES)) {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(apiErrorCodeSchema.safeParse('NOT_A_CODE').success).toBe(false);
    expect(apiErrorCodeSchema.safeParse('').success).toBe(false);
  });

  it('每个错误码都有 4xx/5xx 的 HTTP 状态映射', () => {
    for (const code of Object.values(API_ERROR_CODES)) {
      const status = apiErrorStatus(code);
      expect(API_ERROR_HTTP_STATUS[code]).toBe(status);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});

describe('apiErrorSchema', () => {
  it('接受最小错误体', () => {
    const parsed = apiErrorSchema.parse({ code: 'NOT_FOUND', message: '资源不存在' });
    expect(parsed.code).toBe('NOT_FOUND');
    expect(parsed.details).toBeUndefined();
  });

  it('接受带字段级 details 的校验错误', () => {
    const parsed = apiErrorSchema.parse({
      code: 'VALIDATION_ERROR',
      message: '请求参数校验失败',
      details: [{ path: 'baseUrl', message: '必须是合法 URL' }],
      requestId: 'req-1',
    });
    expect(parsed.details?.[0]?.path).toBe('baseUrl');
  });

  it('拒绝未知错误码与空 message', () => {
    expect(apiErrorSchema.safeParse({ code: 'WHATEVER', message: 'x' }).success).toBe(false);
    expect(apiErrorSchema.safeParse({ code: 'NOT_FOUND', message: '' }).success).toBe(false);
    expect(apiErrorSchema.safeParse({ code: 'NOT_FOUND' }).success).toBe(false);
  });
});
