import { AGENT_ROLE_META, API_ERROR_CODES, type AgentRole } from '@fanxiaoshuo/shared';
import type { ResolvedModelConfig } from '@fanxiaoshuo/agents';
import { SecretCodecError } from '../crypto/secret-codec.js';
import { ApiError } from '../errors.js';
import type { ServerDependencies } from '../server-deps.js';

/**
 * 写书角色 → 可用模型配置的解析服务（Book Bible / AI 写作 / 摘要提炼共用）。
 *
 * 解析链路：`agent_role_bindings` → `llm_models` → `llm_providers` → 解密 API Key。
 * 所有失败都在建立 SSE 流之前以标准 `ApiError` 抛出，使前端能收到规范 JSON 错误。
 */

/** 解析结果：可直接传给 `ModelGateway` 的模型配置 + 角色默认采样参数。 */
export interface ResolvedRoleModel {
  readonly config: ResolvedModelConfig;
  /** 角色绑定的默认采样温度 */
  readonly temperature: number;
  /** 角色绑定的输出 Token 上限（未配置为 null） */
  readonly maxTokens: number | null;
}

function roleLabel(role: AgentRole): string {
  return AGENT_ROLE_META[role].label;
}

/**
 * 解析指定角色的模型配置。
 *
 * @throws {ApiError} `409 AGENT_ROLE_UNBOUND` 角色未绑定 /
 *   `404 MODEL_NOT_FOUND` 模型已删除 /
 *   `409 PROVIDER_DISABLED` / `409 MODEL_DISABLED` 启停校验失败 /
 *   `500 ENCRYPTION_KEY_INVALID` 密钥解密失败
 */
export async function resolveRoleModel(
  deps: ServerDependencies,
  role: AgentRole,
): Promise<ResolvedRoleModel> {
  const bindings = await deps.agentRoles.list();
  const binding = bindings.find((item) => item.role === role);

  if (!binding) {
    throw new ApiError(
      API_ERROR_CODES.AGENT_ROLE_UNBOUND,
      `写书角色「${roleLabel(role)}」尚未绑定可用模型，请前往「模型配置」为该角色绑定模型后重试。`,
    );
  }

  const related = await deps.models.findWithProvider(binding.modelId);
  if (!related) {
    throw new ApiError(
      API_ERROR_CODES.MODEL_NOT_FOUND,
      `角色「${roleLabel(role)}」绑定的模型不存在或已被删除，请前往「模型配置」重新绑定。`,
    );
  }

  const { model, provider } = related;

  if (!provider.isEnabled) {
    throw new ApiError(
      API_ERROR_CODES.PROVIDER_DISABLED,
      `角色「${roleLabel(role)}」绑定的供应商「${provider.name}」已停用，请先在「模型配置」中启用。`,
    );
  }
  if (!model.isEnabled) {
    throw new ApiError(
      API_ERROR_CODES.MODEL_DISABLED,
      `角色「${roleLabel(role)}」绑定的模型「${model.displayName}」已停用，请先在「模型配置」中启用。`,
    );
  }

  let apiKey: string;
  try {
    apiKey = deps.codec.decrypt(provider.apiKeyEncrypted);
  } catch (error) {
    if (error instanceof SecretCodecError) {
      throw new ApiError(
        API_ERROR_CODES.ENCRYPTION_KEY_INVALID,
        '供应商 API Key 解密失败：APP_ENCRYPTION_KEY 可能已变更，请重新保存该供应商密钥。',
        { cause: error },
      );
    }
    throw error;
  }

  const config: ResolvedModelConfig = {
    providerId: provider.id,
    providerName: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey,
    modelId: model.modelId,
    displayName: model.displayName,
    inputPricePer1m: model.inputPricePer1m,
    outputPricePer1m: model.outputPricePer1m,
  };

  return {
    config,
    temperature: binding.temperature,
    maxTokens: binding.maxTokens,
  };
}
