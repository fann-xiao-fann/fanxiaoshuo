import {
  AGENT_ROLES,
  API_ERROR_CODES,
  agentRolesResponseSchema,
  updateAgentRolesSchema,
  type AgentRole,
} from '@fanxiaoshuo/shared';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';
import { toAgentRoleRouteDto } from '../mapping/dto.js';
import type { ServerDependencies } from '../server-deps.js';
import type { AgentRoleBindingRecord, UpsertAgentRoleBindingInput } from '../repositories/types.js';
import { parseOrThrow } from './helpers.js';

/** 构造「全部 4 个固定角色」的完整路由视图（未绑定项也返回）。 */
async function buildAgentRolesResponse(deps: ServerDependencies) {
  const records = await deps.agentRoles.list();
  const byRole = new Map<AgentRole, AgentRoleBindingRecord>();
  for (const record of records) {
    byRole.set(record.role, record);
  }
  const roles = AGENT_ROLES.map((role) => toAgentRoleRouteDto(role, byRole.get(role) ?? null));
  return agentRolesResponseSchema.parse({ roles });
}

/** `/api/v1/agent-roles` 路由：查询 / 批量 upsert 或解除绑定。 */
export function registerAgentRoleRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  const base = '/api/v1/agent-roles';

  app.get(base, async () => buildAgentRolesResponse(deps));

  app.put(base, async (request) => {
    const input = parseOrThrow(updateAgentRolesSchema, request.body);

    // 两阶段：先整体校验目标模型存在，避免部分写入后中途失败。
    for (const binding of input.bindings) {
      if (binding.modelId === null) {
        continue;
      }
      const model = await deps.models.findById(binding.modelId);
      if (!model) {
        throw new ApiError(
          API_ERROR_CODES.MODEL_NOT_FOUND,
          `角色 ${binding.role} 绑定的模型不存在或已被删除。`,
        );
      }
    }

    for (const binding of input.bindings) {
      if (binding.modelId === null) {
        await deps.agentRoles.remove(binding.role);
        continue;
      }
      const upsert: UpsertAgentRoleBindingInput = {
        role: binding.role,
        modelId: binding.modelId,
        temperature: binding.temperature,
        maxTokens: binding.maxTokens,
      };
      await deps.agentRoles.upsert(upsert);
    }

    return buildAgentRolesResponse(deps);
  });
}
