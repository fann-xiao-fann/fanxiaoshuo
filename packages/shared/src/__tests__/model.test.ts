import { describe, expect, it } from 'vitest';
import {
  createModelSchema,
  modelDtoSchema,
  modelListResponseSchema,
  modelSummarySchema,
  testModelResponseSchema,
  updateModelSchema,
} from '../schemas/model.js';

const UUID = '22222222-2222-4222-8222-222222222222';
const MODEL_UUID = '33333333-3333-4333-8333-333333333333';
const TS = '2025-02-03T04:05:06.000Z';

describe('createModelSchema', () => {
  it('接受完整模型配置', () => {
    const parsed = createModelSchema.parse({
      providerId: UUID,
      modelId: 'deepseek-chat',
      displayName: 'DeepSeek Chat',
      contextWindow: 65536,
      inputPricePer1M: 0.27,
      outputPricePer1M: 1.1,
    });

    expect(parsed.contextWindow).toBe(65536);
    expect(parsed.inputPricePer1M).toBe(0.27);
    expect(parsed.isEnabled).toBe(true);
  });

  it('单价与上下文窗口可省略，默认 0 / null', () => {
    const parsed = createModelSchema.parse({
      providerId: UUID,
      modelId: 'gpt-4o-mini',
      displayName: 'GPT-4o mini',
    });
    expect(parsed.inputPricePer1M).toBe(0);
    expect(parsed.outputPricePer1M).toBe(0);
    expect(parsed.contextWindow).toBeUndefined();
  });

  it('拒绝非法 providerId、空 modelId 与负单价', () => {
    const base = {
      providerId: UUID,
      modelId: 'gpt-4o-mini',
      displayName: 'GPT-4o mini',
    };
    expect(createModelSchema.safeParse({ ...base, providerId: 'abc' }).success).toBe(false);
    expect(createModelSchema.safeParse({ ...base, modelId: '  ' }).success).toBe(false);
    expect(createModelSchema.safeParse({ ...base, displayName: '' }).success).toBe(false);
    expect(createModelSchema.safeParse({ ...base, inputPricePer1M: -0.1 }).success).toBe(false);
    expect(createModelSchema.safeParse({ ...base, outputPricePer1M: -1 }).success).toBe(false);
    expect(createModelSchema.safeParse({ ...base, contextWindow: -1 }).success).toBe(false);
    expect(createModelSchema.safeParse({ ...base, contextWindow: 1.5 }).success).toBe(false);
  });

  it('拒绝未知字段', () => {
    expect(
      createModelSchema.safeParse({
        providerId: UUID,
        modelId: 'm',
        displayName: 'M',
        apiKey: 'sk-leak',
      }).success,
    ).toBe(false);
  });
});

describe('updateModelSchema', () => {
  it('允许局部更新价格与启用状态', () => {
    const parsed = updateModelSchema.parse({ inputPricePer1M: 3, isEnabled: false });
    expect(parsed.inputPricePer1M).toBe(3);
    expect(parsed.isEnabled).toBe(false);
  });

  it('拒绝空更新与负值', () => {
    expect(updateModelSchema.safeParse({}).success).toBe(false);
    expect(updateModelSchema.safeParse({ inputPricePer1M: -1 }).success).toBe(false);
    expect(updateModelSchema.safeParse({ contextWindow: -5 }).success).toBe(false);
  });

  it('不允许通过更新接口迁移 provider', () => {
    expect(updateModelSchema.safeParse({ providerId: UUID }).success).toBe(false);
  });
});

describe('modelDtoSchema', () => {
  const dto = {
    id: MODEL_UUID,
    providerId: UUID,
    modelId: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    contextWindow: null,
    inputPricePer1M: 0.27,
    outputPricePer1M: 1.1,
    isEnabled: true,
    createdAt: TS,
    updatedAt: TS,
  };

  it('接受合法模型 DTO（contextWindow 可为 null）', () => {
    const parsed = modelDtoSchema.parse(dto);
    expect(parsed.contextWindow).toBeNull();
  });

  it('拒绝负单价与非法时间', () => {
    expect(modelDtoSchema.safeParse({ ...dto, inputPricePer1M: -1 }).success).toBe(false);
    expect(modelDtoSchema.safeParse({ ...dto, updatedAt: 'yesterday' }).success).toBe(false);
  });

  it('modelSummarySchema 不含 providerId / 时间字段', () => {
    const summary = modelSummarySchema.parse({
      id: MODEL_UUID,
      modelId: 'deepseek-chat',
      displayName: 'DeepSeek Chat',
      contextWindow: 65536,
      inputPricePer1M: 0,
      outputPricePer1M: 0,
      isEnabled: true,
    });
    expect(summary.contextWindow).toBe(65536);
    expect(modelSummarySchema.safeParse({ ...summary, providerId: UUID }).success).toBe(false);
  });

  it('列表响应结构校验', () => {
    expect(modelListResponseSchema.parse({ items: [dto], total: 1 }).total).toBe(1);
  });
});

describe('testModelResponseSchema', () => {
  const success = {
    success: true,
    replyPreview: '你好，我是梵小说测试回复。',
    latencyMs: 812,
    inputTokens: 24,
    outputTokens: 16,
    estimatedCostUsd: 0.0000123,
    errorCode: null,
    errorMessage: null,
  };

  it('接受成功的测通结果', () => {
    const parsed = testModelResponseSchema.parse(success);
    expect(parsed.success).toBe(true);
    expect(parsed.estimatedCostUsd).toBeCloseTo(0.0000123);
  });

  it('接受失败的测通结果（脱敏错误）', () => {
    const parsed = testModelResponseSchema.parse({
      success: false,
      replyPreview: null,
      latencyMs: 30000,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      errorCode: 'UPSTREAM_TIMEOUT',
      errorMessage: '上游请求超时（未泄露密钥）',
      usageLogId: MODEL_UUID,
    });
    expect(parsed.errorCode).toBe('UPSTREAM_TIMEOUT');
  });

  it('success=true 但携带错误码时判定为契约违规', () => {
    const result = testModelResponseSchema.safeParse({
      ...success,
      errorCode: 'UPSTREAM_ERROR',
      errorMessage: 'boom',
    });
    expect(result.success).toBe(false);
  });

  it('success=false 但缺少错误码时判定为契约违规', () => {
    const result = testModelResponseSchema.safeParse({
      ...success,
      success: false,
      replyPreview: null,
      errorCode: null,
    });
    expect(result.success).toBe(false);
  });

  it('拒绝负的延迟/Token/费用与未知错误码', () => {
    expect(testModelResponseSchema.safeParse({ ...success, latencyMs: -1 }).success).toBe(false);
    expect(testModelResponseSchema.safeParse({ ...success, inputTokens: -1 }).success).toBe(false);
    expect(testModelResponseSchema.safeParse({ ...success, estimatedCostUsd: -0.1 }).success).toBe(
      false,
    );
    expect(testModelResponseSchema.safeParse({ ...success, errorCode: 'SOMETHING' }).success).toBe(
      false,
    );
  });

  it('拒绝缺少必填字段的响应', () => {
    const missing: Record<string, unknown> = { ...success };
    delete missing['latencyMs'];
    expect(testModelResponseSchema.safeParse(missing).success).toBe(false);
  });
});
