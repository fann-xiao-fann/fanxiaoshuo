<script setup lang="ts">
import {
  CHAPTER_SUMMARY_SOURCE_LABELS,
  type ChapterSummarySource,
} from '@fanxiaoshuo/shared';
import {
  NAlert,
  NButton,
  NDynamicTags,
  NIcon,
  NInput,
  NSpin,
  NTag,
  useMessage,
} from 'naive-ui';
import { FlashOutline, SaveOutline, SettingsOutline } from '@vicons/ionicons5';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { describeError } from '@/api/errors';
import { useBookBibleStore } from '@/stores/book-bible';
import { useBookWorkspaceStore } from '@/stores/book-workspace';
import { formatDateTime, formatInteger, formatUsd } from '@/utils/format';

const bibles = useBookBibleStore();
const workspace = useBookWorkspaceStore();
const message = useMessage();
const router = useRouter();

const outline = ref('');
const summary = ref('');
const keyEvents = ref<string[]>([]);
const charactersPresent = ref<string[]>([]);

const HAS_MODEL_ISSUE = ['AGENT_ROLE_UNBOUND', 'PROVIDER_DISABLED', 'MODEL_DISABLED'] as const;

const chapterId = computed(() => workspace.currentChapterId);

const sourceLabel = computed<string>(() => {
  const current = bibles.chapterSummary;
  if (current === null || current.updatedAt === null) {
    return '未填写';
  }
  return CHAPTER_SUMMARY_SOURCE_LABELS[current.source as ChapterSummarySource];
});

const updatedLabel = computed(() => formatDateTime(bibles.chapterSummary?.updatedAt));

const modelIssueCode = computed<string | null>(() => {
  const code = bibles.summaryErrorCode;
  if (code === null) {
    return null;
  }
  return (HAS_MODEL_ISSUE as readonly string[]).includes(code) ? code : null;
});

const emptyContextIssue = computed(() => bibles.summaryErrorCode === 'AI_EMPTY_CONTEXT');

const usageLabel = computed(() => {
  const usage = bibles.lastExtractUsage;
  if (usage === null) {
    return null;
  }
  return `输入 ${formatInteger(usage.inputTokens)} / 输出 ${formatInteger(usage.outputTokens)} tokens · 约 ${formatUsd(usage.estimatedCostUsd)}`;
});

watch(
  () => bibles.chapterSummary,
  (current) => {
    outline.value = current?.outline ?? '';
    summary.value = current?.summary ?? '';
    keyEvents.value = current === null ? [] : [...current.keyEvents];
    charactersPresent.value = current === null ? [] : [...current.charactersPresent];
  },
  { immediate: true },
);

async function saveMemory(): Promise<void> {
  const id = chapterId.value;
  if (id === null) {
    message.warning('请先在左侧打开一个章节');
    return;
  }
  try {
    await bibles.saveChapterSummary(id, {
      outline: outline.value,
      summary: summary.value,
      keyEvents: keyEvents.value,
      charactersPresent: charactersPresent.value,
    });
    message.success('本章记忆已保存');
  } catch (error) {
    message.error(describeError(error));
  }
}

async function extractSummary(): Promise<void> {
  const id = chapterId.value;
  if (id === null) {
    message.warning('请先在左侧打开一个章节');
    return;
  }
  const usage = await bibles.extractChapterSummary(id, { save: true });
  if (usage !== null) {
    message.success('已由设定档案员提炼并保存本章摘要');
  } else if (bibles.summaryError !== null && !emptyContextIssue.value && modelIssueCode.value === null) {
    message.error(bibles.summaryError);
  }
}

function goModels(): void {
  void router.push('/models');
}
</script>

<template>
  <section class="fx-assistant__section">
    <div class="fx-assistant__section-head">
      <div class="fx-assistant__section-title">本章记忆</div>
      <div class="fx-assistant__inline-badges">
        <n-tag size="tiny" :bordered="false" type="info">{{ sourceLabel }}</n-tag>
        <n-tag size="tiny" :bordered="false">更新：{{ updatedLabel }}</n-tag>
      </div>
    </div>

    <div v-if="chapterId === null" class="fx-assistant__empty">
      请先在左侧目录打开一个章节，再维护本章细纲与剧情摘要。
    </div>

    <template v-else>
      <div class="fx-assistant__hint">
        本章记忆会作为「前情摘要」被后续章节的 AI 写作召回，建议在每章写完顺手补齐关键事件与出场人物。
      </div>

      <n-spin :show="bibles.summaryLoading">
        <label class="fx-assistant__field">
          <span class="fx-assistant__label">本章细纲</span>
          <n-input
            v-model:value="outline"
            type="textarea"
            size="small"
            :autosize="{ minRows: 3, maxRows: 8 }"
            :maxlength="10000"
            placeholder="本章目标、冲突推进与收尾钩子。"
          />
        </label>
        <label class="fx-assistant__field">
          <span class="fx-assistant__label">剧情摘要</span>
          <n-input
            v-model:value="summary"
            type="textarea"
            size="small"
            :autosize="{ minRows: 3, maxRows: 8 }"
            :maxlength="10000"
            placeholder="已经发生的剧情事实，供后续章节召回。"
          />
        </label>
        <div class="fx-assistant__field">
          <span class="fx-assistant__label">关键事件</span>
          <n-dynamic-tags v-model:value="keyEvents" size="small" :max="30" />
        </div>
        <div class="fx-assistant__field">
          <span class="fx-assistant__label">出场人物</span>
          <n-dynamic-tags v-model:value="charactersPresent" size="small" :max="50" />
        </div>
      </n-spin>

      <div class="fx-assistant__actions">
        <n-button
          type="primary"
          size="small"
          secondary
          :loading="bibles.summarySaving"
          @click="saveMemory"
        >
          <template #icon>
            <n-icon><save-outline /></n-icon>
          </template>
          保存本章记忆
        </n-button>
        <n-button
          size="small"
          type="primary"
          :loading="bibles.summaryExtracting"
          @click="extractSummary"
        >
          <template #icon>
            <n-icon><flash-outline /></n-icon>
          </template>
          AI 提炼摘要
        </n-button>
      </div>

      <div v-if="usageLabel !== null" class="fx-assistant__hint">
        上次提炼用量：{{ usageLabel }}
      </div>

      <n-alert v-if="modelIssueCode !== null" type="warning" :bordered="false">
        <div class="fx-assistant__alert-row">
          <span>
            设定档案员（lorekeeper）{{
              modelIssueCode === 'AGENT_ROLE_UNBOUND' ? '尚未绑定模型' : '绑定的模型或供应商已停用'
            }}，无法提炼摘要。
          </span>
          <n-button size="tiny" type="primary" secondary @click="goModels">
            <template #icon>
              <n-icon><settings-outline /></n-icon>
            </template>
            前往模型配置
          </n-button>
        </div>
      </n-alert>
      <n-alert v-else-if="emptyContextIssue" type="info" :bordered="false">
        当前章节正文为空，无法提炼摘要。先写一些正文，再回来一键提炼。
      </n-alert>
      <n-alert
        v-else-if="bibles.summaryErrorCode !== null"
        type="error"
        :bordered="false"
      >
        {{ bibles.summaryError ?? '本章记忆操作失败，请稍后重试' }}
      </n-alert>
    </template>
  </section>
</template>
