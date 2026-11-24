<script setup lang="ts">
import {
  AGENT_ROLE_LABELS,
  type ModelDto,
  type TestModelResponse,
} from '@fanxiaoshuo/shared';
import {
  NButton,
  NDataTable,
  NIcon,
  NInput,
  NSelect,
  NSwitch,
  useDialog,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import {
  AddOutline,
  CreateOutline,
  FlaskOutline,
  RefreshOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import { computed, h, ref } from 'vue';
import { describeError, isApiClientError } from '@/api/errors';
import ModelFormModal, {
  type ModelSubmitPayload,
} from '@/components/models/ModelFormModal.vue';
import ModelTestModal from '@/components/models/ModelTestModal.vue';
import { useRegistryStore } from '@/stores/registry';
import {
  formatContextWindow,
  formatDateTime,
  formatPricePer1M,
} from '@/utils/format';

const registry = useRegistryStore();
const message = useMessage();
const dialog = useDialog();

const providerFilter = ref<string | null>(null);
const keyword = ref('');
const showForm = ref(false);
const editingModel = ref<ModelDto | null>(null);
const saving = ref(false);
const togglingId = ref<string | null>(null);
const testingId = ref<string | null>(null);

const showTest = ref(false);
const testLoading = ref(false);
const testResult = ref<TestModelResponse | null>(null);
const testError = ref<string | null>(null);
const testModelLabel = ref('');

const providerOptions = computed(() => [
  { label: '全部供应商', value: '' },
  ...registry.providers.map((provider) => ({
    label: `${provider.name}${provider.isEnabled ? '' : '（已停用）'}`,
    value: provider.id,
  })),
]);

const filteredModels = computed(() => {
  const filter = providerFilter.value ?? '';
  const query = keyword.value.trim().toLowerCase();
  return registry.models.filter((model) => {
    if (filter !== '' && model.providerId !== filter) {
      return false;
    }
    if (query === '') {
      return true;
    }
    return (
      model.modelId.toLowerCase().includes(query) ||
      model.displayName.toLowerCase().includes(query)
    );
  });
});

function openCreate(): void {
  editingModel.value = null;
  showForm.value = true;
}

function openEdit(model: ModelDto): void {
  editingModel.value = model;
  showForm.value = true;
}

async function handleSubmit(event: ModelSubmitPayload): Promise<void> {
  saving.value = true;
  try {
    if (event.mode === 'create') {
      await registry.createModel(event.payload);
      message.success('模型已注册');
    } else if (editingModel.value !== null) {
      await registry.updateModel(editingModel.value.id, event.payload);
      message.success('模型配置已更新');
    }
    showForm.value = false;
  } catch (error) {
    if (isApiClientError(error) && error.code === 'CONFLICT') {
      message.error(`同一供应商下模型标识必须唯一：${error.message}`);
    } else {
      message.error(describeError(error));
    }
  } finally {
    saving.value = false;
  }
}

async function handleToggle(model: ModelDto, value: boolean): Promise<void> {
  togglingId.value = model.id;
  try {
    await registry.toggleModel(model.id, value);
    message.success(`${model.displayName} 已${value ? '启用' : '停用'}`);
  } catch (error) {
    message.error(describeError(error));
  } finally {
    togglingId.value = null;
  }
}

const TEST_FAILURE_CODES = new Set<string>([
  'MODEL_TEST_FAILED',
  'UPSTREAM_AUTH_ERROR',
  'UPSTREAM_RATE_LIMIT',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_ERROR',
  'MODEL_DISABLED',
  'PROVIDER_DISABLED',
]);

function isTestFailureCode(code: string): boolean {
  return TEST_FAILURE_CODES.has(code);
}

async function handleTest(model: ModelDto): Promise<void> {
  testModelLabel.value = `${model.displayName} · ${model.modelId}`;
  testResult.value = null;
  testError.value = null;
  testLoading.value = true;
  showTest.value = true;
  testingId.value = model.id;
  try {
    testResult.value = await registry.testModel(model.id);
  } catch (error) {
    if (isApiClientError(error) && isTestFailureCode(error.code)) {
      // 后端可能以非 2xx 返回测通失败；此处归一为同一结果视图，保留脱敏错误原因。
      testResult.value = {
        success: false,
        replyPreview: null,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        errorCode: error.code as TestModelResponse['errorCode'],
        errorMessage: error.message,
        usageLogId: null,
      };
    } else {
      testError.value = describeError(error);
    }
  } finally {
    testLoading.value = false;
    testingId.value = null;
  }
}

function confirmDelete(model: ModelDto): void {
  const boundRoles = registry.roles.filter((role) => role.modelId === model.id);
  const boundLabel = boundRoles
    .map((role) => AGENT_ROLE_LABELS[role.role])
    .join('、');
  dialog.warning({
    title: '删除模型',
    content:
      boundRoles.length > 0
        ? `「${model.displayName}」仍被 ${boundLabel} 绑定。后端将以 MODEL_IN_USE 拒绝删除，请先在角色路由面板解除或切换绑定。`
        : `确认删除模型「${model.displayName}（${model.modelId}）」？历史用量日志会保留模型快照，不受影响。`,
    positiveText: boundRoles.length > 0 ? '仍然尝试' : '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await registry.deleteModel(model.id);
        message.success('模型已删除');
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

function boundRoleLabels(model: ModelDto): string {
  const labels = registry.roles
    .filter((role) => role.modelId === model.id)
    .map((role) => AGENT_ROLE_LABELS[role.role]);
  return labels.length > 0 ? labels.join('、') : '';
}

const columns: DataTableColumns<ModelDto> = [
  {
    title: '模型',
    key: 'displayName',
    minWidth: 220,
    render: (row) =>
      h('div', { class: 'fx-stack' }, [
        h('span', { style: 'font-weight:600' }, row.displayName),
        h(
          'span',
          { class: 'fx-mono fx-tertiary', style: 'font-size:11px' },
          `${row.modelId}${boundRoleLabels(row) ? ` · 绑定：${boundRoleLabels(row)}` : ''}`,
        ),
      ]),
  },
  {
    title: '供应商',
    key: 'providerId',
    minWidth: 150,
    render: (row) => {
      const provider = registry.providerById(row.providerId);
      return h('div', { class: 'fx-stack' }, [
        h('span', null, provider?.name ?? '未知供应商'),
        h(
          'span',
          { class: 'fx-tertiary', style: 'font-size:11px' },
          provider === undefined
            ? '—'
            : provider.isEnabled
              ? '供应商启用中'
              : '供应商已停用',
        ),
      ]);
    },
  },
  {
    title: '上下文',
    key: 'contextWindow',
    width: 100,
    render: (row) => h('span', { class: 'fx-mono' }, formatContextWindow(row.contextWindow)),
  },
  {
    title: '输入单价',
    key: 'inputPricePer1M',
    width: 130,
    render: (row) => h('span', { class: 'fx-mono' }, formatPricePer1M(row.inputPricePer1M)),
  },
  {
    title: '输出单价',
    key: 'outputPricePer1M',
    width: 130,
    render: (row) => h('span', { class: 'fx-mono' }, formatPricePer1M(row.outputPricePer1M)),
  },
  {
    title: '启用',
    key: 'isEnabled',
    width: 80,
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
    title: '更新于',
    key: 'updatedAt',
    width: 160,
    render: (row) => h('span', { class: 'fx-muted', style: 'font-size:12px' }, formatDateTime(row.updatedAt)),
  },
  {
    title: '操作',
    key: 'actions',
    width: 210,
    fixed: 'right',
    render: (row) =>
      h('div', { class: 'fx-inline', style: 'gap:2px' }, [
        h(
          NButton,
          {
            text: true,
            type: 'primary',
            size: 'small',
            loading: testingId.value === row.id,
            onClick: () => {
              void handleTest(row);
            },
          },
          {
            icon: () => h(NIcon, null, { default: () => h(FlaskOutline) }),
            default: () => '测通',
          },
        ),
        h(
          NButton,
          { text: true, size: 'small', onClick: () => openEdit(row) },
          {
            icon: () => h(NIcon, null, { default: () => h(CreateOutline) }),
            default: () => '编辑',
          },
        ),
        h(
          NButton,
          { text: true, type: 'error', size: 'small', onClick: () => confirmDelete(row) },
          {
            icon: () => h(NIcon, null, { default: () => h(TrashOutline) }),
            default: () => '删除',
          },
        ),
      ]),
  },
];
</script>

<template>
  <section class="fx-panel">
    <header class="fx-panel__head">
      <div>
        <div class="fx-panel__title">模型目录</div>
        <div class="fx-panel__subtitle">
          注册上游模型标识、上下文窗口与 USD / 1M tokens 单价。单价用于服务端结算与费用估算，
          「测通」会经统一网关真实调用一次并写入用量日志。
        </div>
      </div>
      <div class="fx-panel__actions">
        <n-button size="small" quaternary :loading="registry.modelsLoading" @click="registry.loadModels()">
          <template #icon>
            <n-icon><refresh-outline /></n-icon>
          </template>
          刷新
        </n-button>
        <n-button size="small" type="primary" @click="openCreate">
          <template #icon>
            <n-icon><add-outline /></n-icon>
          </template>
          注册模型
        </n-button>
      </div>
    </header>

    <div class="fx-table-toolbar">
      <div class="fx-table-filters">
        <n-select
          v-model:value="providerFilter"
          :options="providerOptions"
          size="small"
          style="width: 200px"
          placeholder="按供应商筛选"
        />
        <n-input
          v-model:value="keyword"
          size="small"
          placeholder="搜索展示名 / 模型标识"
          clearable
          style="width: 240px"
        />
        <span class="fx-tertiary" style="font-size:12px">
          共 {{ filteredModels.length }} / {{ registry.models.length }} 个模型
        </span>
      </div>
      <span v-if="registry.modelsError" class="fx-error-text">{{ registry.modelsError }}</span>
    </div>

    <n-data-table
      :columns="columns"
      :data="filteredModels"
      :loading="registry.modelsLoading"
      :row-key="(row: ModelDto) => row.id"
      :bordered="false"
      :single-line="false"
      :scroll-x="1300"
      size="small"
    >
      <template #empty>
        <div class="fx-empty">
          {{
            registry.providers.length === 0
              ? '需要先创建供应商，才能注册模型。'
              : '当前筛选条件下没有模型，可调整筛选或注册新模型。'
          }}
        </div>
      </template>
    </n-data-table>

    <model-form-modal
      v-model:show="showForm"
      :model="editingModel"
      :providers="registry.providers"
      :saving="saving"
      @submit="handleSubmit"
    />
    <model-test-modal
      v-model:show="showTest"
      :model-label="testModelLabel"
      :result="testResult"
      :loading="testLoading"
      :request-error="testError"
    />
  </section>
</template>
