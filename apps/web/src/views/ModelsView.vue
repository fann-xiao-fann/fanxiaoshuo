<script setup lang="ts">
import { NAlert, NButton, NIcon } from 'naive-ui';
import { HardwareChipOutline, PulseOutline, RefreshOutline } from '@vicons/ionicons5';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { describeError } from '@/api/errors';
import ModelPanel from '@/components/models/ModelPanel.vue';
import ProviderPanel from '@/components/models/ProviderPanel.vue';
import RoleRoutingPanel from '@/components/models/RoleRoutingPanel.vue';
import { useRegistryStore } from '@/stores/registry';

const registry = useRegistryStore();
const router = useRouter();

const loadError = ref<string | null>(null);

const loading = computed(
  () => registry.providersLoading || registry.modelsLoading || registry.rolesLoading,
);

const enabledProviders = computed(() => registry.providers.filter((item) => item.isEnabled).length);
const boundRoles = computed(() => registry.roles.filter((item) => item.modelId !== null).length);
const roleCompleteness = computed(() =>
  registry.roles.length === 0
    ? 0
    : Math.round((boundRoles.value / Math.max(registry.roles.length, 4)) * 100),
);

const sectionErrors = computed(() =>
  [registry.providersError, registry.modelsError, registry.rolesError].filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  ),
);

async function refreshAll(): Promise<void> {
  loadError.value = null;
  try {
    await registry.loadAll();
  } catch (error) {
    loadError.value = describeError(error);
  }
}

function scrollToSection(id: string): void {
  const element = document.getElementById(id);
  element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

onMounted(() => {
  void refreshAll();
});
</script>

<template>
  <div class="fx-page">
    <!-- 概览 -->
    <section class="fx-panel">
      <div class="fx-panel__body">
        <div class="fx-inline" style="justify-content: space-between; margin-bottom: 16px">
          <div>
            <div class="fx-panel__title">
              <span class="fx-panel__icon">
                <n-icon size="17"><hardware-chip-outline /></n-icon>
              </span>
              模型配置中心
            </div>
            <div class="fx-panel__subtitle">
              先维护供应商与模型，再把四位写书 Agent 分别路由到合适的模型；所有调用统一经
              `packages/agents` 网关计量，前端不会直接访问上游。
            </div>
          </div>
          <div class="fx-panel__actions">
            <n-button size="small" quaternary :loading="loading" @click="refreshAll">
              <template #icon>
                <n-icon><refresh-outline /></n-icon>
              </template>
              刷新全部
            </n-button>
            <n-button size="small" secondary type="primary" @click="router.push('/runtime')">
              <template #icon>
                <n-icon><pulse-outline /></n-icon>
              </template>
              用量与状态
            </n-button>
          </div>
        </div>

        <n-alert
          v-if="loadError || sectionErrors.length > 0"
          type="warning"
          :bordered="false"
          style="margin-bottom: 16px"
        >
          <strong>部分配置加载失败：</strong>
          {{ loadError ?? sectionErrors.join('；') }}
          <div style="margin-top: 6px; font-size: 12px">
            可确认 Docker 中的 PostgreSQL / Redis 与 `apps/server` 是否已启动，然后点击「刷新全部」重试。
          </div>
        </n-alert>

        <div class="fx-kpi-grid">
          <div class="fx-kpi">
            <div class="fx-kpi__label">供应商</div>
            <div class="fx-kpi__value">
              {{ enabledProviders }}<span class="fx-tertiary" style="font-size: 14px"> / {{ registry.providers.length }}</span>
            </div>
            <div class="fx-kpi__hint">启用 / 全部</div>
          </div>
          <div class="fx-kpi">
            <div class="fx-kpi__label">模型目录</div>
            <div class="fx-kpi__value">
              {{ registry.enabledModels.length }}<span class="fx-tertiary" style="font-size: 14px"> / {{ registry.models.length }}</span>
            </div>
            <div class="fx-kpi__hint">启用 / 全部（可一键测通）</div>
          </div>
          <div class="fx-kpi">
            <div class="fx-kpi__label">角色路由</div>
            <div class="fx-kpi__value fx-kpi__value--accent">
              {{ boundRoles }}<span class="fx-tertiary" style="font-size: 14px"> / 4</span>
            </div>
            <div class="fx-kpi__hint">已绑定写书角色</div>
          </div>
          <div class="fx-kpi">
            <div class="fx-kpi__label">路由完整度</div>
            <div class="fx-kpi__value">{{ roleCompleteness }}%</div>
            <div class="fx-kpi__hint">建议四个角色全部绑定</div>
          </div>
        </div>

        <div class="fx-inline" style="margin-top: 16px; gap: 6px">
          <span class="fx-tertiary" style="font-size: 11px; letter-spacing: 0.08em">快速定位</span>
          <n-button text size="tiny" type="primary" @click="scrollToSection('providers')">① 供应商</n-button>
          <span class="fx-tertiary">·</span>
          <n-button text size="tiny" type="primary" @click="scrollToSection('models')">② 模型目录</n-button>
          <span class="fx-tertiary">·</span>
          <n-button text size="tiny" type="primary" @click="scrollToSection('roles')">③ 角色路由</n-button>
        </div>
      </div>
    </section>

    <div id="providers" style="scroll-margin-top: 16px">
      <provider-panel />
    </div>

    <div id="models" style="scroll-margin-top: 16px">
      <model-panel />
    </div>

    <div id="roles" style="scroll-margin-top: 16px">
      <role-routing-panel />
    </div>
  </div>
</template>
