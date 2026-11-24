<script setup lang="ts">
import {
  jobEventSchema,
  type JobEvent,
  type SmokeJobDto,
  type SmokeJobStatus,
} from '@fanxiaoshuo/shared';
import {
  NAlert,
  NButton,
  NIcon,
  NInput,
  NRadioButton,
  NRadioGroup,
  NTag,
  useMessage,
} from 'naive-ui';
import { FlaskOutline, PlayOutline, RefreshOutline } from '@vicons/ionicons5';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { describeError } from '@/api/errors';
import { runtimeApi } from '@/api/runtime';
import {
  formatDuration,
  formatInteger,
  formatLatency,
  formatTimeOnly,
  formatUsd,
} from '@/utils/format';

const message = useMessage();

const mode = ref('echo');
const note = ref('');
const submitting = ref(false);
const requestError = ref<string | null>(null);
const fetchError = ref<string | null>(null);
const currentJob = ref<SmokeJobDto | null>(null);
const fetching = ref(false);

type SseState = 'idle' | 'connecting' | 'connected' | 'error';
const sseState = ref<SseState>('idle');
const events = ref<JobEvent[]>([]);

let eventSource: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let polledJobId: string | null = null;

const STATUS_LABEL: Record<SmokeJobStatus, string> = {
  queued: '排队中',
  active: '执行中',
  completed: '已完成',
  failed: '已失败',
};

const STATUS_TYPE: Record<SmokeJobStatus, 'info' | 'warning' | 'success' | 'error'> = {
  queued: 'info',
  active: 'warning',
  completed: 'success',
  failed: 'error',
};

const SSE_LABEL: Record<SseState, string> = {
  idle: '未连接',
  connecting: '连接中',
  connected: '已连接',
  error: '连接异常（自动重连）',
};

const SSE_TYPE: Record<SseState, 'default' | 'info' | 'success' | 'warning'> = {
  idle: 'default',
  connecting: 'info',
  connected: 'success',
  error: 'warning',
};

const pollingActive = computed(() => pollTimer !== null);
const jobDurationText = computed(() => {
  const job = currentJob.value;
  if (job === null) {
    return '—';
  }
  if (job.durationMs !== null) {
    return formatDuration(job.durationMs);
  }
  if (job.startedAt !== null && job.finishedAt !== null) {
    return formatDuration(new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime());
  }
  return '—';
});
const jobEvents = computed(() => {
  const jobId = currentJob.value?.jobId;
  if (jobId === undefined) {
    return [];
  }
  return events.value.filter((event) => event.jobId === jobId);
});
const recentJobEvents = computed(() => jobEvents.value.slice(-8).reverse());

interface TimelineItem {
  key: string;
  label: string;
  state: 'done' | 'active' | 'failed' | 'pending';
  time: string | null;
  description: string;
}

const timeline = computed<TimelineItem[]>(() => {
  const job = currentJob.value;
  if (job === null) {
    return [];
  }
  const items: TimelineItem[] = [
    {
      key: 'queued',
      label: '已入队',
      state: 'done',
      time: job.createdAt,
      description: `任务已写入 runtime-smoke 队列（${job.invokeModel ? 'live 真实模型验证' : 'echo 纯引擎验证'}）。`,
    },
  ];
  if (job.status === 'queued') {
    return items;
  }
  items.push({
    key: 'active',
    label: 'Worker 执行中',
    state: job.status === 'active' ? 'active' : 'done',
    time: job.startedAt,
    description: job.invokeModel
      ? 'Worker 已领取任务，初始化 Mastra 运行时并调用角色绑定的真实模型。'
      : 'Worker 已领取任务，仅验证队列 + Mastra 引擎链路（不消耗模型 Token）。',
  });
  if (job.status === 'completed') {
    items.push({
      key: 'completed',
      label: '执行完成',
      state: 'done',
      time: job.finishedAt,
      description: job.result?.engineOk ? 'Mastra 运行时初始化成功，任务结果已回写。' : '任务已结束。',
    });
  }
  if (job.status === 'failed') {
    items.push({
      key: 'failed',
      label: '执行失败',
      state: 'failed',
      time: job.finishedAt,
      description: job.errorMessage ?? 'Worker 执行异常，已按指数退避重试至上限。',
    });
  }
  return items;
});

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  polledJobId = null;
}

