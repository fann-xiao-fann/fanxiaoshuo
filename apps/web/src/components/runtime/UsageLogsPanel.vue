<script setup lang="ts">
import {
  AGENT_ROLE_LABELS,
  AGENT_ROLES,
  USAGE_SCENES,
  type AgentRole,
  type UsageLogDto,
  type UsageLogStatus,
  type UsageLogsResponse,
} from '@fanxiaoshuo/shared';
import {
  NAlert,
  NButton,
  NDataTable,
  NDatePicker,
  NIcon,
  NPagination,
  NSelect,
  NTag,
  type DataTableColumns,
} from 'naive-ui';
import { RefreshOutline } from '@vicons/ionicons5';
import { computed, h, onMounted, ref } from 'vue';
import { describeError } from '@/api/errors';
import { usageLogApi } from '@/api/usage-logs';
import {
  formatDateTime,
  formatInteger,
  formatLatency,
  formatRoleLabel,
  formatUsd,
  truncateMiddle,
} from '@/utils/format';

const RANGE_OPTIONS = [
  { label: '近 1 小时', value: '1h' },
  { label: '近 24 小时', value: '24h' },
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
  { label: '全部时间', value: 'all' },
];

const STATUS_OPTIONS = [
  { label: '全部状态', value: '' },
  { label: '成功', value: 'success' },
  { label: '失败', value: 'error' },
];

const ROLE_OPTIONS = [
  { label: '全部角色', value: '' },
  ...AGENT_ROLES.map((role) => ({ label: AGENT_ROLE_LABELS[role], value: role })),
];

const SCENE_LABELS: Record<string, string> = {
  [USAGE_SCENES.connectivityTest]: '一键测通',
  [USAGE_SCENES.smokeJob]: '冒烟任务',
  [USAGE_SCENES.chapterWrite]: '章节成文',
  [USAGE_SCENES.loreExtract]: '设定抽取',
  [USAGE_SCENES.chapterReview]: '审稿质检',
};

const SCENE_OPTIONS = [
  { label: '全部场景', value: '' },
  ...Object.values(USAGE_SCENES).map((scene) => ({
    label: SCENE_LABELS[scene] ?? scene,
    value: scene,
  })),
];

const rangePreset = ref('24h');
const statusFilter = ref('');
const roleFilter = ref('');
const sceneFilter = ref('');
const customRange = ref<number | [number, number] | null>(null);

const page = ref(1);
const pageSize = ref(20);
const data = ref<UsageLogsResponse | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const summary = computed(() => data.value?.summary ?? null);
const successRate = computed(() => {
  const current = summary.value;
  if (current === null || current.totalRequests === 0) {
    return '—';
  }
  return `${Math.round((current.successRequests / current.totalRequests) * 100)}%`;
});

const customRangeActive = computed(() => customRange.value !== null);

function resolveRange(): { from?: string; to?: string } {
  const custom = customRange.value;
  if (Array.isArray(custom)) {
    return {
      from: new Date(custom[0]).toISOString(),
      to: new Date(custom[1]).toISOString(),
    };
  }
  if (rangePreset.value === 'all') {
    return {};
  }
  const hoursByPreset: Record<string, number> = {
    '1h': 1,
    '24h': 24,
    '7d': 24 * 7,
    '30d': 24 * 30,
  };
  const hours = hoursByPreset[rangePreset.value] ?? 24;
  return {
    from: new Date(Date.now() - hours * 3_600_000).toISOString(),
    to: new Date().toISOString(),
  };
}

async function loadLogs(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const range = resolveRange();
    const response = await usageLogApi.list({
      page: page.value,
      pageSize: pageSize.value,
      ...(statusFilter.value !== '' ? { status: statusFilter.value as UsageLogStatus } : {}),
      ...(roleFilter.value !== '' ? { role: roleFilter.value as AgentRole } : {}),
      ...(sceneFilter.value !== '' ? { scene: sceneFilter.value } : {}),
      ...range,
    });
    data.value = response;
  } catch (loadError) {
    error.value = describeError(loadError);
    data.value = null;
  } finally {
    loading.value = false;
  }
}

function onFilterChange(): void {
  page.value = 1;
  void loadLogs();
}

function onPresetChange(value: string): void {
  rangePreset.value = value;
  customRange.value = null;
  onFilterChange();
}

function onCustomRangeChange(value: number | [number, number] | null): void {
  customRange.value = value;
  onFilterChange();
}

