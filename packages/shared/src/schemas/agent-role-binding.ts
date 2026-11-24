import { z } from 'zod';
import { AGENT_ROLES, agentRoleSchema } from '../constants/agent-roles.js';
import { isoDateTimeSchema, uuidSchema } from './primitives.js';
import { modelSummarySchema } from './model.js';
import { providerSummarySchema } from './provider.js';

/** 单角色绑定入参。`modelId: null` 表示显式解除绑定。 */
export const agentRoleBindingInputSchema = z.strictObject({
  role: agentRoleSchema,
  modelId: uuidSchema.nullable(),
  /** 采样温度 0–2（各 Provider 通用上限），默认 0.7 */
  temperature: z.number().min(0).max(2).default(0.7),
  /** 单次输出 Token 上限，null 表示使用上游默认 */
  maxTokens: z.number().int().positive().max(1_000_000).nullable().default(null),
});

export type AgentRoleBindingInput = z.infer<typeof agentRoleBindingInputSchema>;
export type AgentRoleBindingInputPayload = z.input<typeof agentRoleBindingInputSchema>;

/**
 * `PUT /api/v1/agent-roles` 请求体：批量更新 4 个固定角色槽位。
 * 角色不可重复，避免同一次请求内互相覆盖。
 */
export const updateAgentRolesSchema = z
  .strictObject({
    bindings: z.array(agentRoleBindingInputSchema).min(1).max(AGENT_ROLES.length),
  })
  .refine(
    (value) => new Set(value.bindings.map((binding) => binding.role)).size === value.bindings.length,
    { message: '同一角色在单次请求中只能出现一次', path: ['bindings'] },
  )
  .describe('批量更新写书 Agent 角色模型绑定');

export type UpdateAgentRolesInput = z.infer<typeof updateAgentRolesSchema>;
export type UpdateAgentRolesInputPayload = z.input<typeof updateAgentRolesSchema>;

/**
 * `GET /api/v1/agent-roles` 单条角色路由 DTO。
 * 未绑定时 `modelId` / `updatedAt` / `model` / `provider` 均为 null，前端据此展示「未绑定」。
 */
export const agentRoleRouteDtoSchema = z.strictObject({
  role: agentRoleSchema,
  /** 中文显示名（来自 AGENT_ROLE_META，避免前端重复维护文案） */
  roleLabel: z.string().min(1),
  responsibility: z.string().min(1),
  modelId: uuidSchema.nullable(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive().nullable(),
  updatedAt: isoDateTimeSchema.nullable(),
  model: modelSummarySchema.nullable(),
  provider: providerSummarySchema.nullable(),
});

export type AgentRoleRouteDto = z.infer<typeof agentRoleRouteDtoSchema>;

/** `GET /api/v1/agent-roles` 响应。 */
export const agentRolesResponseSchema = z.strictObject({
  roles: z.array(agentRoleRouteDtoSchema),
});

export type AgentRolesResponse = z.infer<typeof agentRolesResponseSchema>;
