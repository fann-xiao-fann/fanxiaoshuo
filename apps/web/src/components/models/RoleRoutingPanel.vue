<script setup lang="ts">
import {
  AGENT_ROLES,
  type AgentRole,
  type AgentRoleBindingInput,
} from '@fanxiaoshuo/shared';
import {
  NButton,
  NIcon,
  NInputNumber,
  NSelect,
  NSlider,
  NTag,
  useMessage,
  type SelectGroupOption,
} from 'naive-ui';
import { RefreshOutline, SaveOutline } from '@vicons/ionicons5';
import { computed, reactive, ref, watch } from 'vue';
import { describeError } from '@/api/errors';
import { useRegistryStore } from '@/stores/registry';
import { formatDateTime } from '@/utils/format';

interface RoleDraft {
  modelId: string | null;
  temperature: number;
  maxTokens: number | null;
}

const registry = useRegistryStore();
const message = useMessage();

const drafts = reactive<Record<AgentRole, RoleDraft>>({
  showrunner: { modelId: null, temperature: 0.7, maxTokens: null },
  lorekeeper: { modelId: null, temperature: 0.7, maxTokens: null },
  writer: { modelId: null, temperature: 0.7, maxTokens: null },
  critic: { modelId: null, temperature: 0.7, maxTokens: null },
});

function syncDrafts(): void {
  for (const role of AGENT_ROLES) {
    const current = registry.roleByRole(role);
    const draft = drafts[role];
    if (current === undefined) {
      draft.modelId = null;
      draft.temperature = 0.7;
      draft.maxTokens = null;
      continue;
    }
    draft.modelId = current.modelId;
    draft.temperature = current.temperature;
    draft.maxTokens = current.maxTokens;
  }
}

watch(
  () => registry.roles,
  () => {
    syncDrafts();
  },
  { immediate: true, deep: true },
);

const savingRole = ref<AgentRole | null>(null);

/**
 * 按供应商分组的可选模型。停用模型仍展示但不可选，
 * 便于用户理解当前绑定的模型为何不可用。
 */
const modelOptions = computed<SelectGroupOption[]>(() =>
  registry.providers
    .map((provider) => ({
      type: 'group' as const,
      key: provider.id,
      label: `${provider.name}${provider.isEnabled ? '' : '（供应商已停用）'}`,
      children: registry.modelsOfProvider(provider.id).map((model) => ({
        label: `${model.displayName} · ${model.modelId}${model.isEnabled ? '' : '（已停用）'}`,
        value: model.id,
        disabled: !model.isEnabled || !provider.isEnabled,
      })),
    }))
    .filter((group) => group.children.length > 0),
);

const roles = computed(() => registry.orderedRoles);

async function saveRole(role: AgentRole): Promise<void> {
  const draft = drafts[role];
  const temperature =
    typeof draft.temperature === 'number' && Number.isFinite(draft.temperature)
      ? Math.min(2, Math.max(0, draft.temperature))
      : 0.7;
  const maxTokens =
    typeof draft.maxTokens === 'number' && Number.isFinite(draft.maxTokens)
      ? Math.min(1_000_000, Math.max(1, Math.round(draft.maxTokens)))
      : null;
  const payload: AgentRoleBindingInput = {
    role,
    modelId: draft.modelId,
    temperature,
    maxTokens,
  };

  savingRole.value = role;
  try {
    await registry.saveRoleBinding(payload);
    message.success(`${roleLabel(role)} 的模型路由已保存`);
  } catch (error) {
    message.error(describeError(error));
  } finally {
    savingRole.value = null;
  }
}

function roleLabel(role: AgentRole): string {
  return registry.roleByRole(role)?.roleLabel ?? role;
}

function roleBinding(role: AgentRole) {
  return registry.roleByRole(role);
}
</script>

