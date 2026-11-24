import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { AgentRole } from '@fanxiaoshuo/shared';
import { PROVIDER_PROTOCOLS } from '@fanxiaoshuo/shared';
import {
  BudgetExceededError,
  ModelGateway,
  createLanguageModel,
  type ResolvedModelConfig,
  type UsageLogRecordInput,
} from '../index.js';

const API_KEY = 'sk-test-secret-key-1234567890';

const BASE_CONFIG: ResolvedModelConfig = {
  providerId: '11111111-1111-4111-8111-111111111111',
  providerName: 'mock-provider',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  apiKey: API_KEY,
  modelId: 'mock-model',
  displayName: 'Mock Model',
  inputPricePer1m: 0.15,
  outputPricePer1m: 0.6,
};

const EXPECTED_COST_USD = 0.00045; // (1000 * 0.15 + 500 * 0.6) / 1e6

function mockUsage() {
  return {
    inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 500, text: 500, reasoning: 0 },
  };
}

function createMockModel(text = 'OK'): MockLanguageModelV4 {
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

function createThrowingModel(error: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doGenerate: async () => {
      throw error;
    },
  });
}

/** 模拟一个真正响应 AbortSignal 的慢模型，用于验证网关超时。 */
function createAbortAwareModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doGenerate: async (options: { abortSignal?: AbortSignal }) => {
      await new Promise<never>((_resolve, reject) => {
        if (options.abortSignal?.aborted) {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          return;
        }
        options.abortSignal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
      throw new Error('unreachable');
    },
  });
}

function collectLogger(): { records: UsageLogRecordInput[]; logger: (r: UsageLogRecordInput) => void } {
  const records: UsageLogRecordInput[] = [];
  return { records, logger: (record) => records.push(record) };
}

