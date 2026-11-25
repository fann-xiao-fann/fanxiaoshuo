<script setup lang="ts">
import {
  QUEUE_NAMES,
  REDIS_CHANNELS,
  WORKER_HEARTBEAT,
} from '@fanxiaoshuo/shared';
import { NButton, NIcon, NTag } from 'naive-ui';
import { PulseOutline, RefreshOutline } from '@vicons/ionicons5';
import { computed } from 'vue';
import DiagnosticsPanel from '@/components/runtime/DiagnosticsPanel.vue';
import SmokeJobPanel from '@/components/runtime/SmokeJobPanel.vue';
import UsageLogsPanel from '@/components/runtime/UsageLogsPanel.vue';
import { API_BASE_URL } from '@/api/config';
import { useHealthStore } from '@/stores/health';

const health = useHealthStore();

const overallTagType = computed(() => {
  switch (health.overall) {
    case 'ok':
      return 'success' as const;
    case 'degraded':
      return 'warning' as const;
    case 'down':
      return 'error' as const;
    default:
      return 'default' as const;
  }
});

const heartbeatSeconds = Math.round(WORKER_HEARTBEAT.intervalMs / 1_000);

function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
</script>

<template>
  <div class="fx-page">
    <section class="fx-panel">
      <div class="fx-panel__body">
        <div class="fx-inline" style="justify-content: space-between; margin-bottom: 14px">
          <div>
            <div class="fx-panel__title">
              <span class="fx-panel__icon">
                <n-icon size="17"><pulse-outline /></n-icon>
              </span>
              运行期观测台
            </div>
            <div class="fx-panel__subtitle">
              汇总基础设施健康、Mastra + BullMQ 冒烟验证与批量流水线队列、统一网关的 Token / 费用账本。
              本页所有诊断均为只读探测，不会修改业务数据。
            </div>
          </div>
          <div class="fx-panel__actions">
            <n-tag size="small" round :bordered="false" :type="overallTagType">
              {{ health.overallLabel }}
            </n-tag>
            <n-button size="small" quaternary :loading="health.loading" @click="health.refresh()">
              <template #icon>
                <n-icon><refresh-outline /></n-icon>
              </template>
              重新探测
            </n-button>
          </div>
        </div>

        <div class="fx-kpi-grid">
          <div class="fx-kpi">
            <div class="fx-kpi__label">API Base</div>
            <div class="fx-kpi__value" style="font-size: 14px">{{ API_BASE_URL }}</div>
            <div class="fx-kpi__hint">经 Vite 代理或同源部署访问</div>
          </div>
          <div class="fx-kpi">
            <div class="fx-kpi__label">冒烟队列</div>
            <div class="fx-kpi__value" style="font-size: 14px">{{ QUEUE_NAMES.runtimeSmoke }}</div>
            <div class="fx-kpi__hint">BullMQ · Redis</div>
          </div>
          <div class="fx-kpi">
            <div class="fx-kpi__label">批量流水线队列</div>
            <div class="fx-kpi__value" style="font-size: 14px">{{ QUEUE_NAMES.novelWorkflows }}</div>
            <div class="fx-kpi__hint">多 Agent 批量成文队列</div>
          </div>
          <div class="fx-kpi">
            <div class="fx-kpi__label">任务事件频道</div>
            <div class="fx-kpi__value" style="font-size: 14px; overflow-wrap: anywhere">
              {{ REDIS_CHANNELS.jobEvents }}
            </div>
            <div class="fx-kpi__hint">Redis Pub/Sub → SSE</div>
          </div>
          <div class="fx-kpi">
            <div class="fx-kpi__label">流水线事件频道</div>
            <div class="fx-kpi__value" style="font-size: 14px; overflow-wrap: anywhere">
              {{ REDIS_CHANNELS.workflowEvents }}
            </div>
            <div class="fx-kpi__hint">批次 / 步骤实时进度推送</div>
          </div>
          <div class="fx-kpi">
            <div class="fx-kpi__label">Worker 心跳</div>
            <div class="fx-kpi__value" style="font-size: 14px">每 {{ heartbeatSeconds }}s / TTL 30s</div>
            <div class="fx-kpi__hint">
              {{ health.worker.activeJobs === null ? '暂无活跃数' : `活跃任务 ${health.worker.activeJobs}` }}
            </div>
          </div>
        </div>

        <div class="fx-inline" style="margin-top: 16px; gap: 6px">
          <span class="fx-tertiary" style="font-size: 11px; letter-spacing: 0.08em">快速定位</span>
          <n-button text size="tiny" type="primary" @click="scrollToSection('diagnostics')">① 基础设施诊断</n-button>
          <span class="fx-tertiary">·</span>
          <n-button text size="tiny" type="primary" @click="scrollToSection('smoke')">② 冒烟验证</n-button>
          <span class="fx-tertiary">·</span>
          <n-button text size="tiny" type="primary" @click="scrollToSection('usage')">③ 用量与成本</n-button>
        </div>
      </div>
    </section>

    <div id="diagnostics" style="scroll-margin-top: 16px">
      <diagnostics-panel />
    </div>

    <div id="smoke" style="scroll-margin-top: 16px">
      <smoke-job-panel />
    </div>

    <div id="usage" style="scroll-margin-top: 16px">
      <usage-logs-panel />
    </div>
  </div>
</template>
