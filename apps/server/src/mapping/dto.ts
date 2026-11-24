import {
  AGENT_ROLE_META,
  agentRoleRouteDtoSchema,
  agentRoleSchema,
  apiErrorCodeSchema,
  modelDtoSchema,
  modelSummarySchema,
  providerDtoSchema,
  providerSummarySchema,
  usageLogDtoSchema,
  type AgentRole,
  type AgentRoleRouteDto,
  type ApiErrorCode,
  type ModelDto,
  type ModelSummary,
  type ProviderDto,
  type ProviderSummary,
  type UsageLogDto,
  type UsageLogStatus,
} from '@fanxiaoshuo/shared';
import type {
  AgentRoleBindingRecord,
  ModelRecord,
  ProviderRecord,
  UsageLogRecord,
} from '../repositories/types.js';

/** 角色未绑定时的默认采样温度（与 `agent_role_bindings.temperature` 默认值一致）。 */
export const DEFAULT_ROLE_TEMPERATURE = 0.7;

/** Provider 行 → 对外 DTO（绝不包含密文 / 明文 Key）。 */
export function toProviderDto(record: ProviderRecord): ProviderDto {
  return providerDtoSchema.parse({
    id: record.id,
    name: record.name,
    protocol: record.protocol,
    baseUrl: record.baseUrl,
    apiKeyMask: record.apiKeyMask,
    isEnabled: record.isEnabled,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

export function toProviderSummary(record: ProviderRecord): ProviderSummary {
  return providerSummarySchema.parse({
    id: record.id,
    name: record.name,
    protocol: record.protocol,
    isEnabled: record.isEnabled,
  });
}

export function toModelDto(record: ModelRecord): ModelDto {
  return modelDtoSchema.parse({
    id: record.id,
    providerId: record.providerId,
    modelId: record.modelId,
    displayName: record.displayName,
    contextWindow: record.contextWindow,
    inputPricePer1M: record.inputPricePer1m,
    outputPricePer1M: record.outputPricePer1m,
    isEnabled: record.isEnabled,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

export function toModelSummary(record: ModelRecord): ModelSummary {
  return modelSummarySchema.parse({
    id: record.id,
    modelId: record.modelId,
    displayName: record.displayName,
    contextWindow: record.contextWindow,
    inputPricePer1M: record.inputPricePer1m,
    outputPricePer1M: record.outputPricePer1m,
    isEnabled: record.isEnabled,
  });
}

/**
 * 角色路由 DTO：始终返回 4 个固定角色的完整视图。
 * `binding` 为 null 表示未绑定，此时模型/供应商/时间字段均为 null。
 */
export function toAgentRoleRouteDto(
  role: AgentRole,
  binding: AgentRoleBindingRecord | null,
): AgentRoleRouteDto {
  const meta = AGENT_ROLE_META[role];
  return agentRoleRouteDtoSchema.parse({
    role,
    roleLabel: meta.label,
    responsibility: meta.responsibility,
    modelId: binding ? binding.modelId : null,
    temperature: binding ? binding.temperature : DEFAULT_ROLE_TEMPERATURE,
    maxTokens: binding ? binding.maxTokens : null,
    updatedAt: binding ? binding.updatedAt.toISOString() : null,
    model: binding?.model ? toModelSummary(binding.model) : null,
    provider: binding?.provider ? toProviderSummary(binding.provider) : null,
  });
}

/** 用量日志行 → 对外 DTO。 */
export function toUsageLogDto(record: UsageLogRecord): UsageLogDto {
  return usageLogDtoSchema.parse({
    id: record.id,
    role: record.role,
    providerId: record.providerId,
    modelRef: record.modelRef,
    scene: record.scene,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    estimatedCostUsd: record.estimatedCostUsd,
    latencyMs: record.latencyMs,
    status: record.status,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt.toISOString(),
  });
}

/** 数据库文本 → 受控角色枚举（脏数据回退 null，避免审计页整体 500）。 */
export function parseAgentRole(value: string | null | undefined): AgentRole | null {
  if (value === null || value === undefined) {
    return null;
  }
  const result = agentRoleSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** 数据库文本 → 统一错误码（未知值回退 null）。 */
export function parseApiErrorCode(value: string | null | undefined): ApiErrorCode | null {
  if (value === null || value === undefined) {
    return null;
  }
  const result = apiErrorCodeSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** 数据库文本 → 用量状态（默认 success，兼容历史数据）。 */
export function parseUsageLogStatus(value: string | null | undefined): UsageLogStatus {
  return value === 'error' ? 'error' : 'success';
}