function onStatusFilterChange(value: string): void {
  statusFilter.value = value;
  onFilterChange();
}

function onRoleFilterChange(value: string): void {
  roleFilter.value = value;
  onFilterChange();
}

function onSceneFilterChange(value: string): void {
  sceneFilter.value = value;
  onFilterChange();
}

function onPageChange(value: number): void {
  page.value = value;
  void loadLogs();
}

function onPageSizeChange(value: number): void {
  pageSize.value = value;
  page.value = 1;
  void loadLogs();
}

function clearCustomRange(): void {
  customRange.value = null;
  onFilterChange();
}

const STATUS_LABEL: Record<UsageLogStatus, string> = {
  success: '成功',
  error: '失败',
};

const columns: DataTableColumns<UsageLogDto> = [
  {
    title: '时间',
    key: 'createdAt',
    width: 168,
    render: (row) => h('span', { class: 'fx-muted', style: 'font-size:12px' }, formatDateTime(row.createdAt)),
  },
  {
    title: '场景',
    key: 'scene',
    width: 118,
    render: (row) =>
      h(
        NTag,
        { size: 'small', round: true, bordered: false, type: 'default' },
        { default: () => SCENE_LABELS[row.scene] ?? row.scene },
      ),
  },
  {
    title: '角色',
    key: 'role',
    width: 110,
    render: (row) =>
      h(
        'span',
        { class: row.role === null ? 'fx-tertiary' : undefined, style: 'font-size:12px' },
        formatRoleLabel(row.role),
      ),
  },
  {
    title: '模型',
    key: 'modelRef',
    minWidth: 200,
    render: (row) =>
      h(
        'span',
        {
          class: 'fx-mono fx-truncate',
          title: row.modelRef ?? '—',
          style: 'display:inline-block;max-width:240px;font-size:11px',
        },
        row.modelRef === null ? '—' : truncateMiddle(row.modelRef, 40),
      ),
  },
  {
    title: 'Tokens 入 / 出',
    key: 'inputTokens',
    width: 150,
    render: (row) =>
      h(
        'span',
        { class: 'fx-mono', style: 'font-size:12px' },
        `${formatInteger(row.inputTokens)} / ${formatInteger(row.outputTokens)}`,
      ),
  },
  {
    title: '估算费用',
    key: 'estimatedCostUsd',
    width: 120,
    render: (row) => h('span', { class: 'fx-mono', style: 'font-size:12px' }, formatUsd(row.estimatedCostUsd)),
  },
  {
    title: '延迟',
    key: 'latencyMs',
    width: 90,
    render: (row) => h('span', { class: 'fx-mono', style: 'font-size:12px' }, formatLatency(row.latencyMs)),
  },
  {
    title: '状态',
    key: 'status',
    width: 170,
    render: (row) =>
      h('div', { class: 'fx-stack', style: 'gap:2px', title: row.errorMessage ?? '' }, [
        h(
          NTag,
          {
            size: 'small',
            round: true,
            bordered: false,
            type: row.status === 'success' ? 'success' : 'error',
          },
          { default: () => STATUS_LABEL[row.status] },
        ),
        row.status === 'error' && row.errorCode !== null
          ? h('span', { class: 'fx-tertiary fx-mono', style: 'font-size:10px' }, row.errorCode)
          : null,
        row.status === 'error' && row.errorMessage !== null
          ? h(
              'span',
              {
                class: 'fx-truncate',
                style: 'max-width:150px;font-size:10px;color:var(--fx-danger)',
              },
              row.errorMessage,
            )
          : null,
      ]),
  },
];

onMounted(() => {
  void loadLogs();
});
</script>

