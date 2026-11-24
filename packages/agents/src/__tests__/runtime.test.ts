import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { UsageLogRecordInput } from '../gateway/types.js';
import {
  ModelGateway,
  SMOKE_WORKFLOW_ID,
  SmokeWorkflowInputError,
  createFanXiaoshuoRuntime,
  type ResolvedModelConfig,
} from '../index.js';

const BASE_CONFIG: ResolvedModelConfig = {
  providerId: '22222222-2222-4222-8222-222222222222',
  providerName: 'mock-provider',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-smoke-secret-key-123456',
  modelId: 'mock-model',
  displayName: 'Mock Model',
  inputPricePer1m: 0.15,
  outputPricePer1m: 0.6,
};

function createMockModel(text = 'OK'): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' } as const,
      usage: {
        inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 500, text: 500, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

function createRuntimeWithMock(): {
  runtime: ReturnType<typeof createFanXiaoshuoRuntime>;
  records: UsageLogRecordInput[];
  model: MockLanguageModelV4;
} {
  const records: UsageLogRecordInput[] = [];
  const model = createMockModel();
  const gateway = new ModelGateway({
    usageLogger: (record) => {
      records.push(record);
    },
    createLanguageModel: () => model,
  });
  const runtime = createFanXiaoshuoRuntime({ gateway });
  return { runtime, records, model };
}

describe('createFanXiaoshuoRuntime', () => {
  it('注册 4 个核心写书角色并提供默认系统提示词', () => {
    const { runtime } = createRuntimeWithMock();

    expect(runtime.engine).toBe('mastra');
    expect(runtime.workflowId).toBe(SMOKE_WORKFLOW_ID);
    expect(runtime.registeredAgentIds).toEqual(['showrunner', 'lorekeeper', 'writer', 'critic']);
    expect(runtime.agentRoles).toHaveLength(4);

    const writer = runtime.getAgentRoleDefinition('writer');
    expect(writer.label).toBe('执笔写手');
    expect(writer.systemPrompt).toContain('执笔写手');
    expect(writer.systemPrompt.length).toBeGreaterThan(20);

    const critic = runtime.getAgentRoleDefinition('critic');
    expect(critic.label).toBe('审稿质检');
  });
});

describe('runSmokeWorkflow · echo 模式', () => {
  it('经 Mastra Step 管道执行并返回步骤耗时，不调用模型、不写用量日志', async () => {
    const { runtime, records, model } = createRuntimeWithMock();

    const result = await runtime.runSmokeWorkflow({ mode: 'echo', message: 'pipeline-check' });

    expect(result.engine).toBe('mastra');
    expect(result.workflowId).toBe(SMOKE_WORKFLOW_ID);
    expect(result.runId.length).toBeGreaterThan(0);
    expect(result.mode).toBe('echo');
    expect(result.message).toBe('pipeline-check');
    expect(result.replyPreview).toBeNull();
    expect(result.modelRef).toBeNull();
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.modelLatencyMs).toBeNull();
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);

    expect(result.steps.map((step) => step.stepId)).toEqual(['prepare', 'execute', 'finalize']);
    for (const step of result.steps) {
      expect(step.status).toBe('success');
      expect(step.latencyMs).toBeGreaterThanOrEqual(0);
    }

    expect(records).toHaveLength(0);
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

describe('runSmokeWorkflow · live 模式', () => {
  it('经 Mastra Workflow 调用 ModelGateway 并写入 smoke-job 用量日志', async () => {
    const { runtime, records, model } = createRuntimeWithMock();

    const result = await runtime.runSmokeWorkflow({
      mode: 'live',
      modelConfig: BASE_CONFIG,
      message: '请回复 OK',
    });

    expect(result.mode).toBe('live');
    expect(result.replyPreview).toBe('OK');
    expect(result.modelRef).toBe('mock-provider/mock-model');
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(500);
    expect(result.estimatedCostUsd).toBe(0.00045);
    expect(result.modelLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.steps.map((step) => step.stepId)).toEqual(['prepare', 'execute', 'finalize']);

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.scene).toBe('smoke-job');
    expect(records[0]?.status).toBe('success');
    expect(records[0]?.role).toBeNull();
    expect(records[0]?.inputTokens).toBe(1000);
    expect(records[0]?.estimatedCostUsd).toBe(0.00045);
  });

  it('缺少 modelConfig 时明确拒绝，不启动工作流', async () => {
    const { runtime, records } = createRuntimeWithMock();

    await expect(runtime.runSmokeWorkflow({ mode: 'live' })).rejects.toBeInstanceOf(
      SmokeWorkflowInputError,
    );
    expect(records).toHaveLength(0);
  });
});
