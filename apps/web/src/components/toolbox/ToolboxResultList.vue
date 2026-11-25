<script setup lang="ts">
import {
  KNOWLEDGE_CARD_CATEGORY_LABELS,
  TOOLBOX_RUN_STATUS_LABELS,
  type ToolboxResultItem,
  type ToolboxRunDetail,
  type ToolboxToolDefinitionDto,
} from '@fanxiaoshuo/shared';
import { NAlert, NButton, NIcon, NTag, useMessage } from 'naive-ui';
import {
  BookOutline,
  CopyOutline,
  ExtensionPuzzleOutline,
  SaveOutline,
  SparklesOutline,
} from '@vicons/ionicons5';
import { computed } from 'vue';
import { formatDateTime, formatInteger, formatLatency, formatUsd, truncateMiddle } from '@/utils/format';

/**
 * 创作工具盒结果区：展示本次运行的模型引用、Token / 费用 / 耗时徽标，
 * 整体思路总览 `overview` 与每条结构化结果卡片（含一键复制与回写入口）。
 */

const props = defineProps<{
  run: ToolboxRunDetail | null;
  running: boolean;
  tool: ToolboxToolDefinitionDto | undefined;
  canApplyCard: boolean;
  canApplyOutline: boolean;
}>();

const emit = defineEmits<{
  'apply-card': [itemIndex: number];
  'apply-outline': [itemIndex: number];
}>();

const message = useMessage();

const items = computed<ToolboxResultItem[]>(() => props.run?.output?.items ?? []);
const overview = computed(() => props.run?.output?.overview ?? '');

const statusType = computed<'success' | 'error'>(() =>
  props.run?.status === 'completed' ? 'success' : 'error',
);

function copyText(item: ToolboxResultItem): string {
  const segments = [item.title];
  if (item.summary.trim().length > 0) {
    segments.push(item.summary.trim());
  }
  if (item.content.trim().length > 0) {
    segments.push(item.content.trim());
  }
  return segments.join('\n\n');
}

async function copyItem(item: ToolboxResultItem): Promise<void> {
  const text = copyText(item);
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
    } else if (typeof document !== 'undefined') {
      const holder = document.createElement('textarea');
      holder.value = text;
      document.body.appendChild(holder);
      holder.select();
      document.execCommand('copy');
      document.body.removeChild(holder);
    }
    message.success('已复制到剪贴板');
  } catch {
    message.warning('浏览器拒绝了剪贴板访问，请手动选择文本复制。');
  }
}
</script>

<template>
  <section class="fx-tb-result">
    <header class="fx-tb-result__head">
      <div class="fx-inline">
        <span class="fx-panel__icon">
          <n-icon size="15"><sparkles-outline /></n-icon>
        </span>
        <div>
          <div class="fx-tb-result__title">生成结果</div>
          <div class="fx-tb-result__subtitle">
            {{ tool?.name ?? '创作工具盒' }} · 结构化产出可直接复制或一键回写到作品设定集。
          </div>
        </div>
      </div>
    </header>

    <div v-if="run === null" class="fx-tb-empty">
      {{
        running
          ? '正在调用统一模型网关生成结构化结果，通常需要 2–8 秒…'
          : '还没有生成结果。填好上方表单后点击「开始生成」，或从历史记录中回看任意一次运行。'
      }}
    </div>

    <template v-else>
      <div class="fx-tb-metrics">
        <n-tag size="small" round :bordered="false" :type="statusType">
          {{ TOOLBOX_RUN_STATUS_LABELS[run.status] }}
        </n-tag>
        <span class="fx-tb-metric" :title="run.modelRef ?? '未记录模型'">
          <span class="fx-tb-metric__label">模型</span>
          {{ run.modelRef === null ? '—' : truncateMiddle(run.modelRef, 32) }}
        </span>
        <span class="fx-tb-metric">
          <span class="fx-tb-metric__label">Tokens</span>
          {{ formatInteger(run.inputTokens) }} → {{ formatInteger(run.outputTokens) }}
        </span>
        <span class="fx-tb-metric">
          <span class="fx-tb-metric__label">估算费用</span>
          {{ formatUsd(run.estimatedCostUsd) }}
        </span>
        <span class="fx-tb-metric">
          <span class="fx-tb-metric__label">耗时</span>
          {{ formatLatency(run.latencyMs) }}
        </span>
        <span class="fx-tb-metric">
          <span class="fx-tb-metric__label">生成于</span>
          {{ formatDateTime(run.createdAt) }}
        </span>
      </div>

      <n-alert
        v-if="run.status === 'failed'"
        type="error"
        :bordered="false"
        style="margin-bottom: 14px"
      >
        <div>
          本次运行失败{{ run.errorCode === null ? '' : `（${run.errorCode}）` }}：
          {{ run.errorMessage ?? '上游模型未返回可用结果。' }}
        </div>
      </n-alert>

      <n-alert v-else-if="overview.trim().length > 0" type="info" :bordered="false" style="margin-bottom: 14px">
        <div class="fx-tb-overview">
          <strong>整体思路</strong>
          <p>{{ overview }}</p>
        </div>
      </n-alert>

      <div v-if="items.length === 0 && run.status === 'completed'" class="fx-tb-empty">
        本次运行没有返回条目，可调整输入后重试。
      </div>

      <div v-else class="fx-tb-item-list">
        <article v-for="(item, index) in items" :key="`${run.id}-${index}`" class="fx-tb-item">
          <header class="fx-tb-item__head">
            <span class="fx-tb-item__index">{{ index + 1 }}</span>
            <div class="fx-tb-item__title-block">
              <div class="fx-tb-item__title">{{ item.title }}</div>
              <div class="fx-tb-item__meta">
                <n-tag size="tiny" round :bordered="false" type="info">
                  {{ KNOWLEDGE_CARD_CATEGORY_LABELS[item.suggestedCardCategory] }}
                </n-tag>
                <span v-if="item.aliases.length > 0" class="fx-tertiary">
                  别名：{{ item.aliases.join('、') }}
                </span>
                <span v-if="item.tags.length > 0" class="fx-tertiary">
                  #{{ item.tags.join(' #') }}
                </span>
              </div>
            </div>
          </header>

          <p v-if="item.summary.trim().length > 0" class="fx-tb-item__summary">
            {{ item.summary }}
          </p>

          <pre v-if="item.content.trim().length > 0" class="fx-tb-item__content">{{ item.content }}</pre>

          <footer class="fx-tb-item__actions">
            <n-button size="tiny" quaternary @click="copyItem(item)">
              <template #icon>
                <n-icon><copy-outline /></n-icon>
              </template>
              复制内容
            </n-button>
            <n-button
              v-if="canApplyCard"
              size="tiny"
              secondary
              type="primary"
              @click="emit('apply-card', index)"
            >
              <template #icon>
                <n-icon><save-outline /></n-icon>
              </template>
              存为设定卡
            </n-button>
            <n-button
              v-if="canApplyOutline"
              size="tiny"
              secondary
              @click="emit('apply-outline', index)"
            >
              <template #icon>
                <n-icon><book-outline /></n-icon>
              </template>
              写入全书大纲
            </n-button>
          </footer>
        </article>
      </div>

      <div v-if="items.length > 0" class="fx-tb-result__hint">
        <n-icon size="12"><extension-puzzle-outline /></n-icon>
        回写后可直接前往作品工作区的设定集 / 总大纲查看，并在后续 AI 写作中被自动召回。
      </div>
    </template>
  </section>
</template>
