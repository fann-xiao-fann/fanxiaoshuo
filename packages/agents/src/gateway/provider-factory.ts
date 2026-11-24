import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { API_ERROR_CODES } from '@fanxiaoshuo/shared';
import type { LanguageModel } from 'ai';
import { ModelGatewayError } from './errors.js';
import type { ResolvedModelConfig } from './types.js';

/**
 * 按协议创建 AI SDK LanguageModel。
 *
 * - `openai-compatible`：自建 / 第三方中转站（绝大多数国产中转站），走 `@ai-sdk/openai-compatible`
 * - `openai` / `anthropic` / `google`：官方适配器
 *
 * 本函数只做客户端实例化，不发起网络请求；密钥仅保存在返回的模型实例闭包内。
 */
export function createLanguageModel(config: ResolvedModelConfig): LanguageModel {
  const common = {
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  };

  switch (config.protocol) {
    case 'openai-compatible':
      return createOpenAICompatible({
        name: config.providerName,
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
      })(config.modelId);

    case 'openai':
      return createOpenAI({ ...common, name: config.providerName })(config.modelId);

    case 'anthropic':
      return createAnthropic(common)(config.modelId);

    case 'google':
      return createGoogleGenerativeAI({ ...common, name: config.providerName })(config.modelId);

    default:
      return assertUnsupportedProtocol(config.protocol);
  }
}

function assertUnsupportedProtocol(protocol: never): never {
  throw new ModelGatewayError(`不支持的上游协议：${String(protocol)}`, {
    category: 'PROVIDER_ERROR',
    code: API_ERROR_CODES.INTERNAL_ERROR,
  });
}
