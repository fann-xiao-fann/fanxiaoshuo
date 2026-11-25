import type { AgentRole, AgentRolesResponse, ModelDto, ProviderDto } from '@fanxiaoshuo/shared';
import type { TestServerContext } from './in-memory.js';

/** 测试用上游明文 Key（仅用于验证「响应绝不回显明文密钥」）。 */
export const TEST_PROVIDER_API_KEY = 'sk-writer-secret-key-1234567890';

export interface SeededModel {
  readonly providerId: string;
  readonly modelId: string;
  /** `providerName/modelId` 快照 */
  readonly modelRef: string;
  readonly modelRefName: string;
}

/** 通过真实路由创建 Provider + Model（与生产写路径一致，自动加密 Key）。 */
export async function seedProviderAndModel(
  context: TestServerContext,
  overrides: {
    providerName?: string;
    providerEnabled?: boolean;
    modelEnabled?: boolean;
    modelId?: string;
    inputPricePer1M?: number;
    outputPricePer1M?: number;
  } = {},
): Promise<SeededModel> {
  const providerName = overrides.providerName ?? 'Mock Provider';
  const upstreamModelId = overrides.modelId ?? 'mock-model';

  const providerResponse = await context.app.inject({
    method: 'POST',
    url: '/api/v1/providers',
    payload: {
      name: providerName,
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKey: TEST_PROVIDER_API_KEY,
      isEnabled: overrides.providerEnabled ?? true,
    },
  });
  if (providerResponse.statusCode !== 201) {
    throw new Error(`创建供应商失败：${providerResponse.statusCode} ${providerResponse.body}`);
  }
  const providerId = providerResponse.json<ProviderDto>().id;

  const modelResponse = await context.app.inject({
    method: 'POST',
    url: '/api/v1/models',
    payload: {
      providerId,
      modelId: upstreamModelId,
      displayName: 'Mock Writer Model',
      inputPricePer1M: overrides.inputPricePer1M ?? 1,
      outputPricePer1M: overrides.outputPricePer1M ?? 2,
      isEnabled: overrides.modelEnabled ?? true,
    },
  });
  if (modelResponse.statusCode !== 201) {
    throw new Error(`创建模型失败：${modelResponse.statusCode} ${modelResponse.body}`);
  }
  const modelId = modelResponse.json<ModelDto>().id;

  return {
    providerId,
    modelId,
    modelRef: `${providerName}/${upstreamModelId}`,
    modelRefName: upstreamModelId,
  };
}

/** 通过真实路由绑定写书角色。 */
export async function bindRole(
  context: TestServerContext,
  role: AgentRole,
  modelId: string,
  options: { temperature?: number; maxTokens?: number | null } = {},
): Promise<void> {
  const response = await context.app.inject({
    method: 'PUT',
    url: '/api/v1/agent-roles',
    payload: {
      bindings: [
        {
          role,
          modelId,
          temperature: options.temperature ?? 0.7,
          maxTokens: options.maxTokens ?? null,
        },
      ],
    },
  });
  if (response.statusCode !== 200) {
    throw new Error(`绑定角色失败：${response.statusCode} ${response.body}`);
  }
  const roles = response.json<AgentRolesResponse>().roles;
  const bound = roles.find((item) => item.role === role);
  if (!bound || bound.modelId !== modelId) {
    throw new Error(`角色绑定未生效：${role}`);
  }
}

/** 通过真实路由解除角色绑定。 */
export async function unbindRole(context: TestServerContext, role: AgentRole): Promise<void> {
  const response = await context.app.inject({
    method: 'PUT',
    url: '/api/v1/agent-roles',
    payload: { bindings: [{ role, modelId: null }] },
  });
  if (response.statusCode !== 200) {
    throw new Error(`解绑角色失败：${response.statusCode} ${response.body}`);
  }
}
