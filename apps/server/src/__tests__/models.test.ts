import type {
  AgentRolesResponse,
  ApiError,
  ModelDto,
  ModelListResponse,
  ProviderDto,
} from '@fanxiaoshuo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServerContext } from './helpers/in-memory.js';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

async function seedProvider(context: TestServerContext): Promise<string> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/v1/providers',
    payload: {
      name: '供应商 P',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-secret-key-1234567890',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<ProviderDto>().id;
}

describe('/api/v1/models', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('在供应商下注册模型并返回完整单价字段', async () => {
    context = await createTestServer();
    const providerId = await seedProvider(context);

    const created = await context.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: {
        providerId,
        modelId: 'deepseek-chat',
        displayName: 'DeepSeek Chat',
        contextWindow: 64_000,
        inputPricePer1M: 0.14,
        outputPricePer1M: 0.28,
      },
    });
    expect(created.statusCode).toBe(201);
    const model = created.json<ModelDto>();
    expect(model.modelId).toBe('deepseek-chat');
    expect(model.inputPricePer1M).toBe(0.14);
    expect(model.outputPricePer1M).toBe(0.28);
    expect(model.contextWindow).toBe(64_000);
    expect(model.isEnabled).toBe(true);

    const list = await context.app.inject({
      method: 'GET',
      url: `/api/v1/models?providerId=${providerId}`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<ModelListResponse>().total).toBe(1);

    const empty = await context.app.inject({
      method: 'GET',
      url: `/api/v1/models?providerId=${MISSING_ID}`,
    });
    expect(empty.json<ModelListResponse>().total).toBe(0);

    const invalidQuery = await context.app.inject({
      method: 'GET',
      url: '/api/v1/models?providerId=not-a-uuid',
    });
    expect(invalidQuery.statusCode).toBe(400);
  });

  it('供应商不存在 / 模型重复时拒绝写入', async () => {
    context = await createTestServer();
    const providerId = await seedProvider(context);

    const missingProvider = await context.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: {
        providerId: MISSING_ID,
        modelId: 'ghost-model',
        displayName: 'Ghost',
      },
    });
    expect(missingProvider.statusCode).toBe(404);
    expect(missingProvider.json<ApiError>().code).toBe('PROVIDER_NOT_FOUND');

    const payload = {
      providerId,
      modelId: 'gpt-4o-mini',
      displayName: 'GPT-4o mini',
    };
    const first = await context.app.inject({ method: 'POST', url: '/api/v1/models', payload });
    expect(first.statusCode).toBe(201);

    const duplicate = await context.app.inject({ method: 'POST', url: '/api/v1/models', payload });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<ApiError>().code).toBe('CONFLICT');
  });

  it('PATCH 更新展示名 / 价格 / 启停状态；不存在的模型 404', async () => {
    context = await createTestServer();
    const providerId = await seedProvider(context);
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { providerId, modelId: 'claude-x', displayName: 'Claude X' },
    });
    const id = created.json<ModelDto>().id;

    const patched = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/models/${id}`,
      payload: { displayName: 'Claude X Pro', outputPricePer1M: 12.5, isEnabled: false },
    });
    expect(patched.statusCode).toBe(200);
    const body = patched.json<ModelDto>();
    expect(body.displayName).toBe('Claude X Pro');
    expect(body.outputPricePer1M).toBe(12.5);
    expect(body.isEnabled).toBe(false);

    const missing = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/models/${MISSING_ID}`,
      payload: { displayName: 'Nope' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiError>().code).toBe('MODEL_NOT_FOUND');
  });

  it('删除仍被角色绑定的模型返回 409 MODEL_IN_USE，解绑后可删除', async () => {
    context = await createTestServer();
    const providerId = await seedProvider(context);
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { providerId, modelId: 'writer-model', displayName: 'Writer Model' },
    });
    const modelId = created.json<ModelDto>().id;

    const bound = await context.app.inject({
      method: 'PUT',
      url: '/api/v1/agent-roles',
      payload: {
        bindings: [{ role: 'writer', modelId, temperature: 0.9, maxTokens: 4096 }],
      },
    });
    expect(bound.statusCode).toBe(200);
    const roles = bound.json<AgentRolesResponse>().roles;
    const writer = roles.find((role) => role.role === 'writer');
    expect(writer?.modelId).toBe(modelId);
    expect(writer?.model?.modelId).toBe('writer-model');
    expect(writer?.provider?.id).toBe(providerId);
    expect(writer?.temperature).toBe(0.9);

    const blocked = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/models/${modelId}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<ApiError>().code).toBe('MODEL_IN_USE');

    const unbound = await context.app.inject({
      method: 'PUT',
      url: '/api/v1/agent-roles',
      payload: { bindings: [{ role: 'writer', modelId: null }] },
    });
    expect(unbound.statusCode).toBe(200);
    const writerAfter = unbound.json<AgentRolesResponse>().roles.find((r) => r.role === 'writer');
    expect(writerAfter?.modelId).toBeNull();
    expect(writerAfter?.model).toBeNull();

    const removed = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/models/${modelId}`,
    });
    expect(removed.statusCode).toBe(204);
  });

  it('删除供应商时若其模型仍被角色绑定返回 409', async () => {
    context = await createTestServer();
    const providerId = await seedProvider(context);
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { providerId, modelId: 'showrunner-model', displayName: 'Showrunner' },
    });
    const modelId = created.json<ModelDto>().id;

    await context.app.inject({
      method: 'PUT',
      url: '/api/v1/agent-roles',
      payload: { bindings: [{ role: 'showrunner', modelId }] },
    });

    const blocked = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/providers/${providerId}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<ApiError>().code).toBe('CONFLICT');
    expect(context.store.state.providers.has(providerId)).toBe(true);
  });
});