describe('ModelGateway.generateText', () => {
  it('成功调用后写入完整用量日志（角色 / Token / 费用 / 延迟）', async () => {
    const { records, logger } = collectLogger();
    const gateway = new ModelGateway({ usageLogger: logger });
    const model = createMockModel();

    const result = await gateway.generateText({
      config: BASE_CONFIG,
      role: 'writer' as AgentRole,
      scene: 'chapter-write',
      prompt: '写一段开场白',
      languageModelOverride: model,
    });

    expect(result.text).toBe('OK');
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(500);
    expect(result.estimatedCostUsd).toBe(EXPECTED_COST_USD);
    expect(result.modelRef).toBe('mock-provider/mock-model');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.role).toBe('writer');
    expect(record?.providerId).toBe(BASE_CONFIG.providerId);
    expect(record?.modelRef).toBe('mock-provider/mock-model');
    expect(record?.scene).toBe('chapter-write');
    expect(record?.inputTokens).toBe(1000);
    expect(record?.outputTokens).toBe(500);
    expect(record?.estimatedCostUsd).toBe(EXPECTED_COST_USD);
    expect(record?.status).toBe('success');
    expect(record?.errorCode).toBeNull();
    expect(record?.errorMessage).toBeNull();
    expect(record?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('预算耗尽时前置熔断，不调用上游也不写日志', async () => {
    const { records, logger } = collectLogger();
    const gateway = new ModelGateway({ usageLogger: logger });
    const model = createMockModel();

    await expect(
      gateway.generateText({
        config: BASE_CONFIG,
        prompt: 'x',
        languageModelOverride: model,
        budgetContext: { runId: 'run-1', maxCostUsd: 0.01, spentCostUsd: 0.01 },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(records).toHaveLength(0);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('上游失败时记录 error 状态并把明文 Key 从日志中抹除', async () => {
    const { records, logger } = collectLogger();
    const gateway = new ModelGateway({ usageLogger: logger });
    const error = Object.assign(new Error(`401 Unauthorized: invalid api key ${API_KEY}`), {
      statusCode: 401,
    });

    await expect(
      gateway.generateText({
        config: BASE_CONFIG,
        prompt: 'x',
        languageModelOverride: createThrowingModel(error),
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_AUTH_ERROR' });

    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.status).toBe('error');
    expect(record?.errorCode).toBe('UPSTREAM_AUTH_ERROR');
    expect(record?.errorMessage).not.toContain(API_KEY);
    expect(record?.errorMessage).toContain('[REDACTED]');
    expect(record?.inputTokens).toBe(0);
    expect(record?.estimatedCostUsd).toBe(0);
  });

  it('超时后记录 UPSTREAM_TIMEOUT 并抛出门户超时错误', async () => {
    const { records, logger } = collectLogger();
    const gateway = new ModelGateway({ usageLogger: logger });

    await expect(
      gateway.generateText({
        config: BASE_CONFIG,
        prompt: 'x',
        timeoutMs: 20,
        languageModelOverride: createAbortAwareModel(),
      }),
    ).rejects.toMatchObject({ category: 'PROVIDER_TIMEOUT', code: 'UPSTREAM_TIMEOUT' });

    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('error');
    expect(records[0]?.errorCode).toBe('UPSTREAM_TIMEOUT');
  });
});

describe('ModelGateway.testConnectivity', () => {
  it('成功测通：返回预览 / Token / 费用并写入 connectivity-test 日志', async () => {
    const { records, logger } = collectLogger();
    const gateway = new ModelGateway();

    const result = await gateway.testConnectivity(BASE_CONFIG, {
      usageLogger: logger,
      languageModelOverride: createMockModel('OK'),
    });

    expect(result.success).toBe(true);
    expect(result.replyPreview).toBe('OK');
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(500);
    expect(result.estimatedCostUsd).toBe(EXPECTED_COST_USD);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(records).toHaveLength(1);
    expect(records[0]?.scene).toBe('connectivity-test');
    expect(records[0]?.role).toBeNull();
    expect(records[0]?.status).toBe('success');
  });

  it('鉴权失败：返回脱敏错误码与信息，并同样写入失败日志', async () => {
    const { records, logger } = collectLogger();
    const gateway = new ModelGateway();
    const error = Object.assign(new Error(`403 Forbidden: api key ${API_KEY} rejected`), {
      statusCode: 403,
    });

    const result = await gateway.testConnectivity(BASE_CONFIG, {
      usageLogger: logger,
      languageModelOverride: createThrowingModel(error),
    });

    expect(result.success).toBe(false);
    expect(result.replyPreview).toBeNull();
    expect(result.errorCode).toBe('UPSTREAM_AUTH_ERROR');
    expect(result.errorMessage).not.toContain(API_KEY);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.estimatedCostUsd).toBe(0);

    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('error');
    expect(records[0]?.errorCode).toBe('UPSTREAM_AUTH_ERROR');
    expect(records[0]?.errorMessage).not.toContain(API_KEY);
  });

  it('超时：返回 UPSTREAM_TIMEOUT 且不抛错', async () => {
    const { records, logger } = collectLogger();
    const gateway = new ModelGateway();

    const result = await gateway.testConnectivity(BASE_CONFIG, {
      timeoutMs: 20,
      usageLogger: logger,
      languageModelOverride: createAbortAwareModel(),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('UPSTREAM_TIMEOUT');
    expect(records).toHaveLength(1);
    expect(records[0]?.errorCode).toBe('UPSTREAM_TIMEOUT');
  });
});

describe('ModelGateway.streamText', () => {
  it('流式输出结束后写入用量日志并返回 Token / 费用', async () => {
    const { records, logger } = collectLogger();
    const gateway = new ModelGateway({ usageLogger: logger });
    const model = new MockLanguageModelV4({
      provider: 'mock-provider',
      modelId: 'mock-model',
      doStream: {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'O' },
          { type: 'text-delta', id: 'text-1', delta: 'K' },
          { type: 'text-end', id: 'text-1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' } as const, usage: mockUsage() },
        ]),
      },
    });

    const stream = gateway.streamText({
      config: BASE_CONFIG,
      role: 'writer',
      scene: 'chapter-write',
      prompt: 'x',
      languageModelOverride: model,
    });

    const chunks: string[] = [];
    for await (const chunk of stream.textStream) {
      chunks.push(chunk);
    }
    const usage = await stream.usage;

    expect(chunks.join('')).toBe('OK');
    expect(usage.inputTokens).toBe(1000);
    expect(usage.outputTokens).toBe(500);
    expect(usage.estimatedCostUsd).toBe(EXPECTED_COST_USD);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('success');
    expect(records[0]?.scene).toBe('chapter-write');
  });
});

describe('createLanguageModel', () => {
  it.each(PROVIDER_PROTOCOLS)('为 %s 协议创建对应 LanguageModel 实例', (protocol) => {
    const model = createLanguageModel({ ...BASE_CONFIG, protocol });
    expect(model).toBeDefined();
    const modelId = typeof model === 'string' ? model : model.modelId;
    expect(modelId).toBe('mock-model');
  });
});