async function fetchJob(jobId: string): Promise<void> {
  if (fetching.value) {
    return;
  }
  fetching.value = true;
  try {
    const job = await runtimeApi.getSmokeJob(jobId);
    if (currentJob.value?.jobId !== jobId) {
      return;
    }
    currentJob.value = job;
    fetchError.value = null;
    if (job.status === 'completed' || job.status === 'failed') {
      stopPolling();
    }
  } catch (error) {
    fetchError.value = describeError(error);
  } finally {
    fetching.value = false;
  }
}

function startPolling(jobId: string): void {
  stopPolling();
  polledJobId = jobId;
  pollTimer = setInterval(() => {
    if (polledJobId !== jobId) {
      return;
    }
    void fetchJob(jobId);
  }, 2_000);
}

function handleJobEvent(raw: unknown): void {
  const parsed = jobEventSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  const event = parsed.data;
  events.value = [...events.value.slice(-39), event];

  const job = currentJob.value;
  if (job === null || job.jobId !== event.jobId) {
    return;
  }
  const nextStatus = event.status;
  currentJob.value = {
    ...job,
    status: nextStatus,
    attemptsMade: event.attemptsMade,
    startedAt:
      nextStatus === 'queued' ? job.startedAt : (job.startedAt ?? event.timestamp),
    finishedAt:
      nextStatus === 'completed' || nextStatus === 'failed'
        ? (job.finishedAt ?? event.timestamp)
        : job.finishedAt,
    errorCode: event.errorCode ?? job.errorCode,
    errorMessage: event.errorMessage ?? job.errorMessage,
  };
  if (nextStatus === 'completed' || nextStatus === 'failed') {
    stopPolling();
    void fetchJob(event.jobId);
  }
}

function connectEvents(): void {
  if (typeof EventSource === 'undefined') {
    sseState.value = 'error';
    return;
  }
  sseState.value = 'connecting';
  eventSource = new EventSource(runtimeApi.eventsUrl());
  eventSource.onopen = () => {
    sseState.value = 'connected';
  };
  eventSource.onerror = () => {
    sseState.value = 'error';
  };
  eventSource.addEventListener('ready', () => {
    sseState.value = 'connected';
  });
  eventSource.addEventListener('job-event', (event) => {
    try {
      const messageEvent = event as MessageEvent<string>;
      handleJobEvent(JSON.parse(messageEvent.data) as unknown);
    } catch {
      /* 非 JSON 帧忽略，等待下一条 */
    }
  });
}

async function triggerSmokeJob(): Promise<void> {
  submitting.value = true;
  requestError.value = null;
  fetchError.value = null;
  try {
    const created = await runtimeApi.createSmokeJob({
      invokeModel: mode.value === 'live',
      ...(note.value.trim().length > 0 ? { note: note.value.trim() } : {}),
    });
    const now = new Date().toISOString();
    currentJob.value = {
      jobId: created.jobId,
      status: 'queued',
      invokeModel: mode.value === 'live',
      note: note.value.trim().length > 0 ? note.value.trim() : null,
      attemptsMade: 0,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      result: null,
      errorCode: null,
      errorMessage: null,
    };
    startPolling(created.jobId);
    message.success('冒烟任务已入队，正在跟踪状态流转');
    void fetchJob(created.jobId);
  } catch (error) {
    requestError.value = describeError(error);
    message.error(requestError.value);
  } finally {
    submitting.value = false;
  }
}

function refreshCurrentJob(): void {
  const jobId = currentJob.value?.jobId;
  if (jobId !== undefined) {
    void fetchJob(jobId);
  }
}

onMounted(() => {
  connectEvents();
});

onUnmounted(() => {
  stopPolling();
  eventSource?.close();
  eventSource = null;
});
</script>

