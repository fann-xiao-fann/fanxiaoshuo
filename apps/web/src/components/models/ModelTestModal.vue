<script setup lang="ts">
import type { TestModelResponse } from '@fanxiaoshuo/shared';
import { NAlert, NButton, NIcon, NModal, NSpin, NTag } from 'naive-ui';
import {
  CheckmarkCircleOutline,
  CloseCircleOutline,
  FlaskOutline,
} from '@vicons/ionicons5';
import { computed } from 'vue';
import { formatInteger, formatLatency, formatUsd } from '@/utils/format';

const props = defineProps<{
  show: boolean;
  modelLabel: string;
  result: TestModelResponse | null;
  loading: boolean;
  requestError: string | null;
}>();

const emit = defineEmits<{
  'update:show': [value: boolean];
}>();

const success = computed(() => props.result?.success === true);
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    style="width: 620px; max-width: calc(100vw - 32px)"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <template #header>
      <div class="fx-inline">
        <n-icon size="18" color="var(--fx-accent)"><flask-outline /></n-icon>
        <span>模型连通性测试</span>
        <n-tag size="small" round :bordered="false" type="default">{{ modelLabel }}</n-tag>
      </div>
    </template>

    <div v-if="loading" style="padding: 40px 0; text-align: center">
      <n-spin size="medium" />
      <p class="fx-muted" style="margin-top: 12px; font-size: 12px">
        正在经统一网关向目标模型发起一次最小对话请求…
      </p>
    </div>

    <template v-else>
      <n-alert v-if="requestError" type="error" :bordered="false">
        {{ requestError }}
      </n-alert>

      <template v-else-if="result">
        <n-alert
          :type="success ? 'success' : 'error'"
          :bordered="false"
          style="margin-bottom: 16px"
        >
          <div class="fx-inline">
            <n-icon size="18">
              <checkmark-circle-outline v-if="success" />
              <close-circle-outline v-else />
            </n-icon>
            <strong>{{ success ? '测通成功，上游响应正常' : '测通失败' }}</strong>
          </div>
          <div v-if="!success && result.errorMessage" style="margin-top: 6px; font-size: 12px">
            {{ result.errorMessage }}
          </div>
        </n-alert>

        <div class="fx-result-metrics" style="margin-bottom: 14px">
          <div class="fx-result-metric">
            <div class="fx-result-metric__label">往返延迟</div>
            <div class="fx-result-metric__value">{{ formatLatency(result.latencyMs) }}</div>
          </div>
          <div class="fx-result-metric">
            <div class="fx-result-metric__label">输入 Tokens</div>
            <div class="fx-result-metric__value">{{ formatInteger(result.inputTokens) }}</div>
          </div>
          <div class="fx-result-metric">
            <div class="fx-result-metric__label">输出 Tokens</div>
            <div class="fx-result-metric__value">{{ formatInteger(result.outputTokens) }}</div>
          </div>
          <div class="fx-result-metric">
            <div class="fx-result-metric__label">估算费用</div>
            <div class="fx-result-metric__value fx-kpi__value--accent">
              {{ formatUsd(result.estimatedCostUsd) }}
            </div>
          </div>
        </div>

        <div v-if="result.errorCode" class="fx-stack" style="margin-bottom: 14px">
          <span class="fx-result-metric__label">错误分类</span>
          <code class="fx-mono" style="color: var(--fx-danger)">{{ result.errorCode }}</code>
        </div>

        <div v-if="result.replyPreview" class="fx-stack">
          <span class="fx-result-metric__label">回复预览</span>
          <div class="fx-reply-preview">{{ result.replyPreview }}</div>
        </div>

        <p class="fx-form-hint" style="margin-top: 14px">
          本次调用已写入用量日志（scene = connectivity-test）
          <template v-if="result.usageLogId">，日志 ID：<code class="fx-mono">{{ result.usageLogId }}</code></template>
          ，可在「用量与状态」页核对 Token 与费用。
        </p>
      </template>

      <div v-else class="fx-empty">暂无测试结果</div>
    </template>

    <template #footer>
      <div class="fx-modal-footer">
        <n-button type="primary" @click="emit('update:show', false)">关闭</n-button>
      </div>
    </template>
  </n-modal>
</template>