<template>
  <section class="fx-panel">
    <header class="fx-panel__head">
      <div>
        <div class="fx-panel__title">用量日志与成本汇总</div>
        <div class="fx-panel__subtitle">
          Append-only 审计账本：每次模型调用（测通、冒烟任务与后续成文）都会记录 Token、估算费用、延迟与脱敏错误。
          汇总卡片按当前筛选区间统计。
        </div>
      </div>
      <div class="fx-panel__actions">
        <span class="fx-tertiary" style="font-size: 11px">
          区间：{{ formatDateTime(data?.from) }} ~ {{ formatDateTime(data?.to) }}
        </span>
        <n-button size="small" quaternary :loading="loading" @click="loadLogs">
          <template #icon>
            <n-icon><refresh-outline /></n-icon>
          </template>
          刷新
        </n-button>
      </div>
    </header>

    <div class="fx-panel__body">
      <n-alert v-if="error" type="warning" :bordered="false" style="margin-bottom: 14px">
        用量日志加载失败：{{ error }}
      </n-alert>

      <div class="fx-kpi-grid">
        <div class="fx-kpi">
          <div class="fx-kpi__label">总请求数</div>
          <div class="fx-kpi__value">{{ formatInteger(summary?.totalRequests) }}</div>
          <div class="fx-kpi__hint">
            成功 {{ formatInteger(summary?.successRequests) }} / 失败
            {{ formatInteger(summary?.errorRequests) }}
          </div>
        </div>
        <div class="fx-kpi">
          <div class="fx-kpi__label">输入 Tokens</div>
          <div class="fx-kpi__value">{{ formatInteger(summary?.totalInputTokens) }}</div>
          <div class="fx-kpi__hint">Prompt tokens 累计</div>
        </div>
        <div class="fx-kpi">
          <div class="fx-kpi__label">输出 Tokens</div>
          <div class="fx-kpi__value">{{ formatInteger(summary?.totalOutputTokens) }}</div>
          <div class="fx-kpi__hint">Completion tokens 累计</div>
        </div>
        <div class="fx-kpi">
          <div class="fx-kpi__label">总估算费用</div>
          <div class="fx-kpi__value fx-kpi__value--accent">{{ formatUsd(summary?.totalCostUsd) }}</div>
          <div class="fx-kpi__hint">USD · 按模型单价快照计算</div>
        </div>
        <div class="fx-kpi">
          <div class="fx-kpi__label">成功率</div>
          <div class="fx-kpi__value">{{ successRate }}</div>
          <div class="fx-kpi__hint">含测通与冒烟任务</div>
        </div>
      </div>
    </div>

    <div class="fx-table-toolbar">
      <div class="fx-table-filters">
        <n-select
          :value="rangePreset"
          :options="RANGE_OPTIONS"
          size="small"
          style="width: 132px"
          @update:value="onPresetChange"
        />
        <n-date-picker
          :value="customRange"
          type="datetimerange"
          size="small"
          clearable
          style="width: 320px"
          start-placeholder="自定义开始"
          end-placeholder="自定义结束"
          @update:value="onCustomRangeChange"
        />
        <n-button v-if="customRangeActive" text size="tiny" type="primary" @click="clearCustomRange">
          清除自定义区间
        </n-button>
        <n-select
          :value="statusFilter"
          :options="STATUS_OPTIONS"
          size="small"
          style="width: 118px"
          @update:value="onStatusFilterChange"
        />
        <n-select
          :value="roleFilter"
          :options="ROLE_OPTIONS"
          size="small"
          style="width: 132px"
          @update:value="onRoleFilterChange"
        />
        <n-select
          :value="sceneFilter"
          :options="SCENE_OPTIONS"
          size="small"
          style="width: 136px"
          @update:value="onSceneFilterChange"
        />
      </div>
      <span class="fx-tertiary" style="font-size: 12px">
        共 {{ formatInteger(data?.total) }} 条 · 第 {{ data?.page ?? page }} / {{ Math.max(data?.totalPages ?? 1, 1) }} 页
      </span>
    </div>

    <n-data-table
      :columns="columns"
      :data="data?.items ?? []"
      :loading="loading"
      :row-key="(row: UsageLogDto) => row.id"
      :bordered="false"
      :single-line="false"
      :scroll-x="1180"
      size="small"
    >
      <template #empty>
        <div class="fx-empty">
          {{
            error
              ? '无法读取用量日志，请确认后端与 PostgreSQL 已启动。'
              : '当前筛选区间内还没有用量记录。去「模型配置中心」触发一次测通，或在上面发起冒烟任务。'
          }}
        </div>
      </template>
    </n-data-table>

    <div class="fx-pagination-bar">
      <span class="fx-tertiary" style="font-size: 12px">
        费用为按模型单价快照计算的估算值，用于成本监控；实际账单以上游供应商为准。
      </span>
      <n-pagination
        :page="page"
        :page-size="pageSize"
        :item-count="data?.total ?? 0"
        :page-sizes="[10, 20, 50, 100]"
        show-size-picker
        :disabled="loading"
        @update:page="onPageChange"
        @update:page-size="onPageSizeChange"
      />
    </div>
  </section>
</template>