<template>
  <section class="fx-panel">
    <header class="fx-panel__head">
      <div>
        <div class="fx-panel__title">写书 Agent 角色路由</div>
        <div class="fx-panel__subtitle">
          为总编策划、设定档案员、执笔写手与审稿质检分别绑定默认模型，并覆写温度与单次输出上限。
          保存后，运行期所有调用按角色解析到对应供应商与模型，并统一落入 Token / 费用账本。
        </div>
      </div>
      <div class="fx-panel__actions">
        <n-button size="small" quaternary :loading="registry.rolesLoading" @click="registry.loadRoles()">
          <template #icon>
            <n-icon><refresh-outline /></n-icon>
          </template>
          重新加载
        </n-button>
      </div>
    </header>

    <div class="fx-panel__body">
      <p v-if="registry.rolesError" class="fx-error-text" style="margin-bottom: 14px">
        {{ registry.rolesError }}
      </p>

      <div v-if="roles.length === 0" class="fx-empty">
        尚未加载到角色路由配置。请确认后端已启动并已完成数据库迁移。
      </div>

      <div v-else class="fx-role-grid">
        <article v-for="role in roles" :key="role.role" class="fx-role-card">
          <div class="fx-role-card__head">
            <div>
              <div class="fx-role-card__name">
                {{ role.roleLabel }}
                <span class="fx-role-card__en">{{ role.role }}</span>
              </div>
              <div class="fx-role-card__resp">{{ role.responsibility }}</div>
            </div>
            <n-tag
              size="small"
              round
              :bordered="false"
              :type="role.modelId === null ? 'warning' : 'success'"
            >
              {{ role.modelId === null ? '未绑定' : '已绑定' }}
            </n-tag>
          </div>

          <div class="fx-stack" style="gap: 6px">
            <span class="fx-result-metric__label">绑定模型</span>
            <n-select
              v-model:value="drafts[role.role].modelId"
              :options="modelOptions"
              size="small"
              filterable
              clearable
              placeholder="选择该角色使用的模型（清空即解除绑定）"
            />
          </div>

          <div class="fx-stack" style="gap: 6px">
            <div class="fx-inline" style="justify-content: space-between">
              <span class="fx-result-metric__label">Temperature</span>
              <span class="fx-mono" style="font-size: 12px">
                {{ drafts[role.role].temperature.toFixed(1) }}
              </span>
            </div>
            <n-slider
              v-model:value="drafts[role.role].temperature"
              :min="0"
              :max="2"
              :step="0.1"
              :tooltip="false"
            />
          </div>

          <div class="fx-stack" style="gap: 6px">
            <span class="fx-result-metric__label">Max Tokens（单次输出上限）</span>
            <n-input-number
              v-model:value="drafts[role.role].maxTokens"
              size="small"
              :min="1"
              :max="1000000"
              :show-button="false"
              clearable
              placeholder="留空则使用上游默认"
              style="width: 100%"
            />
          </div>

          <div class="fx-role-card__bound">
            <template v-if="role.model !== null && role.provider !== null">
              <span>当前：{{ role.provider.name }} · {{ role.model.displayName }}</span>
              <n-tag
                size="tiny"
                round
                :bordered="false"
                :type="role.provider.isEnabled && role.model.isEnabled ? 'success' : 'warning'"
              >
                {{ role.provider.isEnabled && role.model.isEnabled ? '可用' : '已停用' }}
              </n-tag>
            </template>
            <template v-else>
              当前未绑定，运行期调用将返回
              <code class="fx-mono">AGENT_ROLE_UNBOUND</code>
            </template>
          </div>

          <div class="fx-role-card__actions">
            <span class="fx-tertiary" style="font-size: 11px">
              更新于 {{ formatDateTime(role.updatedAt) }}
            </span>
            <n-button
              size="small"
              type="primary"
              secondary
              :loading="savingRole === role.role"
              @click="saveRole(role.role)"
            >
              <template #icon>
                <n-icon><save-outline /></n-icon>
              </template>
              保存
            </n-button>
          </div>
        </article>
      </div>

      <p class="fx-form-hint" style="margin-top: 14px">
        说明：每个角色的 Temperature 与 Max Tokens 作为该角色调用默认参数；
        未单独覆写时，服务端使用 0.7 与上游默认输出上限。
        <span v-if="roleBinding('writer') === undefined">（尚未加载角色配置）</span>
      </p>
    </div>
  </section>
</template>
