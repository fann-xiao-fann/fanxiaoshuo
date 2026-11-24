import { describe, expect, it } from 'vitest';
import {
  classifyGatewayError,
  sanitizeErrorMessage,
  toSanitizedGatewayError,
} from '../gateway/sanitize.js';
import { ModelGatewayError } from '../gateway/errors.js';

const API_KEY = 'sk-live-abcdef1234567890';

describe('sanitizeErrorMessage', () => {
  it('彻底抹除传入的明文 API Key 原串', () => {
    const error = new Error(`401 unauthorized: invalid api key ${API_KEY}`);
    const sanitized = sanitizeErrorMessage(error, [API_KEY]);
    expect(sanitized).not.toContain(API_KEY);
    expect(sanitized).toContain('[REDACTED]');
  });

  it('自动识别 sk- / Bearer / query 参数等常见密钥形态', () => {
    const message = sanitizeErrorMessage(
      new Error(
        'failed: sk-proj-abcdefghijklmnop Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig https://api.example.com/v1?key=AIzaSyDummy1234567890',
      ),
    );
    expect(message).not.toMatch(/sk-proj-abcdefghijklmnop/);
    expect(message).not.toContain('eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(message).not.toContain('AIzaSyDummy1234567890');
    expect(message).toContain('[REDACTED]');
  });

  it('替换 api_key= 形式的显式密钥', () => {
    const message = sanitizeErrorMessage(new Error('api_key=super-secret-value connection refused'));
    expect(message).not.toContain('super-secret-value');
    expect(message).toContain('[REDACTED]');
  });

  it('输出长度受 2000 字上限约束', () => {
    const message = sanitizeErrorMessage(new Error('x'.repeat(5000)));
    expect(message.length).toBeLessThanOrEqual(2000);
    expect(message.endsWith('…')).toBe(true);
  });
});

describe('classifyGatewayError', () => {
  it('401 / 403 归类为 PROVIDER_AUTH_ERROR', () => {
    expect(classifyGatewayError(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))).toBe(
      'PROVIDER_AUTH_ERROR',
    );
    expect(classifyGatewayError(Object.assign(new Error('Forbidden'), { response: { status: 403 } }))).toBe(
      'PROVIDER_AUTH_ERROR',
    );
  });

  it('TimeoutError / AbortError 归类为 PROVIDER_TIMEOUT', () => {
    expect(classifyGatewayError(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe(
      'PROVIDER_TIMEOUT',
    );
    expect(
      classifyGatewayError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
    ).toBe('PROVIDER_TIMEOUT');
  });

  it('429 归类为 PROVIDER_RATE_LIMIT，其它为 PROVIDER_ERROR', () => {
    expect(classifyGatewayError(Object.assign(new Error('Too Many Requests'), { statusCode: 429 }))).toBe(
      'PROVIDER_RATE_LIMIT',
    );
    expect(classifyGatewayError(Object.assign(new Error('boom'), { statusCode: 500 }))).toBe(
      'PROVIDER_ERROR',
    );
  });

  it('保留已包装的网关错误分类', () => {
    const gatewayError = new ModelGatewayError('bad key', { category: 'PROVIDER_AUTH_ERROR' });
    expect(classifyGatewayError(gatewayError)).toBe('PROVIDER_AUTH_ERROR');
  });
});

describe('toSanitizedGatewayError', () => {
  it('分类同时映射共享错误码并脱敏', () => {
    const error = Object.assign(new Error(`401 invalid api key ${API_KEY}`), { statusCode: 401 });
    const sanitized = toSanitizedGatewayError(error, [API_KEY]);
    expect(sanitized.category).toBe('PROVIDER_AUTH_ERROR');
    expect(sanitized.code).toBe('UPSTREAM_AUTH_ERROR');
    expect(sanitized.message).not.toContain(API_KEY);
  });

  it('超时映射为 UPSTREAM_TIMEOUT', () => {
    const sanitized = toSanitizedGatewayError(
      Object.assign(new Error('request timed out'), { name: 'TimeoutError' }),
    );
    expect(sanitized.category).toBe('PROVIDER_TIMEOUT');
    expect(sanitized.code).toBe('UPSTREAM_TIMEOUT');
  });
});
