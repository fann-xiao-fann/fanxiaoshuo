import {
  AGENT_ROLES,
  type AgentRole,
  type AgentRoleBindingInput,
  type AgentRoleRouteDto,
  type AgentRolesResponse,
  type CreateModelInputPayload,
  type CreateProviderInputPayload,
  type ModelDto,
  type ProviderDto,
  type TestModelResponse,
  type UpdateModelInputPayload,
  type UpdateProviderInputPayload,
} from '@fanxiaoshuo/shared';
import { defineStore } from 'pinia';
import { agentRoleApi } from '@/api/agent-roles';
import { describeError } from '@/api/errors';
import { modelApi } from '@/api/models';
import { providerApi } from '@/api/providers';

interface RegistryState {
  providers: ProviderDto[];
  models: ModelDto[];
  roles: AgentRoleRouteDto[];
  providersLoading: boolean;
  modelsLoading: boolean;
  rolesLoading: boolean;
  providersError: string | null;
  modelsError: string | null;
  rolesError: string | null;
  loadedOnce: boolean;
}

export const useRegistryStore = defineStore('fx-registry', {
  state: (): RegistryState => ({
    providers: [],
    models: [],
    roles: [],
    providersLoading: false,
    modelsLoading: false,
    rolesLoading: false,
    providersError: null,
    modelsError: null,
    rolesError: null,
    loadedOnce: false,
  }),

  getters: {
    providerById(state) {
      return (id: string): ProviderDto | undefined => state.providers.find((item) => item.id === id);
    },
    modelById(state) {
      return (id: string): ModelDto | undefined => state.models.find((item) => item.id === id);
    },
    providerName(state) {
      return (id: string): string =>
        state.providers.find((item) => item.id === id)?.name ?? '未知供应商';
    },
    enabledModels(state): ModelDto[] {
      return state.models.filter((model) => model.isEnabled);
    },
    modelsOfProvider(state) {
      return (providerId: string): ModelDto[] =>
        state.models.filter((model) => model.providerId === providerId);
    },
    roleByRole(state) {
      return (role: AgentRole): AgentRoleRouteDto | undefined =>
        state.roles.find((item) => item.role === role);
    },
    boundModelIds(state): Set<string> {
      return new Set(
        state.roles
          .map((item) => item.modelId)
          .filter((id): id is string => typeof id === 'string'),
      );
    },
    /** 角色面板固定按 策划 → 设定 → 执笔 → 审稿 顺序输出。 */
    orderedRoles(state): AgentRoleRouteDto[] {
      const byRole = new Map(state.roles.map((item) => [item.role, item]));
      return AGENT_ROLES.map((role) => byRole.get(role)).filter(
        (item): item is AgentRoleRouteDto => item !== undefined,
      );
    },
  },

  actions: {
    async loadProviders(): Promise<void> {
      this.providersLoading = true;
      this.providersError = null;
      try {
        const response = await providerApi.list();
        this.providers = response.items;
      } catch (error) {
        this.providersError = describeError(error);
        throw error;
      } finally {
        this.providersLoading = false;
      }
    },

    async loadModels(): Promise<void> {
      this.modelsLoading = true;
      this.modelsError = null;
      try {
        const response = await modelApi.list();
        this.models = response.items;
      } catch (error) {
        this.modelsError = describeError(error);
        throw error;
      } finally {
        this.modelsLoading = false;
      }
    },

    async loadRoles(): Promise<void> {
      this.rolesLoading = true;
      this.rolesError = null;
      try {
        const response: AgentRolesResponse = await agentRoleApi.list();
        this.roles = response.roles;
      } catch (error) {
        this.rolesError = describeError(error);
        throw error;
      } finally {
        this.rolesLoading = false;
      }
    },

    /** 首次进入页面并行加载；单个失败不影响其余区块渲染。 */
    async loadAll(): Promise<void> {
      const results = await Promise.allSettled([
        this.loadProviders(),
        this.loadModels(),
        this.loadRoles(),
      ]);
      this.loadedOnce = true;
      const rejected = results.find((item) => item.status === 'rejected');
      if (rejected !== undefined) {
        throw rejected.reason;
      }
    },

    async createProvider(payload: CreateProviderInputPayload): Promise<ProviderDto> {
      const created = await providerApi.create(payload);
      await this.loadProviders();
      return created;
    },

    async updateProvider(id: string, payload: UpdateProviderInputPayload): Promise<ProviderDto> {
      const updated = await providerApi.update(id, payload);
      await this.loadProviders();
      return updated;
    },

    async toggleProvider(id: string, isEnabled: boolean): Promise<void> {
      await this.updateProvider(id, { isEnabled });
    },

    async deleteProvider(id: string): Promise<void> {
      await providerApi.remove(id);
      await Promise.all([this.loadProviders(), this.loadModels(), this.loadRoles()]);
    },

    async createModel(payload: CreateModelInputPayload): Promise<ModelDto> {
      const created = await modelApi.create(payload);
      await this.loadModels();
      return created;
    },

    async updateModel(id: string, payload: UpdateModelInputPayload): Promise<ModelDto> {
      const updated = await modelApi.update(id, payload);
      await this.loadModels();
      return updated;
    },

    async toggleModel(id: string, isEnabled: boolean): Promise<void> {
      await this.updateModel(id, { isEnabled });
    },

    async deleteModel(id: string): Promise<void> {
      await modelApi.remove(id);
      await Promise.all([this.loadModels(), this.loadRoles()]);
    },

    async testModel(id: string): Promise<TestModelResponse> {
      return modelApi.test(id);
    },

    /**
     * 保存单个角色的绑定：以当前全部角色状态为基底整体提交，
     * 避免部分更新语义差异导致其它角色被意外清空。
     */
    async saveRoleBinding(input: AgentRoleBindingInput): Promise<void> {
      const current: AgentRoleBindingInput[] = this.roles.map((item) => ({
        role: item.role,
        modelId: item.modelId,
        temperature: item.temperature,
        maxTokens: item.maxTokens,
      }));
      const existingIndex = current.findIndex((item) => item.role === input.role);
      const nextBinding: AgentRoleBindingInput = {
        role: input.role,
        modelId: input.modelId,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      };
      if (existingIndex >= 0) {
        current[existingIndex] = nextBinding;
      } else {
        current.push(nextBinding);
      }
      await agentRoleApi.save({ bindings: current });
      await this.loadRoles();
    },
  },
});
