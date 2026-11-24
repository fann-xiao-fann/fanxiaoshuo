import { z } from 'zod';

/**
 * 支持的 LLM 上游协议。
 * `openai-compatible` 覆盖自建/第三方中转站（绝大多数国产中转站），
 * 其余三类为官方适配器。
 */
export const PROVIDER_PROTOCOLS = ['openai-compatible', 'openai', 'anthropic', 'google'] as const;

export const providerProtocolSchema = z.enum(PROVIDER_PROTOCOLS);

export type ProviderProtocol = z.infer<typeof providerProtocolSchema>;

export interface ProviderProtocolMeta {
  readonly protocol: ProviderProtocol;
  readonly label: string;
  /** 官方默认 Base URL，仅作为前端表单提示值，不强制写入数据库 */
  readonly defaultBaseUrl: string;
  readonly requiresCustomBaseUrl: boolean;
}

export const PROVIDER_PROTOCOL_META = {
  'openai-compatible': {
    protocol: 'openai-compatible',
    label: 'OpenAI 兼容中转',
    defaultBaseUrl: 'https://api.example.com/v1',
    requiresCustomBaseUrl: true,
  },
  openai: {
    protocol: 'openai',
    label: 'OpenAI 官方',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresCustomBaseUrl: false,
  },
  anthropic: {
    protocol: 'anthropic',
    label: 'Anthropic 官方',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    requiresCustomBaseUrl: false,
  },
  google: {
    protocol: 'google',
    label: 'Google Gemini 官方',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresCustomBaseUrl: false,
  },
} as const satisfies Record<ProviderProtocol, ProviderProtocolMeta>;

export function isProviderProtocol(value: string): value is ProviderProtocol {
  return (PROVIDER_PROTOCOLS as readonly string[]).includes(value);
}
