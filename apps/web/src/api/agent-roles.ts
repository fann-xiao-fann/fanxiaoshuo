import {
  agentRolesResponseSchema,
  type AgentRolesResponse,
  type UpdateAgentRolesInputPayload,
} from '@fanxiaoshuo/shared';
import { apiRequest, apiRequestVoid } from './http';

/** `/api/v1/agent-roles` 强类型客户端（4 个固定写书角色槽位）。 */
export const agentRoleApi = {
  list(): Promise<AgentRolesResponse> {
    return apiRequest('/agent-roles', agentRolesResponseSchema);
  },

  /**
   * 批量保存角色绑定。共享契约只定义了 GET 响应结构，
   * 因此 PUT 成功后统一重新拉取 GET 列表，避免对未冻结响应体做假设。
   */
  async save(payload: UpdateAgentRolesInputPayload): Promise<void> {
    await apiRequestVoid('/agent-roles', { method: 'PUT', body: payload });
  },
};
