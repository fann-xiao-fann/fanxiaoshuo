<script setup lang="ts">
import {
  WORKFLOW_MODE_LABELS,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_RUN_STATUS_LABELS,
  type WorkflowMode,
  type WorkflowRunStatus,
} from '@fanxiaoshuo/shared';
import {
  NAlert,
  NButton,
  NIcon,
  NProgress,
  NSelect,
  NSpin,
  NTag,
  useMessage,
} from 'naive-ui';
import {
  AddOutline,
  GitNetworkOutline,
  RefreshOutline,
} from '@vicons/ionicons5';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { describeError } from '@/api/errors';
import CreateWorkflowModal from '@/components/workflows/CreateWorkflowModal.vue';
import WorkflowRunDetail from '@/components/workflows/WorkflowRunDetail.vue';
import { useWorkflowsStore, type WorkflowSseStatus } from '@/stores/workflows';
import { formatProgressPercent, formatUsd } from '@/utils/format';

const message = useMessage();
const workflowsStore = useWorkflowsStore();

const createVisible = ref(false);

const SSE_LABEL: Record<WorkflowSseStatus, string> = {
  disconnected: '未连接',
  connecting: '连接中',
  connected: '实时推送中',
  error: '已降级（轮询兜底）',
};

const SSE_TYPE: Record<WorkflowSseStatus, 'default' | 'info' | 'success' | 'warning'> = {
  disconnected: 'default',
  connecting: 'info',
  connected: 'success',
  error: 'warning',
};

const RUN_STATUS_TAG_TYPE: Record<
  WorkflowRunStatus,
  'default' | 'info' | 'success' | 'warning' | 'error'
> = {
  queued: 'info',
  running: 'warning',
  paused: 'warning',
  completed: 'success',
  failed: 'error',
  cancelled: 'default',
};

const statusOptions = [
  { label: '全部状态', value: 'all' },
  ...WORKFLOW_RUN_STATUSES.map((status) => ({
    label: WORKFLOW_RUN_STATUS_LABELS[status],
    value: status,
  })),
];

const statusFilterValue = computed<string>({
  get: () => workflowsStore.statusFilter ?? 'all',
  set: (value: string) => {
    workflowsStore.setStatusFilter(value === 'all' ? null : (value as WorkflowRunStatus));
    void reload();
  },
});

const runs = computed(() => workflowsStore.runs);
const isListEmpty = computed(() => !workflowsStore.listLoading && runs.value.length === 0);
const canPrevPage = computed(() => workflowsStore.page > 1);
const canNextPage = computed(() => workflowsStore.page < workflowsStore.totalPages);

function runProgress(completed: number, total: number): number {
  return formatProgressPercent(completed, total);
}

function modeLabel(mode: WorkflowMode): string {
  return WORKFLOW_MODE_LABELS[mode];
}

async function reload(): Promise<void> {
  try {
    await workflowsStore.loadRuns();
    if (workflowsStore.selectedRunId !== null) {
      await workflowsStore.refreshSelectedRun();
    }
  } catch (error) {
    message.error(describeError(error));
  }
}

async function autoSelectFirstRun(): Promise<void> {
  const first = runs.value[0];
  if (workflowsStore.selectedRunId === null && first !== undefined) {
    await workflowsStore.selectRun(first.id);
  }
}

async function initialLoad(): Promise<void> {
  try {
    await workflowsStore.loadRuns();
    await autoSelectFirstRun();
  } catch (error) {
    message.error(describeError(error));
  }
}

function selectRun(runId: string): void {
  if (workflowsStore.selectedRunId === runId) {
    return;
  }
  void workflowsStore.selectRun(runId);
}

function openCreate(): void {
  createVisible.value = true;
}

function handleCreated(): void {
  // 新建成功后由 Store 自动选中，并补拉一次列表刷新统计
  void workflowsStore.loadRuns().catch(() => {
    /* 列表刷新失败不阻塞详情渲染 */
  });
}

async function goToPage(page: number): Promise<void> {
  try {
    await workflowsStore.goToPage(page);
    await autoSelectFirstRun();
  } catch (error) {
    message.error(describeError(error));
  }
}

onMounted(() => {
  void initialLoad();
  workflowsStore.connectEvents();
});

onUnmounted(() => {
  workflowsStore.disconnectEvents();
});
</script>

