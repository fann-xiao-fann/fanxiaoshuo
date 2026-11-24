<script setup lang="ts">
import type { ComponentStatus } from '@fanxiaoshuo/shared';
import { NButton, NIcon, NPopover } from 'naive-ui';
import { RefreshOutline } from '@vicons/ionicons5';
import { computed } from 'vue';
import { useHealthStore } from '@/stores/health';
import { formatDateTime, formatTimeOnly } from '@/utils/format';

interface HealthRow {
  key: string;
  name: string;
  status: ComponentStatus;
  latencyMs: number | null;
  message: string | null;
  heartbeat: string | null;
  activeJobs: number | null;
}

const health = useHealthStore();

const rows = computed<HealthRow[]>(() => [
  {
    key: 'api',
    name: 'Fastify API',
    status: health.apiStatus,
    latencyMs: health.apiLatencyMs,
    message: health.error,
    heartbeat: health.lastCheckedAt === null ? null : formatTimeOnly(health.lastCheckedAt),
    activeJobs: null,
  },
  {
    key: 'postgres',
    name: 'PostgreSQL',
    status: health.postgres.status,
    latencyMs: health.postgres.latencyMs,
    message: health.postgres.message,
    heartbeat: null,
    activeJobs: null,
  },
  {
    key: 'redis',
    name: 'Redis',
    status: health.redis.status,
    latencyMs: health.redis.latencyMs,
    message: health.redis.message,
    heartbeat: null,
    activeJobs: null,
  },
  {
    key: 'worker',
    name: 'BullMQ Worker',
    status: health.worker.status,
    latencyMs: health.worker.latencyMs,
    message: health.worker.message,
    heartbeat: health.worker.lastHeartbeatAt,
    activeJobs: health.worker.activeJobs,
  },
]);

const formattedRows = computed(() =>
  rows.value.map((row) => ({
    ...row,
    heartbeat: row.key === 'worker' ? formatDateTime(row.heartbeat) : row.heartbeat,
  })),
);

const overallDotClass = computed(() => {
  switch (health.overall) {
    case 'ok':
      return 'fx-status-dot fx-status-dot--ok';
    case 'degraded':
      return 'fx-status-dot fx-status-dot--degraded';
    case 'down':
      return 'fx-status-dot fx-status-dot--down';
    default:
      return 'fx-status-dot fx-status-dot--unknown';
  }
});

const STATUS_TEXT: Record<ComponentStatus, string> = {
  ok: '在线',
  degraded: '降级',
  down: '离线',
  unknown: '未探测',
};

function dotClass(status: ComponentStatus): string {
  return `fx-status-dot fx-status-dot--${status}`;
}
</script>

<template>
  <n-popover trigger="click" placement="bottom-end" :show-arrow="true">
    <template #trigger>
      <button type="button" class="fx-health-trigger" :title="health.error ?? '点击查看基础设施诊断'">
        <span :class="overallDotClass" />
        <span>{{ health.overallLabel }}</span>
        <span class="fx-tertiary">·</span>
        <span class="fx-mono">{{ health.lastCheckedText }}</span>
      </button>
    </template>

    <div class="fx-health-popover">
      <div class="fx-inline" style="justify-content: space-between">
        <strong style="font-size: 13px">基础设施健康</strong>
        <n-button
          text
          size="tiny"
          :loading="health.loading"
          @click="health.refresh()"
        >
          <template #icon>
            <n-icon><refresh-outline /></n-icon>
          </template>
          重新探测
        </n-button>
      </div>

      <div v-for="row in formattedRows" :key="row.key" class="fx-health-row">
        <div class="fx-stack" style="gap: 3px">
          <span class="fx-health-row__name">
            <span :class="dotClass(row.status)" />
            {{ row.name }}
            <span class="fx-tertiary" style="font-weight: 400">{{ STATUS_TEXT[row.status] }}</span>
          </span>
          <span v-if="row.message" class="fx-error-text">{{ row.message }}</span>
          <span v-if="row.activeJobs !== null" class="fx-tertiary" style="font-size: 11px">
            活跃任务 {{ row.activeJobs }} 个
          </span>
        </div>
        <div class="fx-health-row__meta">
          <div>{{ row.latencyMs !== null ? `${row.latencyMs} ms` : '—' }}</div>
          <div v-if="row.heartbeat" style="max-width: 150px">{{ row.heartbeat }}</div>
        </div>
      </div>

      <p class="fx-tertiary" style="margin: 0; font-size: 11px; line-height: 1.6">
        每 15 秒自动轮询 `/api/v1/health`；服务不可达时状态徽章降级展示，不会阻塞其它页面。
      </p>
    </div>
  </n-popover>
</template>
