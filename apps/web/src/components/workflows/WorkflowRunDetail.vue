<script setup lang="ts">
import {
  MAX_WORKFLOW_MAX_COST_USD,
  MIN_WORKFLOW_MAX_COST_USD,
  WORKFLOW_MODE_LABELS,
  WORKFLOW_PAUSE_REASON_LABELS,
  WORKFLOW_RUN_STATUS_LABELS,
  WORKFLOW_STEP_STAGE_LABELS,
  WORKFLOW_STEP_STATUS_LABELS,
  isWorkflowTerminalStatus,
  type WorkflowRunDetailDto,
  type WorkflowRunStatus,
  type WorkflowStepDto,
  type WorkflowStepStage,
  type WorkflowStepStatus,
} from '@fanxiaoshuo/shared';
import {
  NAlert,
  NButton,
  NIcon,
  NInputNumber,
  NProgress,
  NSpin,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui';
import {
  ChevronDownOutline,
  ChevronForwardOutline,
  CreateOutline,
  PauseOutline,
  PlayOutline,
  RefreshOutline,
  TrashOutline,
  TrendingUpOutline,
} from '@vicons/ionicons5';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { describeError } from '@/api/errors';
import { useWorkflowsStore } from '@/stores/workflows';
import {
  formatDateTime,
  formatInteger,
  formatProgressPercent,
  formatUsd,
  formatWordCount,
} from '@/utils/format';

const props = defineProps<{
  run: WorkflowRunDetailDto | null;
  loading: boolean;
  error: string | null;
}>();

const router = useRouter();
const message = useMessage();
const dialog = useDialog();
const workflowsStore = useWorkflowsStore();

const expandedStepIds = ref<string[]>([]);
const newBudget = ref<number | null>(null);

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

const STEP_STATUS_TAG_TYPE: Record<
  WorkflowStepStatus,
  'default' | 'info' | 'success' | 'warning' | 'error'
> = {
  pending: 'default',
  running: 'info',
  completed: 'success',
  failed: 'error',
  skipped: 'default',
};

const STEP_STAGE_TAG_TYPE: Record<
  WorkflowStepStage,
  'default' | 'info' | 'success' | 'warning'
> = {
  idle: 'default',
  planning: 'info',
  writing: 'info',
  reviewing: 'warning',
  reworking: 'warning',
  summarizing: 'info',
  done: 'success',
};

const run = computed(() => props.run);
const status = computed<WorkflowRunStatus>(() => props.run?.status ?? 'queued');
const isBudgetPaused = computed(
  () => run.value?.status === 'paused' && run.value.pauseReason === 'BUDGET_EXCEEDED',
);
const canPause = computed(() => status.value === 'queued' || status.value === 'running');
const canResume = computed(() => status.value === 'paused' || status.value === 'failed');
const canCancel = computed(
  () =>
    status.value === 'queued' ||
    status.value === 'running' ||
    status.value === 'paused' ||
    status.value === 'failed',
);
const canDelete = computed(() => isWorkflowTerminalStatus(status.value));

const stepProgress = computed(() =>
  formatProgressPercent(run.value?.completedSteps ?? 0, run.value?.totalSteps ?? 0),
);
const budgetPercent = computed(() => {
  const current = run.value;
  if (current === null || current.maxCostUsd === null || current.maxCostUsd <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((current.spentCostUsd / current.maxCostUsd) * 100));
});

/** 建议预算：以当前累计费用与原始上限的较大者翻倍，至少 $1。 */
const suggestedBudget = computed(() => {
  const current = run.value;
  if (current === null) {
    return 1;
  }
  const base = Math.max(current.spentCostUsd, current.maxCostUsd ?? 0, 0.5);
  const next = Math.min(MAX_WORKFLOW_MAX_COST_USD, Math.max(1, base * 2));
  return Number(next.toFixed(4));
});

watch(
  () => props.run?.id,
  () => {
    expandedStepIds.value = [];
    newBudget.value = suggestedBudget.value;
  },
  { immediate: true },
);

watch(suggestedBudget, (value) => {
  if (newBudget.value === null) {
    newBudget.value = value;
  }
});

function toggleStep(stepId: string): void {
  expandedStepIds.value = expandedStepIds.value.includes(stepId)
    ? expandedStepIds.value.filter((id) => id !== stepId)
    : [...expandedStepIds.value, stepId];
}

function openChapter(step: WorkflowStepDto): void {
  const current = run.value;
  if (current === null) {
    return;
  }
  void router.push(`/books/${current.bookId}/${step.chapterId}`);
}

async function mutate(action: () => Promise<void>, successText: string): Promise<void> {
  try {
    await action();
    message.success(successText);
  } catch (error) {
    message.error(describeError(error));
  }
}

function pause(): void {
  const current = run.value;
  if (current === null) {
    return;
  }
  void mutate(() => workflowsStore.pauseRun(current.id), '已请求暂停，将在本章安全断点停下');
}

function resume(): void {
  const current = run.value;
  if (current === null) {
    return;
  }
  void mutate(() => workflowsStore.resumeRun(current.id), '已从断点续跑，仅补跑未完成章节');
}

function resumeWithBudget(): void {
  const current = run.value;
  if (current === null) {
    return;
  }
  const budget = newBudget.value;
  if (budget === null || budget < MIN_WORKFLOW_MAX_COST_USD || budget > MAX_WORKFLOW_MAX_COST_USD) {
    message.error(`预算上限须在 $${MIN_WORKFLOW_MAX_COST_USD} – $${MAX_WORKFLOW_MAX_COST_USD} 之间`);
    return;
  }
  void mutate(
    () => workflowsStore.resumeRun(current.id, { maxCostUsd: budget }),
    `预算已上调至 $${budget.toFixed(2)}，正在断点续跑`,
  );
}

function cancel(): void {
  const current = run.value;
  if (current === null) {
    return;
  }
  dialog.warning({
    title: '取消批量任务',
    content: '取消后剩余章节将被标记为已跳过，已完成的章节成果会完整保留。确认取消？',
    positiveText: '确认取消',
    negativeText: '继续运行',
    onPositiveClick: () => {
      void mutate(() => workflowsStore.cancelRun(current.id), '批量任务已取消');
    },
  });
}

function retryStep(step: WorkflowStepDto): void {
  const current = run.value;
  if (current === null) {
    return;
  }
  void mutate(
    () => workflowsStore.retryStep(current.id, step.id),
    `「${step.chapterTitleSnapshot}」已重新入队，仅补跑该章`,
  );
}

function remove(): void {
  const current = run.value;
  if (current === null) {
    return;
  }
  dialog.warning({
    title: '删除批次记录',
    content: '删除后该批次的执行记录与步骤将不可恢复，已写入的章节正文不受影响。确认删除？',
    positiveText: '删除记录',
    negativeText: '保留',
    onPositiveClick: () => {
      void mutate(() => workflowsStore.deleteRun(current.id), '批次记录已删除');
    },
  });
}

function hasCriticDetail(step: WorkflowStepDto): boolean {
  return (
    step.criticSummary !== null || step.criticIssues.length > 0 || step.criticScore !== null
  );
}
</script>

<template>
  <n-spin :show="loading">
    <div v-if="run === null" class="fx-wf-empty fx-wf-empty--detail">
      尚未选择批次。创建或从左侧选择一条批量任务，即可实时查看逐章进度、审稿得分与费用消耗。
    </div>

    <div v-else class="fx-wf-detail">
      <n-alert v-if="error !== null" type="warning" :bordered="false">
        批次详情刷新失败：{{ error }}
      </n-alert>

      <!-- 摘要卡 -->
      <section class="fx-wf-detail__head">
        <div class="fx-wf-detail__title-row">
          <div class="fx-wf-detail__title">
            <span class="fx-wf-detail__book">{{ run.bookTitle }}</span>
            <n-tag size="small" round :bordered="false" type="info">
              {{ WORKFLOW_MODE_LABELS[run.mode] }}
            </n-tag>
            <n-tag size="small" round :bordered="false" :type="RUN_STATUS_TAG_TYPE[run.status]">
              {{ WORKFLOW_RUN_STATUS_LABELS[run.status] }}
            </n-tag>
            <n-tag
              v-if="run.pauseReason !== null"
              size="small"
              round
              :bordered="false"
              type="warning"
            >
              {{ WORKFLOW_PAUSE_REASON_LABELS[run.pauseReason] }}
            </n-tag>
            <n-tag v-if="run.config.enableCritic" size="small" round :bordered="false">
              审稿 {{ run.config.minPassScore }} 分 · 返工 {{ run.config.maxReworkRounds }} 轮
            </n-tag>
            <n-tag v-if="run.config.enableSummary" size="small" round :bordered="false">
              自动摘要
            </n-tag>
          </div>

          <div class="fx-wf-detail__actions">
            <n-button v-if="canPause" size="small" :loading="workflowsStore.mutating" @click="pause">
              <template #icon>
                <n-icon><pause-outline /></n-icon>
              </template>
              暂停
            </n-button>
            <n-button
              v-if="canResume"
              size="small"
              type="primary"
              :loading="workflowsStore.mutating"
              @click="resume"
            >
              <template #icon>
                <n-icon><play-outline /></n-icon>
              </template>
              继续运行（断点续跑）
            </n-button>
            <n-button
              v-if="canCancel"
              size="small"
              quaternary
              :loading="workflowsStore.mutating"
              @click="cancel"
            >
              取消
            </n-button>
            <n-button v-if="canDelete" size="small" quaternary type="error" @click="remove">
              <template #icon>
                <n-icon><trash-outline /></n-icon>
              </template>
              删除记录
            </n-button>
          </div>
        </div>

        <div class="fx-wf-detail__meta">
          <span>创建于 {{ formatDateTime(run.createdAt) }}</span>
          <span>开始 {{ formatDateTime(run.startedAt) }}</span>
          <span>结束 {{ formatDateTime(run.finishedAt) }}</span>
          <span class="fx-mono">#{{ run.id.slice(0, 8) }}</span>
        </div>
      </section>

      <!-- 预算熔断专属横幅 -->
      <section v-if="isBudgetPaused" class="fx-wf-budget-banner">
        <div class="fx-wf-budget-banner__text">
          <div class="fx-wf-budget-banner__title">
            <n-icon size="16"><trending-up-outline /></n-icon>
            已触及预算上限 ${{ (run.maxCostUsd ?? 0).toFixed(2) }}，批次自动熔断暂停
          </div>
          <div class="fx-wf-budget-banner__desc">
            当前累计消耗 {{ formatUsd(run.spentCostUsd) }}，已完成 {{ run.completedSteps }} /
            {{ run.totalSteps }} 章的正文、摘要与快照均已安全保留。上调预算后可从断点继续，不会重复消耗已完成章节。
          </div>
        </div>
        <div class="fx-wf-budget-banner__form">
          <n-input-number
            v-model:value="newBudget"
            :min="MIN_WORKFLOW_MAX_COST_USD"
            :max="MAX_WORKFLOW_MAX_COST_USD"
            :step="0.5"
            :precision="4"
            style="width: 160px"
          >
            <template #prefix>$</template>
          </n-input-number>
          <n-button type="primary" :loading="workflowsStore.mutating" @click="resumeWithBudget">
            <template #icon>
              <n-icon><refresh-outline /></n-icon>
            </template>
            上调预算并续跑
          </n-button>
        </div>
      </section>

      <n-alert v-if="run.errorCode !== null || run.errorMessage !== null" type="error" :bordered="false">
        <div v-if="run.errorCode !== null">
          错误码：<code class="fx-mono">{{ run.errorCode }}</code>
        </div>
        <div v-if="run.errorMessage !== null" style="margin-top: 4px">{{ run.errorMessage }}</div>
      </n-alert>

      <!-- 进度与成本 KPI -->
      <section class="fx-wf-kpi">
        <div class="fx-wf-kpi__item">
          <div class="fx-wf-kpi__head">
            <span class="fx-wf-kpi__label">章节进度</span>
            <span class="fx-wf-kpi__value">
              {{ formatInteger(run.completedSteps) }} / {{ formatInteger(run.totalSteps) }}
              <span v-if="run.failedSteps > 0" class="fx-wf-kpi__failed">
                失败 {{ formatInteger(run.failedSteps) }}
              </span>
            </span>
          </div>
          <n-progress
            type="line"
            :percentage="stepProgress"
            :height="8"
            :show-indicator="false"
            :status="run.failedSteps > 0 ? 'error' : run.status === 'completed' ? 'success' : 'default'"
          />
        </div>

        <div class="fx-wf-kpi__item">
          <div class="fx-wf-kpi__head">
            <span class="fx-wf-kpi__label">预算占用</span>
            <span class="fx-wf-kpi__value">
              {{ formatUsd(run.spentCostUsd) }}
              <span class="fx-tertiary">
                / {{ run.maxCostUsd === null ? '不限' : formatUsd(run.maxCostUsd, 2) }}
              </span>
            </span>
          </div>
          <n-progress
            type="line"
            :percentage="budgetPercent"
            :height="8"
            :show-indicator="false"
            :status="budgetPercent >= 100 ? 'error' : budgetPercent >= 80 ? 'warning' : 'default'"
          />
        </div>

        <div class="fx-wf-kpi__item fx-wf-kpi__item--tokens">
          <div class="fx-wf-kpi__head">
            <span class="fx-wf-kpi__label">累计 Tokens</span>
          </div>
          <div class="fx-wf-kpi__tokens">
            <div>
              <div class="fx-tertiary">Input</div>
              <div class="fx-wf-kpi__value">{{ formatInteger(run.totalInputTokens) }}</div>
            </div>
            <div>
              <div class="fx-tertiary">Output</div>
              <div class="fx-wf-kpi__value">{{ formatInteger(run.totalOutputTokens) }}</div>
            </div>
          </div>
        </div>
      </section>

      <!-- 逐章步骤时间线 -->
      <section class="fx-wf-steps">
        <header class="fx-wf-steps__head">
          <span class="fx-panel__subtitle" style="margin: 0">章节步骤时间线</span>
          <span class="fx-tertiary">{{ run.steps.length }} 个步骤</span>
        </header>

        <div v-if="run.steps.length === 0" class="fx-wf-empty">该批次尚无步骤记录。</div>

        <article
          v-for="(step, index) in run.steps"
          :key="step.id"
          :class="['fx-wf-step', `fx-wf-step--${step.status}`]"
        >
          <div class="fx-wf-step__rail">
            <span class="fx-wf-step__dot" />
            <span class="fx-wf-step__line" />
          </div>

          <div class="fx-wf-step__body">
            <div class="fx-wf-step__head">
              <div class="fx-wf-step__title-row">
                <span class="fx-wf-step__index">{{ index + 1 }}</span>
                <button type="button" class="fx-wf-step__title" @click="openChapter(step)">
                  {{ step.chapterTitleSnapshot }}
                  <n-icon size="12"><create-outline /></n-icon>
                </button>
                <n-tag
                  size="tiny"
                  round
                  :bordered="false"
                  :type="STEP_STATUS_TAG_TYPE[step.status]"
                >
                  {{ WORKFLOW_STEP_STATUS_LABELS[step.status] }}
                </n-tag>
                <n-tag
                  v-if="step.status === 'running' || step.stage !== 'idle'"
                  size="tiny"
                  round
                  :bordered="false"
                  :type="STEP_STAGE_TAG_TYPE[step.stage]"
                >
                  {{ WORKFLOW_STEP_STAGE_LABELS[step.stage] }}
                </n-tag>
                <n-tag v-if="step.backupRevisionId !== null" size="tiny" round :bordered="false" type="info">
                  已留 AI 快照
                </n-tag>
              </div>

              <div class="fx-wf-step__actions">
                <n-button
                  v-if="step.status === 'failed'"
                  size="tiny"
                  type="primary"
                  secondary
                  :loading="workflowsStore.retryingStepId === step.id"
                  @click="retryStep(step)"
                >
                  重试此章
                </n-button>
                <n-button
                  v-if="hasCriticDetail(step)"
                  size="tiny"
                  quaternary
                  @click="toggleStep(step.id)"
                >
                  <template #icon>
                    <n-icon>
                      <chevron-down-outline v-if="expandedStepIds.includes(step.id)" />
                      <chevron-forward-outline v-else />
                    </n-icon>
                  </template>
                  审稿详情
                </n-button>
              </div>
            </div>

            <div class="fx-wf-step__metrics">
              <span>
                字数 <strong>{{ formatWordCount(step.outputWordCount) }}</strong>
              </span>
              <span>
                返工 <strong>{{ step.reworkCount }}</strong> 轮
              </span>
              <span v-if="step.criticScore !== null">
                审稿分 <strong>{{ step.criticScore }}</strong>
                <n-tag
                  size="tiny"
                  round
                  :bordered="false"
                  :type="step.criticPassed === true ? 'success' : 'warning'"
                >
                  {{ step.criticPassed === true ? '通过' : '未通过' }}
                </n-tag>
              </span>
              <span>
                估算费用 <strong>{{ formatUsd(step.estimatedCostUsd) }}</strong>
              </span>
              <span class="fx-tertiary">
                Tokens {{ formatInteger(step.inputTokens) }} / {{ formatInteger(step.outputTokens) }}
              </span>
            </div>

            <div v-if="step.errorCode !== null || step.errorMessage !== null" class="fx-wf-step__error">
              <span v-if="step.errorCode !== null" class="fx-mono">{{ step.errorCode }}</span>
              <span v-if="step.errorMessage !== null">{{ step.errorMessage }}</span>
            </div>

            <div v-if="expandedStepIds.includes(step.id)" class="fx-wf-step__critic">
              <div v-if="step.criticSummary !== null" class="fx-wf-step__critic-summary">
                {{ step.criticSummary }}
              </div>
              <ul v-if="step.criticIssues.length > 0" class="fx-wf-step__issues">
                <li v-for="(issue, issueIndex) in step.criticIssues" :key="issueIndex">
                  {{ issue }}
                </li>
              </ul>
              <div v-if="step.criticSummary === null && step.criticIssues.length === 0" class="fx-tertiary">
                暂无审稿明细。
              </div>
            </div>
          </div>
        </article>
      </section>

      <div v-if="run.config.instruction.length > 0" class="fx-wf-instruction">
        <span class="fx-tertiary">全局补充指令：</span>{{ run.config.instruction }}
      </div>
    </div>
  </n-spin>
</template>
