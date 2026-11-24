import { describe, expect, it } from 'vitest';
import {
  createProviderSchema,
  providerDtoSchema,
  providerListResponseSchema,
  providerSummarySchema,
  updateProviderSchema,
} from '../schemas/provider.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const UPDATED = '2025-01-02T03:04:05.000Z';

describe('createProviderSchema', () => {
  it('接受合法的 OpenAI-compatible 供应商并默认启用', () => {
    const parsed = createProviderSchema.parse({
      name: '  中转一号  ',
      protocol: 'openai-compatible',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: '  sk-test-1234567890  ',
    });

    expect(parsed.name).toBe('中转一号');
    expect(parsed.apiKey).toBe('sk-test-1234567890');
    expect(parsed.protocol).toBe('openai-compatible');
    expect(parsed.isEnabled).toBe(true);
  });

  it('允许显式指定 isEnabled=false', () => {
    const parsed = createProviderSchema.parse({
      name: 'Anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-12345',
      isEnabled: false,
    });
    expect(parsed.isEnabled).toBe(false);
  });

  it('拒绝空名称、非法 Base URL、缺失 API Key 与未知协议', () => {
    const base = {
      name: 'ok',
      protocol: 'openai' as const,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-1',
    };

    expect(createProviderSchema.safeParse({ ...base, name: '' }).success).toBe(false);
    expect(createProviderSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
    expect(createProviderSchema.safeParse({ ...base, baseUrl: 'not-a-url' }).success).toBe(false);
    expect(createProviderSchema.safeParse({ ...base, baseUrl: 'ftp://x.com' }).success).toBe(false);
    expect(createProviderSchema.safeParse({ ...base, apiKey: '' }).success).toBe(false);
    expect(createProviderSchema.safeParse({ ...base, apiKey: undefined }).success).toBe(false);
    expect(createProviderSchema.safeParse({ ...base, protocol: 'azure' }).success).toBe(false);
  });

  it('严格模式下拒绝未知字段（防止明文密钥等脏字段混入）', () => {
    const result = createProviderSchema.safeParse({
      name: 'ok',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-1',
      apiKeyEncrypted: 'v1:deadbeef',
    });
    expect(result.success).toBe(false);
  });

  it('校验失败的 issue 能定位到具体字段', () => {
    const result = createProviderSchema.safeParse({
      name: 'ok',
      protocol: 'openai',
      baseUrl: 'nope',
      apiKey: 'sk-1',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('baseUrl'))).toBe(true);
    }
  });
});

describe('updateProviderSchema', () => {
  it('允许仅更新名称', () => {
    const parsed = updateProviderSchema.parse({ name: '新名字' });
    expect(parsed.name).toBe('新名字');
    expect(parsed.apiKey).toBeUndefined();
  });

  it('允许留空 apiKey 表示保留原密钥', () => {
    expect(updateProviderSchema.safeParse({ baseUrl: 'https://x.example.com/v1', apiKey: '' }).success).toBe(
      true,
    );
  });

  it('拒绝空对象与只给空白 apiKey', () => {
    expect(updateProviderSchema.safeParse({}).success).toBe(false);
    expect(updateProviderSchema.safeParse({ apiKey: '   ' }).success).toBe(false);
  });

  it('拒绝非法字段值', () => {
    expect(updateProviderSchema.safeParse({ name: '' }).success).toBe(false);
    expect(updateProviderSchema.safeParse({ baseUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(updateProviderSchema.safeParse({ protocol: 'ollama' }).success).toBe(false);
    expect(updateProviderSchema.safeParse({ isEnabled: 'yes' }).success).toBe(false);
  });
});

describe('providerDtoSchema', () => {
  const dto = {
    id: UUID,
    name: '中转一号',
    protocol: 'openai-compatible',
    baseUrl: 'https://relay.example.com/v1',
    apiKeyMask: 'sk-***9f2a',
    isEnabled: true,
    createdAt: UPDATED,
    updatedAt: UPDATED,
  };

  it('接受仅含脱敏指纹的 DTO', () => {
    const parsed = providerDtoSchema.parse(dto);
    expect(parsed.apiKeyMask).toBe('sk-***9f2a');
  });

  it('拒绝任何携带明文 apiKey 的响应对象', () => {
    const result = providerDtoSchema.safeParse({ ...dto, apiKey: 'sk-secret-abcdef' });
    expect(result.success).toBe(false);
  });

  it('拒绝携带加密密文的响应对象', () => {
    expect(providerDtoSchema.safeParse({ ...dto, apiKeyEncrypted: 'v1:aa:bb:cc' }).success).toBe(false);
  });

  it('拒绝非法 id / 时间格式 / 缺失掩码', () => {
    expect(providerDtoSchema.safeParse({ ...dto, id: 'not-uuid' }).success).toBe(false);
    expect(providerDtoSchema.safeParse({ ...dto, createdAt: '2025-01-02' }).success).toBe(false);
    expect(providerDtoSchema.safeParse({ ...dto, apiKeyMask: '' }).success).toBe(false);
  });

  it('允许带时区偏移的 ISO 时间', () => {
    expect(
      providerDtoSchema.safeParse({ ...dto, createdAt: '2025-01-02T03:04:05+08:00' }).success,
    ).toBe(true);
  });
});

describe('providerSummary / providerListResponse', () => {
  it('摘要仅含展示与启用状态字段', () => {
    const summary = providerSummarySchema.parse({
      id: UUID,
      name: '中转一号',
      protocol: 'openai-compatible',
      isEnabled: false,
    });
    expect(summary.isEnabled).toBe(false);
    expect(providerSummarySchema.safeParse({ ...summary, baseUrl: 'https://x.com' }).success).toBe(
      false,
    );
  });

  it('列表响应结构校验', () => {
    const list = providerListResponseSchema.parse({ items: [], total: 0 });
    expect(list.items).toHaveLength(0);
    expect(providerListResponseSchema.safeParse({ items: [], total: -1 }).success).toBe(false);
  });
});
