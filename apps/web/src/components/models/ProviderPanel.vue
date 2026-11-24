<script setup lang="ts">
import {
  PROVIDER_PROTOCOL_META,
  type ProviderDto,
} from '@fanxiaoshuo/shared';
import {
  NButton,
  NDataTable,
  NIcon,
  NSwitch,
  NTag,
  useDialog,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { AddOutline, RefreshOutline } from '@vicons/ionicons5';
import { h, ref } from 'vue';
import { isApiClientError, describeError } from '@/api/errors';
import ProviderFormModal, {
  type ProviderSubmitPayload,
} from '@/components/models/ProviderFormModal.vue';
import { useRegistryStore } from '@/stores/registry';
import { formatDateTime } from '@/utils/format';

const registry = useRegistryStore();
const message = useMessage();
const dialog = useDialog();

const showForm = ref(false);
const editingProvider = ref<ProviderDto | null>(null);
const saving = ref(false);
const togglingId = ref<string | null>(null);

function openCreate(): void {
  editingProvider.value = null;
  showForm.value = true;
}

function openEdit(provider: ProviderDto): void {
  editingProvider.value = provider;
  showForm.value = true;
}

async function handleSubmit(event: ProviderSubmitPayload): Promise<void> {
  saving.value = true;
  try {
    if (event.mode === 'create') {
      await registry.createProvider(event.payload);
      message.success('供应商已创建，API Key 已加密落库');
    } else if (editingProvider.value !== null) {
      await registry.updateProvider(editingProvider.value.id, event.payload);
      message.success('供应商配置已更新');
    }
    showForm.value = false;
  } catch (error) {
    message.error(describeError(error));
  } finally {
    saving.value = false;
  }
}

async function handleToggle(provider: ProviderDto, value: boolean): Promise<void> {
  togglingId.value = provider.id;
  try {
    await registry.toggleProvider(provider.id, value);
    message.success(`${provider.name} 已${value ? '启用' : '停用'}`);
  } catch (error) {
    message.error(describeError(error));
  } finally {
    togglingId.value = null;
  }
}

function confirmDelete(provider: ProviderDto): void {
  const modelCount = registry.modelsOfProvider(provider.id).length;
  dialog.warning({
    title: '删除供应商',
    content:
      modelCount > 0
        ? `「${provider.name}」下仍有 ${modelCount} 个模型。删除供应商会级联删除其模型；若其中模型已被写书角色绑定，后端将拒绝删除并返回冲突提示。`
        : `确认删除供应商「${provider.name}」？此操作不可撤销。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await registry.deleteProvider(provider.id);
        message.success('供应商已删除');
      } catch (error) {
        if (isApiClientError(error) && error.code === 'MODEL_IN_USE') {
          dialog.error({
            title: '无法删除：模型仍被角色绑定',
            content: error.message,
            positiveText: '我知道了',
          });
        } else {
          message.error(describeError(error));
        }
      }
    },
  });
}

const columns: DataTableColumns<ProviderDto> = [
  {
    title: '供应商',
    key: 'name',
    minWidth: 160,
    render: (row) =>
      h('div', { class: 'fx-stack' }, [
        h('span', { style: 'font-weight: 600' }, row.name),
        h('span', { class: 'fx-tertiary fx-mono', style: 'font-size: 11px' }, row.id.slice(0, 8)),
      ]),
  },
  {
    title: '协议',
    key: 'protocol',
    width: 150,
    render: (row) =>
      h(
        NTag,
        { size: 'small', round: true, bordered: false, type: 'info' },
        { default: () => PROVIDER_PROTOCOL_META[row.protocol].label },
      ),
  },
  {
    title: 'Base URL',
    key: 'baseUrl',
    minWidth: 220,
    render: (row) =>
      h(
        'span',
        {
          class: 'fx-mono fx-truncate',
          style: 'display:inline-block;max-width:300px;font-size:12px',
          title: row.baseUrl,
        },
        row.baseUrl,
      ),
  },
  {
    title: '密钥指纹',
    key: 'apiKeyMask',
    width: 150,
    render: (row) =>
      h('code', { class: 'fx-mono', style: 'font-size:12px;color:var(--fx-text-secondary)' }, row.apiKeyMask),
  },
  {
    title: '启用',
    key: 'isEnabled',
    width: 90,
    render: (row) =>
      h(NSwitch, {
        size: 'small',
        value: row.isEnabled,
        loading: togglingId.value === row.id,
        'onUpdate:value': (value: boolean) => {
          void handleToggle(row, value);
        },
      }),
  },
  {
    title: '最近更新',
    key: 'updatedAt',
    width: 170,
    render: (row) => h('span', { class: 'fx-muted', style: 'font-size:12px' }, formatDateTime(row.updatedAt)),
  },
  {
    title: '操作',
    key: 'actions',
    width: 140,
    fixed: 'right',
    render: (row) =>
      h('div', { class: 'fx-inline', style: 'gap:2px' }, [
        h(
          NButton,
          { text: true, type: 'primary', size: 'small', onClick: () => openEdit(row) },
          { default: () => '编辑' },
        ),
        h(
          NButton,
          { text: true, type: 'error', size: 'small', onClick: () => confirmDelete(row) },
          { default: () => '删除' },
        ),
      ]),
  },
];
</script>

<template>
  <section class="fx-panel">
    <header class="fx-panel__head">
      <div>
        <div class="fx-panel__title">供应商</div>
        <div class="fx-panel__subtitle">
          管理 OpenAI 兼容中转站与官方供应商。API Key 仅以密文落库，界面与接口只展示脱敏指纹；
          编辑时留空密钥即保留原值。
        </div>
      </div>
      <div class="fx-panel__actions">
        <n-button size="small" quaternary :loading="registry.providersLoading" @click="registry.loadProviders()">
          <template #icon>
            <n-icon><refresh-outline /></n-icon>
          </template>
          刷新
        </n-button>
        <n-button size="small" type="primary" @click="openCreate">
          <template #icon>
            <n-icon><add-outline /></n-icon>
          </template>
          新增供应商
        </n-button>
      </div>
    </header>

    <div v-if="registry.providersError" style="padding: 12px 20px 0">
      <n-tag type="error" :bordered="false" round>{{ registry.providersError }}</n-tag>
    </div>

    <n-data-table
      :columns="columns"
      :data="registry.providers"
      :loading="registry.providersLoading"
      :row-key="(row: ProviderDto) => row.id"
      :bordered="false"
      :single-line="false"
      :scroll-x="1120"
      size="small"
      style="margin-top: 4px"
    >
      <template #empty>
        <div class="fx-empty">
          还没有供应商。先新增一个 OpenAI 兼容中转站或官方供应商，再注册模型。
        </div>
      </template>
    </n-data-table>

    <provider-form-modal
      v-model:show="showForm"
      :provider="editingProvider"
      :saving="saving"
      @submit="handleSubmit"
    />
  </section>
</template>
