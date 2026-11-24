import type { ApiError } from '@fanxiaoshuo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServerContext } from './helpers/in-memory.js';

describe('Fastify 统一错误处理', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('未知路由返回结构化 404', async () => {
    context = await createTestServer();
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(response.statusCode).toBe(404);
    const body = response.json<ApiError>();
    expect(body.code).toBe('NOT_FOUND');
    expect(body.requestId).toBeTruthy();
  });

  it('非法 JSON body 返回 400 而非 500', async () => {
    context = await createTestServer();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { 'content-type': 'application/json' },
      payload: '{ this is not json',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ApiError>().code).toBe('VALIDATION_ERROR');
  });

  it('CORS 预检允许前端开发源', async () => {
    context = await createTestServer();
    const response = await context.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/providers',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers['access-control-allow-origin']).toBeTruthy();
  });
});
