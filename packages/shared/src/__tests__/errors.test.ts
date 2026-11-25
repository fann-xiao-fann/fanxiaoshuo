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

describe('Change 2 书库 / 编辑器专用错误码', () => {
  it('新增错误码字面量与 HTTP 状态映射符合契约', () => {
    expect(API_ERROR_CODES.BOOK_NOT_FOUND).toBe('BOOK_NOT_FOUND');
    expect(API_ERROR_CODES.VOLUME_NOT_FOUND).toBe('VOLUME_NOT_FOUND');
    expect(API_ERROR_CODES.CHAPTER_NOT_FOUND).toBe('CHAPTER_NOT_FOUND');
    expect(API_ERROR_CODES.CHAPTER_VERSION_CONFLICT).toBe('CHAPTER_VERSION_CONFLICT');
    expect(API_ERROR_CODES.REVISION_NOT_FOUND).toBe('REVISION_NOT_FOUND');

    expect(apiErrorStatus('BOOK_NOT_FOUND')).toBe(404);
    expect(apiErrorStatus('VOLUME_NOT_FOUND')).toBe(404);
    expect(apiErrorStatus('CHAPTER_NOT_FOUND')).toBe(404);
    expect(apiErrorStatus('REVISION_NOT_FOUND')).toBe(404);
    expect(apiErrorStatus('CHAPTER_VERSION_CONFLICT')).toBe(409);
  });

  it('既有关键错误码保持原有状态码（不破坏 Change 1 契约）', () => {
    expect(apiErrorStatus('VALIDATION_ERROR')).toBe(400);
    expect(apiErrorStatus('NOT_FOUND')).toBe(404);
    expect(apiErrorStatus('CONFLICT')).toBe(409);
    expect(apiErrorStatus('MODEL_IN_USE')).toBe(409);
    expect(apiErrorStatus('QUEUE_UNAVAILABLE')).toBe(503);
  });
});

describe('Change 3 设定集 / AI 写作专用错误码', () => {
  it('新增错误码字面量与值一致', () => {
    expect(API_ERROR_CODES.KNOWLEDGE_CARD_NOT_FOUND).toBe('KNOWLEDGE_CARD_NOT_FOUND');
    expect(API_ERROR_CODES.AI_EMPTY_CONTEXT).toBe('AI_EMPTY_CONTEXT');
  });

  it('新增错误码 HTTP 状态映射符合契约（404 / 400）', () => {
    expect(API_ERROR_HTTP_STATUS.KNOWLEDGE_CARD_NOT_FOUND).toBe(404);
    expect(API_ERROR_HTTP_STATUS.AI_EMPTY_CONTEXT).toBe(400);
    expect(apiErrorStatus('KNOWLEDGE_CARD_NOT_FOUND')).toBe(404);
    expect(apiErrorStatus('AI_EMPTY_CONTEXT')).toBe(400);
  });

  it('新增错误码可被统一 ApiError 响应体使用', () => {
    for (const code of ['KNOWLEDGE_CARD_NOT_FOUND', 'AI_EMPTY_CONTEXT'] as const) {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(apiErrorSchema.safeParse({ code, message: '错误说明' }).success).toBe(true);
    }
  });

  it('错误码 → 状态码映射完整且不存在多余键（无契约漂移）', () => {
    const codeKeys = Object.keys(API_ERROR_CODES).sort();
    const statusKeys = Object.keys(API_ERROR_HTTP_STATUS).sort();
    expect(statusKeys).toEqual(codeKeys);
    for (const status of Object.values(API_ERROR_HTTP_STATUS)) {
      expect(Number.isInteger(status)).toBe(true);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('AI_EMPTY_CONTEXT 保持 4xx（不重试）语义，不能是 5xx', () => {
    expect(apiErrorStatus('AI_EMPTY_CONTEXT')).toBeLessThan(500);
    expect(apiErrorStatus('KNOWLEDGE_CARD_NOT_FOUND')).toBeLessThan(500);
  });
});
