<script setup lang="ts">
import { NButton, NIcon } from 'naive-ui';
import {
  ChevronBackOutline,
  ChevronForwardOutline,
  SparklesOutline,
} from '@vicons/ionicons5';
import { ref } from 'vue';
import type { WorkspaceEditorBridge } from './editor-bridge';
import AiWriterPanel from './AiWriterPanel.vue';
import BookBiblePanel from './BookBiblePanel.vue';
import ChapterMemoryPanel from './ChapterMemoryPanel.vue';

/**
 * 写作工作区右侧「创作助手」侧栏。
 *
 * 三个标签页共用同一本书 / 同一个章节的 Store 状态：
 * AI 写作负责流式生成与安全应用，设定集管理总大纲与设定卡，
 * 本章记忆维护细纲、摘要与 AI 提炼结果。
 */
const props = defineProps<{
  editorBridge?: WorkspaceEditorBridge | null;
}>();

type AssistantTabKey = 'ai' | 'bible' | 'memory';

const TABS: Array<{ key: AssistantTabKey; label: string; hint: string }> = [
  { key: 'ai', label: 'AI 写作', hint: '续写 / 扩写 / 改写 / 润色' },
  { key: 'bible', label: '设定集', hint: '总大纲与设定卡' },
  { key: 'memory', label: '本章记忆', hint: '细纲、摘要与 AI 提炼' },
];

const activeTab = ref<AssistantTabKey>('ai');
const collapsed = ref(false);

function selectTab(tab: AssistantTabKey): void {
  activeTab.value = tab;
}
</script>

<template>
  <aside v-if="collapsed" class="fx-assistant fx-assistant--collapsed">
    <n-button
      circle
      size="tiny"
      quaternary
      aria-label="展开创作助手"
      @click="collapsed = false"
    >
      <template #icon>
        <n-icon><chevron-back-outline /></n-icon>
      </template>
    </n-button>
    <button class="fx-assistant__rail" type="button" @click="collapsed = false">
      创作助手
    </button>
  </aside>

  <aside v-else class="fx-assistant">
    <header class="fx-assistant__head">
      <div class="fx-assistant__title">
        <span class="fx-assistant__mark">
          <n-icon size="14"><sparkles-outline /></n-icon>
        </span>
        <div class="fx-assistant__title-text">
          <strong>创作助手</strong>
          <span class="fx-tertiary">设定记忆 · 章内 AI</span>
        </div>
      </div>
      <n-button
        circle
        size="tiny"
        quaternary
        aria-label="收起创作助手"
        @click="collapsed = true"
      >
        <template #icon>
          <n-icon><chevron-forward-outline /></n-icon>
        </template>
      </n-button>
    </header>

    <div class="fx-assistant__tabs" role="tablist" aria-label="创作助手标签页">
      <button
        v-for="tab in TABS"
        :key="tab.key"
        type="button"
        role="tab"
        class="fx-assistant__tab"
        :class="{ 'fx-assistant__tab--active': activeTab === tab.key }"
        :aria-selected="activeTab === tab.key"
        :title="tab.hint"
        @click="selectTab(tab.key)"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="fx-assistant__body">
      <ai-writer-panel v-show="activeTab === 'ai'" :editor-bridge="props.editorBridge ?? null" />
      <book-bible-panel v-show="activeTab === 'bible'" />
      <chapter-memory-panel v-show="activeTab === 'memory'" />
    </div>
  </aside>
</template>
