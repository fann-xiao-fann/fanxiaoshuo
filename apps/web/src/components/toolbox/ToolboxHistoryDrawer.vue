<script setup lang="ts">
import {
  TOOLBOX_RUN_STATUS_LABELS,
  TOOLBOX_TOOL_DEFINITIONS,
  isToolboxToolId,
  type ToolboxToolId,
} from '@fanxiaoshuo/shared';
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NIcon,
  NSelect,
  NSpin,
  NTag,
  useDialog,
  useMessage,
  type SelectOption,
} from 'naive-ui';
import { TimeOutline, TrashOutline } from '@vicons/ionicons5';
import { computed } from 'vue';
import { describeError } from '@/api/errors';
import { useToolboxStore } from '@/stores/toolbox';
import { formatDateTime, formatInteger, formatUsd } from '@/utils/format';

/**
 * 创作工具盒历史抽屉：按工具 / 作品筛选历史运行，
 * 支持回看详情（同步结果卡片）与删除记录（带确认弹窗）。
 */

const props = defineProps<{
  show: boolean;
  bookOptions: SelectOption[];
}>();

const emit = defineEmits<{
  'update:show': [boolean];
}>();

const store = useToolboxStore();
const message = useMessage();
const dialog = useDialog();

const toolOptions = [
  { label: '全部工具', value: 'all' },
  ...TOOLBOX_TOOL_DEFINITIONS.map((definition) => ({
    label: definition.name,
    value: definition.id,
  })),
];

const toolFilterValue = computed<string>(() => store.historyToolFilter ?? 'all');

const bookFilterValue = computed<string>(() => store.historyBookFilter ?? 'all');

async function onToolFilterChange(value: string): Promise<void> {
  const next = value === 'all' || !isToolboxToolId(value) ? null : (value as ToolboxToolId);
  store.setHistoryToolFilter(next);
  await reload();
}

async function onBookFilterChange(value: string | null): Promise<void> {
  store.setHistoryBookFilter(value === null || value === '' || value === 'all' ? null : value);
  await reload();
}

const bookFilterOptions = computed(() => [
  { label: '全部作品', value: 'all' },
  ...props.bookOptions,
]);

const canPrevPage = computed(() => store.page > 1);
const canNextPage = computed(() => store.page < store.totalPages);

async function reload(): Promise<void> {
  try {
    await store.loadHistory();
  } catch (error) {
    message.error(describeError(error));
  }
}

async function goToPage(page: number): Promise<void> {
  try {
    await store.goToHistoryPage(page);
  } catch (error) {
    message.error(describeError(error));
  }
}

function openRun(runId: string): void {
  emit('update:show', false);
  void store.openHistoryRun(runId).then((detail) => {
    if (detail === null) {
      message.error(store.error ?? '历史运行加载失败');
      return;
    }
    message.success(`已载入「${detail.toolName}」的历史结果`);
  });
}

function confirmDelete(runId: string, toolName: string): void {
  dialog.warning({
    title: '删除历史记录',
    content: `确认删除「${toolName}」这次运行记录吗？删除后不可恢复，但已回写的设定卡与总大纲不受影响。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      void store.deleteHistoryRun(runId).then((ok) => {
        if (ok) {
          message.success('历史记录已删除');
          return;
        }
        message.error(store.error ?? '删除失败');
      });
    },
  });
}
</script>

<template>
  <n-drawer
    :show="show"
    :width="440"
    @update:show="(value: boolean) => emit('update:show', value)"
    @after-enter="reload"
  >
    <n-drawer-content title="创作历史" :native-scrollbar="false">
      <template #header>
        <div class="fx-inline" style="gap: 8px">
          <n-icon size="15"><time-outline /></n-icon>
          创作历史
        </div>
      </template>

      <div class="fx-tb-history">
        <div class="fx-tb-history__filters">
          <n-select
            :value="toolFilterValue"
            size="small"
            :options="toolOptions"
            style="width: 100%"
            @update:value="onToolFilterChange"
          />
          <n-select
            :value="bookFilterValue"
            size="small"
            clearable
            :options="bookFilterOptions"
            style="width: 100%"
            @update:value="onBookFilterChange"
          />
        </div>

        <p class="fx-form-hint">
          历史记录仅保存输入与结构化产出，删除记录不会影响已回写到 Book Bible 的设定卡与总大纲。
        </p>

        <n-spin :show="store.historyLoading">
          <div v-if="store.isHistoryEmpty" class="fx-tb-empty">
            {{
              store.historyToolFilter === null && store.historyBookFilter === null
                ? '还没有创作记录。执行任意工具后，这里会保留每次运行的输入与产出。'
                : '当前筛选条件下没有历史记录，试试切换工具或作品。'
            }}
          </div>

          <ul v-else class="fx-tb-history__list">
            <li v-for="run in store.runs" :key="run.id" class="fx-tb-history__item">
              <div class="fx-tb-history__head">
                <span class="fx-tb-history__name">{{ run.toolName }}</span>
                <n-tag
                  size="tiny"
                  round
                  :bordered="false"
                  :type="run.status === 'completed' ? 'success' : 'error'"
                >
                  {{ TOOLBOX_RUN_STATUS_LABELS[run.status] }}
                </n-tag>
              </div>
              <div class="fx-tb-history__meta">
                <span>{{ formatDateTime(run.createdAt) }}</span>
                <span>{{ run.itemCount }} 条产出</span>
                <span>{{ formatInteger(run.inputTokens + run.outputTokens) }} tokens</span>
                <span>{{ formatUsd(run.estimatedCostUsd) }}</span>
              </div>
              <div v-if="run.overview.trim().length > 0" class="fx-tb-history__overview">
                {{ run.overview }}
              </div>
              <div class="fx-tb-history__actions">
                <n-button size="tiny" quaternary type="primary" @click="openRun(run.id)">
                  回看结果
                </n-button>
                <n-button
                  size="tiny"
                  quaternary
                  type="error"
                  :loading="store.deletingRunId === run.id"
                  @click="confirmDelete(run.id, run.toolName)"
                >
                  <template #icon>
                    <n-icon><trash-outline /></n-icon>
                  </template>
                  删除
                </n-button>
              </div>
            </li>
          </ul>
        </n-spin>

        <div v-if="store.totalRuns > store.pageSize" class="fx-tb-history__pager">
          <n-button size="tiny" quaternary :disabled="!canPrevPage" @click="goToPage(store.page - 1)">
            上一页
          </n-button>
          <span class="fx-tertiary" style="font-size: 11px">
            第 {{ store.page }} / {{ store.totalPages }} 页 · 共 {{ store.totalRuns }} 条
          </span>
          <n-button size="tiny" quaternary :disabled="!canNextPage" @click="goToPage(store.page + 1)">
            下一页
          </n-button>
        </div>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>
