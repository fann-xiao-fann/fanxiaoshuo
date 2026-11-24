import type { ApiError, ProviderDto, ProviderListResponse } from '@fanxiaoshuo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, testCodec, type TestServerContext } from './helpers/in-memory.js';

const API_KEY = 'sk-test-secret-key-1234567890';
const MASK = 'sk-***7890';

const CREATE_PAYLOAD = {
  name: '中转站 A',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  apiKey: API_KEY,
};

async function setup(): Promise<TestServerContext> {
  return createTestServer();
}

describe('/api/v1/providers', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('新增供应商返回 201 且只暴露掩码，不泄露明文/密文密钥', async () => {
    context = await setup();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      payload: CREATE_PAYLOAD,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<ProviderDto>();
    expect(body.name).toBe('中转站 A');
    expect(body.apiKeyMask).toBe(MASK);
    expect(body.isEnabled).toBe(true);
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('apiKeyEncrypted');
    expect(response.body).not.toContain(API_KEY);

    const stored = [...context.store.state.providers.values()][0];
    expect(stored?.apiKeyEncrypted.startsWith('v1:')).toBe(true);
    expect(stored?.apiKeyEncrypted).not.toContain(API_KEY);
    expect(testCodec.decrypt(stored?.apiKeyEncrypted ?? '')).toBe(API_KEY);

    const list = await context.app.inject({ method: 'GET', url: '/api/v1/providers' });
    expect(list.statusCode).toBe(200);
    const listBody = list.json<ProviderListResponse>();
    expect(listBody.total).toBe(1);
    expect(listBody.items[0]?.apiKeyMask).toBe(MASK);
    expect(list.body).not.toContain(API_KEY);
  });

  it('非法配置返回结构化 400，且不写入脏数据', async () => {
    context = await setup();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      payload: { ...CREATE_PAYLOAD, name: '', baseUrl: 'not-a-url', apiKey: '' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<ApiError>();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details && body.details.length).toBeGreaterThanOrEqual(2);
    expect(context.store.state.providers.size).toBe(0);
  });

  it('同名供应商返回 409 CONFLICT', async () => {
    context = await setup();
    await context.app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      payload: CREATE_PAYLOAD,
    });
    const duplicated = await context.app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      payload: CREATE_PAYLOAD,
    });
    expect(duplicated.statusCode).toBe(409);
    expect(duplicated.json<ApiError>().code).toBe('CONFLICT');
  });

  it('PATCH 留空 apiKey 时保留原加密密钥，提供新值时覆盖', async () => {
    context = await setup();
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      payload: CREATE_PAYLOAD,
    });
    const id = created.json<ProviderDto>().id;
    const before = context.store.state.providers.get(id)?.apiKeyEncrypted;

    const renamed = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${id}`,
      payload: { name: '中转站 B', apiKey: '' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<ProviderDto>().name).toBe('中转站 B');
    expect(renamed.json<ProviderDto>().apiKeyMask).toBe(MASK);
    expect(context.store.state.providers.get(id)?.apiKeyEncrypted).toBe(before);

    const rotated = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${id}`,
      payload: { apiKey: 'sk-new-secret-000011112222' },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json<ProviderDto>().apiKeyMask).toBe('sk-***2222');
    const rotatedStored = context.store.state.providers.get(id);
    expect(rotatedStored?.apiKeyEncrypted).not.toBe(before);
    expect(testCodec.decrypt(rotatedStored?.apiKeyEncrypted ?? '')).toBe(
      'sk-new-secret-000011112222',
    );
  });

  it('PATCH 空 body / 仅空 apiKey 被拒绝', async () => {
    context = await setup();
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      payload: CREATE_PAYLOAD,
    });
    const id = created.json<ProviderDto>().id;

    const empty = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${id}`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const onlyEmptyKey = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${id}`,
      payload: { apiKey: '   ' },
    });
    expect(onlyEmptyKey.statusCode).toBe(400);
  });

  it('PATCH / DELETE 不存在的供应商返回 404', async () => {
    context = await setup();
    const missingId = '00000000-0000-4000-8000-000000000000';

    const patch = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${missingId}`,
      payload: { name: 'X' },
    });
    expect(patch.statusCode).toBe(404);
    expect(patch.json<ApiError>().code).toBe('PROVIDER_NOT_FOUND');

    const remove = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/providers/${missingId}`,
    });
    expect(remove.statusCode).toBe(404);

    const invalidId = await context.app.inject({
      method: 'DELETE',
      url: '/api/v1/providers/not-a-uuid',
    });
    expect(invalidId.statusCode).toBe(400);
  });

  it('DELETE 成功后列表为空', async () => {
    context = await setup();
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      payload: CREATE_PAYLOAD,
    });
    const id = created.json<ProviderDto>().id;

    const removed = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/providers/${id}`,
    });
    expect(removed.statusCode).toBe(204);

    const list = await context.app.inject({ method: 'GET', url: '/api/v1/providers' });
    expect(list.json<ProviderListResponse>().total).toBe(0);
  });
});
