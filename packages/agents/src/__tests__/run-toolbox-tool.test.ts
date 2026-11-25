import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import {
  ModelGateway,
  ToolboxInputError,
  runToolboxTool,
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

/** (1000 * 0.15 + 500 * 0.6) / 1e6 */
const EXPECTED_COST_USD = 0.00045;

function mockUsage() {
  return {
    inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 500, text: 500, reasoning: 0 },
  };
}

function createMockModel(text: string): MockLanguageModelV4 {
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

function collectLogger(): {
  records: UsageLogRecordInput[];
  logger: (record: UsageLogRecordInput) => void;
} {
  const records: UsageLogRecordInput[] = [];
  return { records, logger: (record) => records.push(record) };
}

function structuredReply(payload: unknown): string {
  return ['```json', JSON.stringify(payload), '```'].join('\n');
}

describe('runToolboxTool（经 ModelGateway 执行创作工具）', () => {
  it('以 toolbox-run 场景单次调用模型，并返回结构化产出、Token、费用与耗时', async () => {
    const { records, logger } = collectLogger();
    const gateway = new ModelGateway({ usageLogger: logger });
    const model = createMockModel(
      structuredReply({
        overview: '人物卡围绕「克制而危险的剑修」展开。',
        items: [
          {
            title: '沈青梧',
            summary: '克制到近乎冷酷的寒门剑修',
            content: '基础档案：二十四岁，凭一柄断剑入道。',
            aliases: ['青梧'],
            tags: ['主角', '剑修'],
            suggestedCardCategory: 'character',
          },
        ],
      }),
    );

    const result = await runToolboxTool(gateway, {
      toolId: 'character-designer',
      role: 'lorekeeper',
      inputs: { rolePosition: '主角', archetype: '落魄剑修', count: 1 },
      config: BASE_CONFIG,
      bookContext: {
        title: '断剑问天',
        genre: '东方玄幻',
        outline: { mainPlot: '少年持断剑北上问道' },
        cards: [
          {
            category: 'faction',
            title: '问剑宗',
            summary: '正道第一大派',
            pinned: true,
          },
        ],
      },
      temperature: 0.3,
      maxOutputTokens: 512,
      languageModelOverride: model,
    });

    expect(result.toolId).toBe('character-designer');
    expect(result.role).toBe('lorekeeper');
    expect(result.inputs).toMatchObject({ rolePosition: '主角', archetype: '落魄剑修' });
    expect(result.output.overview).toContain('克制而危险的剑修');
    expect(result.output.items).toHaveLength(1);
    expect(result.output.items[0]?.title).toBe('沈青梧');
    expect(result.output.items[0]?.suggestedCardCategory).toBe('character');
    expect(result.modelRef).toBe('mock-provider/mock-model');
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(500);
    expect(result.estimatedCostUsd).toBe(EXPECTED_COST_USD);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0];
    expect(call?.temperature).toBe(0.3);
    expect(call?.maxOutputTokens).toBe(512);
    const requestText = JSON.stringify(call?.prompt ?? []);
    expect(requestText).toContain('落魄剑修');
    expect(requestText).toContain('断剑问天');
    expect(requestText).toContain('问剑宗');

    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.scene).toBe('toolbox-run');
    expect(record?.role).toBe('lorekeeper');
    expect(record?.status).toBe('success');
    expect(record?.modelRef).toBe('mock-provider/mock-model');
    expect(record?.inputTokens).toBe(1000);
    expect(record?.outputTokens).toBe(500);
    expect(record?.estimatedCostUsd).toBe(EXPECTED_COST_USD);
    expect(record?.errorCode).toBeNull();
    expect(record?.errorMessage).toBeNull();
  });

  it('world-faction-builder 将 cardCategory 透传为推荐分类（location → world）', async () => {
    const { records, logger } = collectLogger();
    const gateway = new ModelGateway({ usageLogger: logger });
    const model = createMockModel(
      JSON.stringify({
        overview: '浮空城设定',
        items: [
          {
            title: '浮空城',
            summary: '漂浮在云海之上的旧都',
            content: '运行规则：以风脉维持悬浮。',
            suggestedCardCategory: 'unknown-category',
          },
        ],
      }),
    );

    const result = await runToolboxTool(gateway, {
      toolId: 'world-faction-builder',
      role: 'lorekeeper',
      inputs: { cardCategory: 'location', theme: '云海浮空城' },
      config: BASE_CONFIG,
      languageModelOverride: model,
    });

    expect(result.output.items[0]?.suggestedCardCategory).toBe('world');
    expect(records).toHaveLength(1);
    expect(records[0]?.scene).toBe('toolbox-run');

    const requestText = JSON.stringify(model.doGenerateCalls[0]?.prompt ?? []);
    expect(requestText).toContain('云海浮空城');
    expect(requestText).toContain('地点/场景');
  });

  it('world-faction-builder 的 plot 类型归一化为 foreshadowing', async () => {
    const { logger } = collectLogger();
    const gateway = new ModelGateway({ usageLogger: logger });
    const model = createMockModel(
      JSON.stringify({
        overview: '剧情设定',
        items: [{ title: '宗门叛变', content: '触发条件：大比之夜。', suggestedCardCategory: 'plot' }],
      }),
    );

    const result = await runToolboxTool(gateway, {
      toolId: 'world-faction-builder',
      role: 'lorekeeper',
      inputs: { cardCategory: 'plot', theme: '宗门叛变' },
      config: BASE_CONFIG,
      languageModelOverride: model,
    });

    expect(result.output.items[0]?.suggestedCardCategory).toBe('foreshadowing');
  });

  it('输入不合法时在调用模型前抛出 ToolboxInputError，且不产生用量日志', async () => {
    const { records, logger } = collectLogger();
    const gateway = new ModelGateway({ usageLogger: logger });
    const model = createMockModel('{"overview":"","items":[{"title":"x","content":"y"}]}');

    await expect(
      runToolboxTool(gateway, {
        toolId: 'character-designer',
        role: 'lorekeeper',
        inputs: { rolePosition: '主角' },
        config: BASE_CONFIG,
        languageModelOverride: model,
      }),
    ).rejects.toBeInstanceOf(ToolboxInputError);

    await expect(
      runToolboxTool(gateway, {
        toolId: 'world-faction-builder',
        role: 'lorekeeper',
        inputs: { cardCategory: 'location', theme: '浮空城', unexpectedField: '多余字段' },
        config: BASE_CONFIG,
        languageModelOverride: model,
      }),
    ).rejects.toMatchObject({
      name: 'ToolboxInputError',
      issues: [{ path: 'inputs.unexpectedField' }],
    });

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it('上游错误原样透传且错误信息脱敏（不泄露明文 API Key）', async () => {
    const { records, logger } = collectLogger();
    const gateway = new ModelGateway({ usageLogger: logger });
    const upstreamError = Object.assign(
      new Error(`401 Unauthorized: invalid api key ${API_KEY}`),
      { statusCode: 401 },
    );

    await expect(
      runToolboxTool(gateway, {
        toolId: 'book-pitch',
        role: 'showrunner',
        inputs: {
          genre: '都市异能',
          coreHook: '法医继承亡者记忆',
          audience: '男频爽文',
        },
        config: BASE_CONFIG,
        languageModelOverride: createThrowingModel(upstreamError),
      }),
    ).rejects.toMatchObject({ name: 'ModelGatewayError', code: 'UPSTREAM_AUTH_ERROR' });

    let captured: unknown;
    try {
      await runToolboxTool(gateway, {
        toolId: 'book-pitch',
        role: 'showrunner',
        inputs: {
          genre: '都市异能',
          coreHook: '法医继承亡者记忆',
          audience: '男频爽文',
        },
        config: BASE_CONFIG,
        languageModelOverride: createThrowingModel(upstreamError),
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).not.toContain(API_KEY);
    expect((captured as Error).message).toContain('[REDACTED]');

    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.status).toBe('error');
      expect(record.scene).toBe('toolbox-run');
      expect(record.errorCode).toBe('UPSTREAM_AUTH_ERROR');
      expect(record.errorMessage).not.toContain(API_KEY);
      expect(record.errorMessage).toContain('[REDACTED]');
    }
  });

  it('模型返回纯文本时确定性降级为 1 条结构化结果', async () => {
    const { records, logger } = collectLogger();
    const gateway = new ModelGateway({ usageLogger: logger });
    const model = createMockModel('把开篇的环境描写压缩一半，先给人物动作。');

    const result = await runToolboxTool(gateway, {
      toolId: 'text-polish-diagnose',
      role: 'critic',
      inputs: { excerpt: '他走进大殿，空气安静了下来。', focus: '去除水文与重复' },
      config: BASE_CONFIG,
      languageModelOverride: model,
    });

    expect(result.output.items).toHaveLength(1);
    expect(result.output.items[0]?.title).toBe('片段文本质检与润色建议结果');
    expect(result.output.items[0]?.content).toBe('把开篇的环境描写压缩一半，先给人物动作。');
    expect(result.output.items[0]?.suggestedCardCategory).toBe('world');
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('success');
  });
});
