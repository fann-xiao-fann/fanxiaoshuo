import { describe, expect, it } from 'vitest';
import {
  PROVIDER_PROTOCOLS,
  PROVIDER_PROTOCOL_META,
  isProviderProtocol,
  providerProtocolSchema,
} from '../constants/provider-protocols.js';

describe('PROVIDER_PROTOCOLS', () => {
  it('包含 4 种受支持协议', () => {
    expect(PROVIDER_PROTOCOLS).toEqual(['openai-compatible', 'openai', 'anthropic', 'google']);
  });

  it('schema 拒绝未知协议', () => {
    expect(providerProtocolSchema.safeParse('openai-compatible').success).toBe(true);
    expect(providerProtocolSchema.safeParse('azure').success).toBe(false);
    expect(providerProtocolSchema.safeParse('').success).toBe(false);
  });

  it('每个协议都有展示元信息与默认 Base URL', () => {
    for (const protocol of PROVIDER_PROTOCOLS) {
      const meta = PROVIDER_PROTOCOL_META[protocol];
      expect(meta.protocol).toBe(protocol);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.defaultBaseUrl.startsWith('https://')).toBe(true);
      expect(new URL(meta.defaultBaseUrl).protocol).toBe('https:');
    }
  });

  it('只有 openai-compatible 强制要求自定义 Base URL', () => {
    expect(PROVIDER_PROTOCOL_META['openai-compatible'].requiresCustomBaseUrl).toBe(true);
    expect(PROVIDER_PROTOCOL_META.openai.requiresCustomBaseUrl).toBe(false);
  });

  it('isProviderProtocol 类型守卫行为正确', () => {
    expect(isProviderProtocol('google')).toBe(true);
    expect(isProviderProtocol('Google')).toBe(false);
  });
});