<template>
  <section class="fx-panel">
    <header class="fx-panel__head">
      <div>
        <div class="fx-panel__title">Mastra + BullMQ 冒烟验证</div>
        <div class="fx-panel__subtitle">
          触发一个后台任务，验证 API 入队 → BullMQ Worker 消费 → Mastra 运行时执行 → 状态回写的全链路。
          状态通过 `GET /api/v1/runtime/events`（SSE）实时推送，并以 2 秒轮询兜底。
        </div>
      </div>
      <div class="fx-panel__actions">
        <n-tag size="small" round :bordered="false" :type="SSE_TYPE[sseState]">
          SSE {{ SSE_LABEL[sseState] }}
        </n-tag>
      </div>
    </header>

    <div class="fx-panel__body" style="display: flex; flex-direction: column; gap: 16px">
      <n-alert v-if="requestError" type="error" :bordered="false">
        {{ requestError }}
      </n-alert>

      <div class="fx-form-grid" style="align-items: start">
        <div class="fx-stack" style="gap: 8px">
          <span class="fx-result-metric__label">验证模式</span>
          <n-radio-group v-model:value="mode" size="small">
            <n-radio-button value="echo">echo · 纯引擎队列验证</n-radio-button>
            <n-radio-button value="live">live · 真实模型调用</n-radio-button>
          </n-radio-group>
          <div class="fx-form-hint">
            <template v-if="mode === 'echo'">
              不调用上游模型，仅验证 BullMQ 队列、Worker 心跳与 Mastra 引擎初始化，零 Token 消耗。
            </template>
            <template v-else>
              live 模式由服务端按当前角色路由解析默认写手模型并真实调用一次，会写入用量日志；
              可在「模型配置中心」调整绑定。
            </template>
          </div>
        </div>

        <div class="fx-stack" style="gap: 8px">
          <span class="fx-result-metric__label">任务备注（可选）</span>
          <n-input
            v-model:value="note"
            size="small"
            maxlength="200"
            show-count
            placeholder="例如：验证 Change 1 队列链路"
          />
        </div>
      </div>

      <div class="fx-inline">
        <n-button type="primary" :loading="submitting" @click="triggerSmokeJob">
          <template #icon>
            <n-icon><play-outline /></n-icon>
          </template>
          触发冒烟任务
        </n-button>
        <n-button
          v-if="currentJob"
          quaternary
          size="medium"
          :loading="fetching"
          @click="refreshCurrentJob"
        >
          <template #icon>
            <n-icon><refresh-outline /></n-icon>
          </template>
          刷新当前任务
        </n-button>
        <span v-if="currentJob" class="fx-tertiary" style="font-size: 11px">
          jobId：<code class="fx-mono">{{ currentJob.jobId }}</code>
        </span>
      </div>

      <n-alert v-if="fetchError" type="warning" :bordered="false">
        状态刷新失败：{{ fetchError }}
      </n-alert>

      <template v-if="currentJob">
        <div class="fx-panel" style="box-shadow: none">
          <div class="fx-panel__body">
            <div class="fx-inline" style="justify-content: space-between; margin-bottom: 14px">
              <div class="fx-inline">
                <span class="fx-panel__icon">
                  <n-icon size="16"><flask-outline /></n-icon>
                </span>
                <strong style="font-size: 14px">任务状态</strong>
                <n-tag size="small" round :bordered="false" :type="STATUS_TYPE[currentJob.status]">
                  {{ STATUS_LABEL[currentJob.status] }}
                </n-tag>
                <n-tag v-if="currentJob.attemptsMade > 0" size="small" round :bordered="false" type="warning">
                  已重试 {{ currentJob.attemptsMade }} 次
                </n-tag>
              </div>
              <div class="fx-inline" style="gap: 14px">
                <span class="fx-tertiary" style="font-size: 11px">
                  耗时：{{ jobDurationText }}
                </span>
                <span class="fx-tertiary" style="font-size: 11px">
                  {{ pollingActive ? '轮询兜底中' : '实时事件监听' }}
                </span>
              </div>
            </div>

            <div class="fx-timeline" style="margin-bottom: 18px">
              <div v-for="item in timeline" :key="item.key" class="fx-timeline__item">
                <div class="fx-timeline__rail">
                  <span :class="`fx-timeline__node fx-timeline__node--${item.state}`" />
                  <span class="fx-timeline__line" />
                </div>
                <div class="fx-timeline__time">{{ formatTimeOnly(item.time) }}</div>
                <div class="fx-timeline__content">
                  <div class="fx-timeline__label">{{ item.label }}</div>
                  <div class="fx-timeline__desc">{{ item.description }}</div>
                </div>
              </div>
            </div>

            <div v-if="currentJob.result" style="margin-bottom: 14px">
              <div class="fx-inline" style="gap: 8px; margin-bottom: 8px">
                <n-tag size="small" round :bordered="false" :type="currentJob.result.engineOk ? 'success' : 'error'">
                  引擎 {{ currentJob.result.engineOk ? '正常' : '异常' }}
                </n-tag>
                <n-tag size="small" round :bordered="false" :type="currentJob.result.modelTested ? 'info' : 'default'">
                  {{ currentJob.result.modelTested ? '已真实调用模型' : '未调用模型' }}
                </n-tag>
              </div>
              <div class="fx-result-metrics">
                <div class="fx-result-metric">
                  <div class="fx-result-metric__label">模型延迟</div>
                  <div class="fx-result-metric__value">{{ formatLatency(currentJob.result.latencyMs) }}</div>
                </div>
                <div class="fx-result-metric">
                  <div class="fx-result-metric__label">输入 Tokens</div>
                  <div class="fx-result-metric__value">{{ formatInteger(currentJob.result.inputTokens) }}</div>
                </div>
                <div class="fx-result-metric">
                  <div class="fx-result-metric__label">输出 Tokens</div>
                  <div class="fx-result-metric__value">{{ formatInteger(currentJob.result.outputTokens) }}</div>
                </div>
                <div class="fx-result-metric">
                  <div class="fx-result-metric__label">估算费用</div>
                  <div class="fx-result-metric__value fx-kpi__value--accent">
                    {{ formatUsd(currentJob.result.estimatedCostUsd) }}
                  </div>
                </div>
              </div>
              <div v-if="currentJob.result.replyPreview" class="fx-stack" style="margin-top: 12px">
                <span class="fx-result-metric__label">模型回复预览</span>
                <div class="fx-reply-preview">{{ currentJob.result.replyPreview }}</div>
              </div>
            </div>

            <n-alert v-if="currentJob.errorCode || currentJob.errorMessage" type="error" :bordered="false">
              <div v-if="currentJob.errorCode">
                错误码：<code class="fx-mono">{{ currentJob.errorCode }}</code>
              </div>
              <div v-if="currentJob.errorMessage" style="margin-top: 4px">
                {{ currentJob.errorMessage }}
              </div>
            </n-alert>

            <div class="fx-stack" style="margin-top: 16px; gap: 6px">
              <div class="fx-inline" style="justify-content: space-between">
                <span class="fx-result-metric__label">SSE 事件流</span>
                <span class="fx-tertiary" style="font-size: 11px">
                  {{ jobEvents.length }} 条事件（最多保留最近 40 条）
                </span>
              </div>
              <div v-if="recentJobEvents.length === 0" class="fx-empty" style="padding: 16px">
                尚未收到该任务的 SSE 事件；若 SSE 不可用，将依靠轮询刷新任务状态。
              </div>
              <div
                v-for="(event, index) in recentJobEvents"
                :key="`${event.timestamp}-${event.status}-${index}`"
                class="fx-health-row"
              >
                <span class="fx-inline" style="gap: 6px">
                  <span :class="`fx-status-dot fx-status-dot--${event.status === 'failed' ? 'down' : event.status === 'active' ? 'degraded' : 'ok'}`" />
                  <code class="fx-mono" style="font-size: 11px">{{ event.type }}</code>
                </span>
                <span class="fx-health-row__meta">{{ formatTimeOnly(event.timestamp) }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>

      <div v-else class="fx-empty">
        尚未触发任务。选择验证模式后点击「触发冒烟任务」，这里将实时展示 queued → active → completed / failed 的状态流转。
      </div>
    </div>
  </section>
</template>