<template>
  <div class="fx-page fx-wf-page">
    <section class="fx-panel">
      <div class="fx-panel__head">
        <div class="fx-inline">
          <span class="fx-panel__icon">
            <n-icon size="16"><git-network-outline /></n-icon>
          </span>
          <div>
            <div class="fx-panel__title">批量流水线</div>
            <div class="fx-panel__subtitle">
              多 Agent 无人值守批量成文：拆细纲 → 写正文 → 审稿返工 → 提炼摘要，实时追踪每章阶段、审稿得分与费用消耗。
            </div>
          </div>
        </div>
        <div class="fx-panel__actions">
          <n-tag size="small" round :bordered="false" :type="SSE_TYPE[workflowsStore.sseStatus]">
            SSE {{ SSE_LABEL[workflowsStore.sseStatus] }}
          </n-tag>
          <n-button
            quaternary
            size="small"
            :loading="workflowsStore.listLoading"
            @click="reload"
          >
            <template #icon>
              <n-icon><refresh-outline /></n-icon>
            </template>
            刷新
          </n-button>
          <n-button type="primary" size="small" @click="openCreate">
            <template #icon>
              <n-icon><add-outline /></n-icon>
            </template>
            新建批量任务
          </n-button>
        </div>
      </div>

      <div class="fx-panel__body">
        <n-alert v-if="workflowsStore.listError !== null" type="error" :bordered="false" style="margin-bottom: 14px">
          {{ workflowsStore.listError }}
        </n-alert>

        <div class="fx-wf-layout">
          <!-- 左侧批次列表 -->
          <aside class="fx-wf-sidebar">
            <div class="fx-wf-sidebar__head">
              <span class="fx-wf-sidebar__title">批次列表</span>
              <n-select
                v-model:value="statusFilterValue"
                size="small"
                :options="statusOptions"
                style="width: 118px"
              />
            </div>

            <n-spin :show="workflowsStore.listLoading">
              <div v-if="isListEmpty" class="fx-wf-empty">
                {{
                  workflowsStore.statusFilter === null
                    ? '还没有批量任务。点击右上角「新建批量任务」，选择书籍与章节即可开始无人值守成文。'
                    : '当前状态下没有批次，试试切换筛选条件。'
                }}
              </div>

              <ul v-else class="fx-wf-run-list">
                <li
                  v-for="item in runs"
                  :key="item.id"
                  :class="[
                    'fx-wf-run',
                    { 'is-active': workflowsStore.selectedRunId === item.id },
                  ]"
                  @click="selectRun(item.id)"
                >
                  <div class="fx-wf-run__head">
                    <span class="fx-wf-run__book">{{ item.bookTitle }}</span>
                    <n-tag size="tiny" round :bordered="false" :type="RUN_STATUS_TAG_TYPE[item.status]">
                      {{ WORKFLOW_RUN_STATUS_LABELS[item.status] }}
                    </n-tag>
                  </div>
                  <div class="fx-wf-run__meta">
                    <span>{{ modeLabel(item.mode) }}</span>
                    <span>{{ item.completedSteps }} / {{ item.totalSteps }} 章</span>
                    <span>{{ formatUsd(item.spentCostUsd) }}</span>
                  </div>
                  <n-progress
                    type="line"
                    :percentage="runProgress(item.completedSteps, item.totalSteps)"
                    :height="4"
                    :show-indicator="false"
                    :status="item.status === 'failed' ? 'error' : item.status === 'completed' ? 'success' : 'default'"
                  />
                </li>
              </ul>
            </n-spin>

            <div v-if="workflowsStore.total > workflowsStore.pageSize" class="fx-wf-pager">
              <n-button size="tiny" quaternary :disabled="!canPrevPage" @click="goToPage(workflowsStore.page - 1)">
                上一页
              </n-button>
              <span class="fx-tertiary" style="font-size: 11px">
                第 {{ workflowsStore.page }} / {{ workflowsStore.totalPages }} 页
              </span>
              <n-button size="tiny" quaternary :disabled="!canNextPage" @click="goToPage(workflowsStore.page + 1)">
                下一页
              </n-button>
            </div>
          </aside>

          <!-- 右侧批次详情 -->
          <main class="fx-wf-main">
            <workflow-run-detail
              :run="workflowsStore.selectedRun"
              :loading="workflowsStore.detailLoading"
              :error="workflowsStore.detailError"
            />
          </main>
        </div>
      </div>
    </section>

    <create-workflow-modal v-model:show="createVisible" @created="handleCreated" />
  </div>
</template>
