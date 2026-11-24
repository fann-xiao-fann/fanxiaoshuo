<script setup lang="ts">
import type { ComponentHealth, ComponentStatus } from '@fanxiaoshuo/shared';
import { NAlert, NButton, NIcon, NTag } from 'naive-ui';
import { RefreshOutline } from '@vicons/ionicons5';
import { computed, onMounted } from 'vue';
import { useHealthStore } from '@/stores/health';
import { formatDateTime } from '@/utils/format';

const health = useHealthStore();

const STATUS_LABEL: Record<ComponentStatus, string> = {
  ok: '正常',
  degraded: '降级',
  down: '离线',
  unknown: '未探测',
};

const STATUS_TYPE: Record<ComponentStatus, 'success' | 'warning' | 'error' | 'default'> = {
  ok: 'success',
  degraded: 'warning',
  down: 'error',
  unknown: 'default',
};

interface DiagCard {
  key: string;
  name: string;
  status: ComponentStatus;
  latencyMs: number | null;
  message: string | null;
  heartbeatAt: string | null;
  activeJobs: number | null;
  extra: string | null;
}

const cards = computed<DiagCard[]>(() => [
  {
    key: 'api',
    name: 'Fastify API',
    status: health.apiStatus,
    latencyMs: health.apiLatencyMs,
    message: health.error,
    heartbeatAt: health.lastCheckedAt === null ? null : new Date(health.lastCheckedAt).toISOString(),
    activeJobs: null,
    extra: health.errorCode,
  },
  ...(
    [
      ['postgres', 'PostgreSQL', health.postgres],
      ['redis', 'Redis', health.redis],
      ['worker', 'BullMQ Worker', health.worker],
    ] as const
  ).map(([key, name, component]: readonly [string, string, ComponentHealth]) => ({
    key,
    name,
    status: component.status,
    latencyMs: component.latencyMs,
    message: component.message,
    heartbeatAt: component.lastHeartbeatAt,
    activeJobs: component.activeJobs,
    extra: null,
  })),
]);

onMounted(() => {
  void health.refresh();
});
</script>

<template>
  <section class="fx-panel">
    <header class="fx-panel__head">
      <div>
        <div class="fx-panel__title">基础设施诊断</div>
        <div class="fx-panel__subtitle">
          由服务端主动探测 PostgreSQL（SELECT 1）、Redis（PING）与 Worker 心跳键；整体状态为
          <code class="fx-mono">ok</code> 要求全部组件正常。任一依赖离线时仅标记异常组件，工作台其余区域继续可用。
        </div>
      </div>
      <div class="fx-panel__actions">
        <span class="fx-tertiary" style="font-size: 11px">最近探测 {{ health.lastCheckedText }}</span>
        <n-button size="small" quaternary :loading="health.loading" @click="health.refresh()">
          <template #icon>
            <n-icon><refresh-outline /></n-icon>
          </template>
          立即探测
        </n-button>
      </div>
    </header>

    <div class="fx-panel__body">
      <n-alert v-if="health.error" type="warning" :bordered="false" style="margin-bottom: 14px">
        <strong>无法访问 API：</strong>{{ health.error }}
        <div style="margin-top: 4px; font-size: 12px">
          状态卡片已降级为「离线」，请确认 `apps/server` 与 Docker 依赖是否启动。
        </div>
      </n-alert>

      <div class="fx-diag-grid">
        <article v-for="card in cards" :key="card.key" class="fx-diag-card">
          <div class="fx-diag-card__head">
            <span class="fx-diag-card__name">
              <span :class="`fx-status-dot fx-status-dot--${card.status}`" />
              {{ card.name }}
            </span>
            <n-tag size="tiny" round :bordered="false" :type="STATUS_TYPE[card.status]">
              {{ STATUS_LABEL[card.status] }}
            </n-tag>
          </div>

          <div class="fx-diag-card__metric">
            探测延迟：{{ card.latencyMs === null ? '—' : `${card.latencyMs} ms` }}
          </div>

          <div v-if="card.key === 'worker'" class="fx-diag-card__metric">
            最近心跳：{{ formatDateTime(card.heartbeatAt) }}
            <template v-if="card.activeJobs !== null"> · 活跃任务 {{ card.activeJobs }}</template>
          </div>

          <div v-else-if="card.key === 'api'" class="fx-diag-card__metric">
            最近成功探测：{{ formatDateTime(card.heartbeatAt) }}
          </div>

          <div v-if="card.extra" class="fx-diag-card__metric">错误码：{{ card.extra }}</div>

          <div v-if="card.message" class="fx-diag-card__message">{{ card.message }}</div>
          <div v-else-if="card.status === 'ok'" class="fx-tertiary" style="font-size: 11px">
            连通正常，无告警。
          </div>
        </article>
      </div>

      <p class="fx-form-hint" style="margin-top: 14px">
        Worker 心跳每 10 秒刷新、TTL 30 秒；超过有效期未上报即判定为离线。所有探测均不会修改业务数据。
      </p>
    </div>
  </section>
</template>
