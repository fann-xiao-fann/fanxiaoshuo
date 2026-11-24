import type { ApiError, ModelDto, ProviderDto, TestModelResponse } from '@fanxiaoshuo/shared';
import { ModelGateway } from '@fanxiaoshuo/agents';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServerContext } from './helpers/in-memory.js';

const API_KEY = 'sk-connectivity-secret-1234567890';

function mockUsage() {
  return {
    inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 500, text: 500, reasoning: 0 },
  };
}

function createSuccessModel(text = 'OK'): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' } as const,
      usage: mockUsage(),
      warnings: [],
    },
  });
}

function createFailureModel(message: string, statusCode: number): MockLanguageModelV4 {
  const error = Object.assign(new Error(message), { statusCode });
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doGenerate: async () => {
      throw error;
    },
  });
}

async function seedModel(
  context: TestServerContext,
  overrides: {
    providerEnabled?: boolean;
    modelEnabled?: boolean;
    label?: string;
  } = {},
): Promise<{ providerId: string; modelId: string }> {
  const providerResponse = await context.app.inject({
    method: 'POST',
    url: '/api/v1/providers',
    payload: {
      name: overrides.label ?? 'Test Provider',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKey: API_KEY,
      isEnabled: overrides.providerEnabled ?? true,
    },
  });
  expect(providerResponse.statusCode).toBe(201);
  const providerId = providerResponse.json<ProviderDto>().id;

  const modelResponse = await context.app.inject({
    method: 'POST',
    url: '/api/v1/models',
    payload: {
      providerId,
      modelId: 'mock-model',
      displayName: 'Mock Model',
      inputPricePer1M: 1,
      outputPricePer1M: 2,
      isEnabled: overrides.modelEnabled ?? true,
    },
  });
  expect(modelResponse.statusCode).toBe(201);
  return { providerId, modelId: modelResponse.json<ModelDto>().id };
}

describe('POST /api/v1/models/:id/test', () => {
  let context: TestServerContext | null = null;

  afterEach(async () => {
    await context?.app.close();
    context = null;
  });

  it('测通成功返回预览/延迟/Token/费用，并落盘 success 用量日志', async () => {
    const gateway = new ModelGateway({ createLanguageModel: () => createSuccessModel('OK') });
    context = await createTestServer({ gateway });
    const { providerId, modelId } = await seedModel(context);

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/test`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<TestModelResponse>();
    expect(body.success).toBe(true);
    expect(body.replyPreview).toBe('OK');
    expect(body.inputTokens).toBe(1000);
    expect(body.outputTokens).toBe(500);
    // (1000 * 1 + 500 * 2) / 1_000_000
    expect(body.estimatedCostUsd).toBe(0.002);
    expect(body.errorCode).toBeNull();
    expect(body.errorMessage).toBeNull();
    expect(typeof body.usageLogId).toBe('string');
    expect(response.body).not.toContain(API_KEY);

    expect(context.store.state.logs).toHaveLength(1);
    const log = context.store.state.logs[0];
    expect(log?.id).toBe(body.usageLogId);
    expect(log?.scene).toBe('connectivity-test');
    expect(log?.status).toBe('success');
    expect(log?.role).toBeNull();
    expect(log?.providerId).toBe(providerId);
    expect(log?.modelRef).toBe('Test Provider/mock-model');
    expect(log?.inputTokens).toBe(1000);
    expect(log?.outputTokens).toBe(500);
    expect(log?.estimatedCostUsd).toBe(0.002);
    expect(log?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('上游鉴权失败返回脱敏错误并落盘 error 日志（不含明文 Key）', async () => {
    const gateway = new ModelGateway({
      createLanguageModel: () =>
        createFailureModel(`401 Unauthorized: invalid api key ${API_KEY}`, 401),
    });
    context = await createTestServer({ gateway });
    const { modelId } = await seedModel(context);

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/test`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<TestModelResponse>();
    expect(body.success).toBe(false);
    expect(body.replyPreview).toBeNull();
    expect(body.errorCode).toBe('UPSTREAM_AUTH_ERROR');
    expect(body.errorMessage).toBeTruthy();
    expect(body.errorMessage).not.toContain(API_KEY);
    expect(response.body).not.toContain(API_KEY);

    expect(context.store.state.logs).toHaveLength(1);
    const log = context.store.state.logs[0];
    expect(log?.status).toBe('error');
    expect(log?.scene).toBe('connectivity-test');
    expect(log?.errorCode).toBe('UPSTREAM_AUTH_ERROR');
    expect(log?.errorMessage).not.toContain(API_KEY);
    expect(log?.inputTokens).toBe(0);
    expect(log?.outputTokens).toBe(0);
  });

  it('模型 / 供应商停用时拒绝测通并给出明确错误码', async () => {
    context = await createTestServer();
    const disabledProvider = await seedModel(context, {
      providerEnabled: false,
      label: 'Disabled Provider',
    });
    const providerTest = await context.app.inject({
      method: 'POST',
      url: `/api/v1/models/${disabledProvider.modelId}/test`,
    });
    expect(providerTest.statusCode).toBe(409);
    expect(providerTest.json<ApiError>().code).toBe('PROVIDER_DISABLED');

    const disabledModel = await seedModel(context, {
      modelEnabled: false,
      label: 'Disabled Model Provider',
    });
    const modelTest = await context.app.inject({
      method: 'POST',
      url: `/api/v1/models/${disabledModel.modelId}/test`,
    });
    expect(modelTest.statusCode).toBe(409);
    expect(modelTest.json<ApiError>().code).toBe('MODEL_DISABLED');
    expect(context.store.state.logs).toHaveLength(0);
  });

  it('模型不存在时返回 404 MODEL_NOT_FOUND', async () => {
    context = await createTestServer();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/models/00000000-0000-4000-8000-000000000000/test',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<ApiError>().code).toBe('MODEL_NOT_FOUND');
  });
});
