<script setup lang="ts">
import {
  AI_APPLY_MODE_LABELS,
  AI_WRITE_ACTIONS,
  AI_WRITE_ACTION_LABELS,
  CONTEXT_CARD_RECALL_REASON_LABELS,
  KNOWLEDGE_CARD_CATEGORY_LABELS,
  countNovelWords,
  type AiApplyMode,
  type AiChapterStreamRequestPayload,
  type AiContextPreviewRequestPayload,
  type TiptapJson,
} from '@fanxiaoshuo/shared';
import {
  NAlert,
  NButton,
  NCheckbox,
  NIcon,
  NInput,
  NInputNumber,
  NProgress,
  NSpin,
  NSwitch,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui';
import {
  CopyOutline,
  RefreshOutline,
  SettingsOutline,
  SparklesOutline,
  StopCircleOutline,
  WarningOutline,
} from '@vicons/ionicons5';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useBookBibleStore } from '@/stores/book-bible';
import { useBookWorkspaceStore } from '@/stores/book-workspace';
import { plainTextToTiptapDoc } from '@/utils/editor-content';
import { formatInteger, formatLatency, formatUsd } from '@/utils/format';
import type { WorkspaceEditorBridge } from './editor-bridge';

const props = defineProps<{
  editorBridge?: WorkspaceEditorBridge | null;
}>();

const router = useRouter();
const message = useMessage();
const dialog = useDialog();
const bibles = useBookBibleStore();
const workspace = useBookWorkspaceStore();

const instruction = ref('');
const targetWords = ref<number | null>(null);
const includeOutline = ref(true);
const includePrevTail = ref(true);

const ROLE_ISSUE_CODES = ['AGENT_ROLE_UNBOUND', 'PROVIDER_DISABLED', 'MODEL_DISABLED'] as const;

const selection = computed(() => bibles.selection);
const selectedWordCount = computed(() =>
  selection.value === null ? 0 : countNovelWords(selection.value.text),
);
const selectionPreview = computed(() => {
  const text = selection.value?.text.trim() ?? '';
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
});

const preview = computed(() => bibles.contextPreview);
const previewPercent = computed(() => {
  const current = preview.value;
  if (current === null || current.maxContextTokens <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((current.estimatedTokens / current.maxContextTokens) * 100));
});

const roleIssueCode = computed<string | null>(() => {
  const code = bibles.streamErrorCode;
  if (code === null) {
    return null;
  }
  return (ROLE_ISSUE_CODES as readonly string[]).includes(code) ? code : null;
});

const roleIssueText = computed(() => {
  switch (roleIssueCode.value) {
    case 'AGENT_ROLE_UNBOUND':
      return '执笔写手（writer）尚未绑定可用模型，无法发起 AI 写作。';
    case 'PROVIDER_DISABLED':
      return '执笔写手绑定的供应商已被停用，请先恢复启用或改绑其它模型。';
    case 'MODEL_DISABLED':
      return '执笔写手绑定的模型已被停用，请先启用模型或改绑其它模型。';
    default:
      return '';
  }
});

const streamStatusLabel = computed(() => {
  switch (bibles.streamStatus) {
    case 'streaming':
      return '生成中…';
    case 'done':
      return '生成完成';
    case 'aborted':
      return '已停止（保留已生成部分）';
    case 'error':
      return '生成失败';
    default:
      return '等待生成';
  }
});

const streamMeta = computed(() => {
  const start = bibles.streamStart;
  const done = bibles.streamDone;
  return {
    modelRef: done?.modelRef ?? start?.modelRef ?? '—',
    inputTokens: done?.inputTokens ?? null,
    outputTokens: done?.outputTokens ?? null,
    costUsd: done?.estimatedCostUsd ?? null,
    latencyMs: done?.latencyMs ?? null,
    truncated: start?.truncated === true,
  };
});

const hasResult = computed(
  () => bibles.streamStatus !== 'idle' || bibles.streamText.trim().length > 0,
);

function isRoleIssue(code: string | null): boolean {
  return code !== null && (ROLE_ISSUE_CODES as readonly string[]).includes(code);
}

function goModels(): void {
  void router.push('/models');
}

function buildOptions(): AiContextPreviewRequestPayload {
  const currentSelection = selection.value;
  const draft = workspace.draftContentText;
  return {
    action: bibles.streamAction,
    instruction: instruction.value.trim(),
    ...(currentSelection !== null ? { selectedText: currentSelection.text } : {}),
    ...(draft.trim().length > 0 ? { currentContentText: draft } : {}),
    ...(bibles.selectedCardIds.length > 0 ? { cardIds: [...bibles.selectedCardIds] } : {}),
    includeOutline: includeOutline.value,
    includePrevChapterTail: includePrevTail.value,
    ...(targetWords.value !== null ? { targetWords: targetWords.value } : {}),
  };
}

async function handlePreview(): Promise<void> {
  const chapterId = workspace.currentChapterId;
  if (chapterId === null) {
    message.warning('请先在左侧打开一个章节');
    return;
  }
  await bibles.previewContext(chapterId, buildOptions());
}

async function handleGenerate(): Promise<void> {
  const chapterId = workspace.currentChapterId;
  if (chapterId === null) {
    message.warning('请先在左侧打开一个章节');
    return;
  }
  const payload: AiChapterStreamRequestPayload = { ...buildOptions(), role: 'writer' };
  await bibles.startStream(chapterId, payload);
  if (
    bibles.streamStatus === 'error' &&
    bibles.streamErrorMessage !== null &&
    !isRoleIssue(bibles.streamErrorCode)
  ) {
    message.error(bibles.streamErrorMessage);
  }
}

function handleStop(): void {
  bibles.stopStream();
}

function clearResult(): void {
  bibles.clearStreamResult();
}

async function copyResult(): Promise<void> {
  const text = bibles.streamText;
  if (text.trim().length === 0) {
    return;
  }
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined) {
    message.warning('当前浏览器不支持剪贴板写入，请手动选择复制');
    return;
  }
  try {
    await clipboard.writeText(text);
    message.success('已复制生成内容');
  } catch {
    message.warning('剪贴板写入被拒绝，请手动选择复制');
  }
}

function toggleCard(cardId: string, checked: boolean): void {
  const selected = bibles.selectedCardIds.includes(cardId);
  if (checked !== selected) {
    bibles.toggleSelectedCard(cardId);
  }
}

function buildApplyContent(mode: AiApplyMode): { contentText: string; contentJson: TiptapJson } | null {
  const aiText = bibles.streamText.trim();
  if (aiText.length === 0) {
    message.warning('还没有可应用的生成内容');
    return null;
  }
  if (mode === 'replace_selection') {
    const replacement = props.editorBridge?.buildReplacedSelectionContent(aiText) ?? null;
    if (replacement === null) {
      message.warning('当前编辑器中没有可用选区，已取消替换');
      return null;
    }
    return replacement;
  }
  const base = workspace.draftContentText;
  const next = mode === 'append' ? (base.trim().length > 0 ? `${base}\n\n${aiText}` : aiText) : aiText;
  return { contentText: next, contentJson: plainTextToTiptapDoc(next) };
}

async function applyWithMode(mode: AiApplyMode): Promise<void> {
  const built = buildApplyContent(mode);
  if (built === null) {
    return;
  }
  const ok = await bibles.applyStreamResult({
    mode,
    contentText: built.contentText,
    contentJson: built.contentJson,
    note: `${AI_WRITE_ACTION_LABELS[bibles.streamAction]}·${AI_APPLY_MODE_LABELS[mode]}`,
  });
  if (ok) {
    message.success('已写入正文，服务端已自动留底一条 AI 历史快照');
    return;
  }
  if (workspace.saveStatus !== 'conflict') {
    message.error(bibles.applyError ?? '应用生成内容失败，请稍后重试');
  }
}

function requestApply(mode: AiApplyMode): void {
  if (mode === 'replace_all') {
    dialog.warning({
      title: '替换整章正文',
      content:
        '应用前服务端会自动留底一条 AI 历史快照，可随时在「历史版本」中一键回滚。确认用当前生成内容替换整章正文？',
      positiveText: '确认替换',
      negativeText: '取消',
      onPositiveClick: () => {
        void applyWithMode(mode);
      },
    });
    return;
  }
  void applyWithMode(mode);
}

onMounted(() => {
  const bookId = workspace.bookId;
  if (bookId !== null && bibles.cardsBookId !== bookId && !bibles.cardsLoading) {
    void bibles.loadCards(bookId);
  }
});

watch(
  () => workspace.bookId,
  (bookId) => {
    if (bookId !== null && bibles.cardsBookId !== bookId && !bibles.cardsLoading) {
      void bibles.loadCards(bookId);
    }
  },
);
</script>

<template>
  <section class="fx-assistant__section">
    <div class="fx-assistant__section-head">
      <div class="fx-assistant__section-title">
        <n-icon size="14" color="var(--fx-accent)"><sparkles-outline /></n-icon>
        章内 AI 写作
      </div>
      <span class="fx-assistant__status-dot" :class="`fx-assistant__status-dot--${bibles.streamStatus}`">
        {{ streamStatusLabel }}
      </span>
    </div>

    <div class="fx-action-grid">
      <button
        v-for="action in AI_WRITE_ACTIONS"
        :key="action"
        type="button"
        class="fx-action-chip"
        :class="{ 'fx-action-chip--active': bibles.streamAction === action }"
        @click="bibles.streamAction = action"
      >
        {{ AI_WRITE_ACTION_LABELS[action] }}
      </button>
    </div>

    <div v-if="selection !== null" class="fx-selection-hint">
      <div class="fx-selection-hint__head">
        <strong>已选中 {{ formatInteger(selectedWordCount) }} 字</strong>
        <n-button size="tiny" quaternary @click="bibles.clearSelection()">清除选区</n-button>
      </div>
      <p class="fx-selection-hint__text">{{ selectionPreview }}</p>
    </div>
    <div v-else class="fx-assistant__hint">
      <template v-if="bibles.streamAction === 'continue'">
        续写会基于当前章正文、细纲与设定卡继续往下写；也可以先在编辑器选中一段，让模型顺着该段语气接续。
      </template>
      <template v-else>
        扩写 / 改写 / 润色默认作用于编辑器选区；若未选中，则以当前章正文为对象。请在正文中选中目标段落后再生成，效果更可控。
      </template>
    </div>

    <label class="fx-assistant__field">
      <span class="fx-assistant__label">写作指令（可选）</span>
      <n-input
        v-model:value="instruction"
        type="textarea"
        size="small"
        :autosize="{ minRows: 2, maxRows: 5 }"
        :maxlength="4000"
        placeholder="例如：让主角在雨夜追上黑衣人，揭开玉佩的来历，不要出现现代词汇。"
      />
    </label>

    <div class="fx-assistant__field-row">
      <label class="fx-assistant__field">
        <span class="fx-assistant__label">目标字数</span>
        <n-input-number
          v-model:value="targetWords"
          size="small"
          :min="100"
          :max="10000"
          :step="100"
          clearable
          placeholder="由模型把握"
        />
      </label>
      <div class="fx-assistant__switches">
        <label class="fx-assistant__switch">
          <n-switch v-model:value="includeOutline" size="small" />
          <span>纳入总大纲</span>
        </label>
        <label class="fx-assistant__switch">
          <n-switch v-model:value="includePrevTail" size="small" />
          <span>衔接上一章结尾</span>
        </label>
      </div>
    </div>

    <div class="fx-assistant__field">
      <div class="fx-assistant__label-row">
        <span class="fx-assistant__label">手动勾选设定卡</span>
        <span class="fx-tertiary">{{ bibles.selectedCardIds.length }} 张已选</span>
      </div>
      <div v-if="bibles.cards.length === 0" class="fx-assistant__hint">
        还没有设定卡。可在「设定集」标签页新建人物、世界观或伏笔卡片。
      </div>
      <div v-else class="fx-card-picker">
        <label v-for="card in bibles.cards" :key="card.id" class="fx-card-picker__item">
          <n-checkbox
            :checked="bibles.selectedCardIds.includes(card.id)"
            @update:checked="(checked: boolean) => toggleCard(card.id, checked)"
          />
          <span class="fx-card-picker__title">{{ card.title }}</span>
          <span class="fx-card-picker__category">
            {{ KNOWLEDGE_CARD_CATEGORY_LABELS[card.category] }}
          </span>
        </label>
      </div>
    </div>

    <div class="fx-assistant__actions">
      <n-button
        size="small"
        secondary
        :loading="bibles.contextPreviewLoading"
        @click="handlePreview"
      >
        预览上下文
      </n-button>
      <n-button
        v-if="bibles.streamStatus !== 'streaming'"
        type="primary"
        size="small"
        @click="handleGenerate"
      >
        <template #icon>
          <n-icon><sparkles-outline /></n-icon>
        </template>
        {{ bibles.streamStatus === 'idle' ? '开始生成' : '重新生成' }}
      </n-button>
      <n-button v-else type="warning" size="small" @click="handleStop">
        <template #icon>
          <n-icon><stop-circle-outline /></n-icon>
        </template>
        停止生成
      </n-button>
      <n-button
        v-if="bibles.streamStatus === 'error' || bibles.streamStatus === 'aborted'"
        size="small"
        secondary
        @click="handleGenerate"
      >
        <template #icon>
          <n-icon><refresh-outline /></n-icon>
        </template>
        重试
      </n-button>
    </div>

    <n-alert v-if="roleIssueCode !== null" type="warning" :bordered="false" class="fx-assistant__alert">
      <div class="fx-assistant__alert-row">
        <span>{{ roleIssueText }}</span>
        <n-button size="tiny" type="primary" secondary @click="goModels">
          <template #icon>
            <n-icon><settings-outline /></n-icon>
          </template>
          前往模型配置
        </n-button>
      </div>
    </n-alert>
    <n-alert
      v-else-if="bibles.streamErrorCode !== null && bibles.streamStatus === 'error'"
      type="error"
      :bordered="false"
      class="fx-assistant__alert"
    >
      {{ bibles.streamErrorMessage ?? '生成失败，请稍后重试' }}
    </n-alert>

    <div v-if="bibles.contextPreviewError !== null" class="fx-assistant__hint fx-error-text">
      {{ bibles.contextPreviewError }}
    </div>

    <n-spin :show="bibles.contextPreviewLoading">
      <div v-if="preview !== null" class="fx-context-preview">
        <div class="fx-context-preview__head">
          <strong>Token 预算</strong>
          <span class="fx-mono">
            {{ formatInteger(preview.estimatedTokens) }} / {{ formatInteger(preview.maxContextTokens) }}
          </span>
        </div>
        <n-progress
          type="line"
          :percentage="previewPercent"
          :height="6"
          :show-indicator="false"
          :status="preview.truncated ? 'warning' : 'default'"
        />
        <div class="fx-context-preview__flags">
          <n-tag v-if="preview.truncated" size="tiny" type="warning" :bordered="false">
            <template #icon>
              <n-icon><warning-outline /></n-icon>
            </template>
            已按预算裁剪
          </n-tag>
          <n-tag v-else size="tiny" type="success" :bordered="false">全部纳入</n-tag>
          <n-tag size="tiny" :bordered="false">
            前情 {{ preview.recentSummariesCount }} 章
          </n-tag>
          <n-tag v-if="preview.prevChapterTitle !== null" size="tiny" :bordered="false">
            衔接：{{ preview.prevChapterTitle }}
          </n-tag>
        </div>

        <div v-if="preview.selectedCards.length > 0" class="fx-context-preview__cards">
          <n-tag
            v-for="card in preview.selectedCards"
            :key="card.id"
            size="tiny"
            :bordered="false"
            :type="card.reason === 'selected' ? 'primary' : card.reason === 'pinned' ? 'info' : 'default'"
          >
            {{ card.title }} · {{ CONTEXT_CARD_RECALL_REASON_LABELS[card.reason] }}
          </n-tag>
        </div>

        <details class="fx-assistant__details">
          <summary>Prompt 预览</summary>
          <div class="fx-assistant__prompt">
            <div class="fx-assistant__prompt-title">System</div>
            <pre>{{ preview.systemPromptPreview }}</pre>
            <div class="fx-assistant__prompt-title">User</div>
            <pre>{{ preview.userPromptPreview }}</pre>
          </div>
        </details>

        <details class="fx-assistant__details">
          <summary>上下文分段（{{ preview.sections.length }}）</summary>
          <div class="fx-assistant__sections">
            <div v-for="section in preview.sections" :key="section.key" class="fx-assistant__section-row">
              <span>{{ section.label }}</span>
              <span class="fx-mono">{{ formatInteger(section.estimatedTokens) }} tok</span>
            </div>
          </div>
        </details>
      </div>
    </n-spin>

    <div v-if="hasResult" class="fx-stream-preview">
      <div class="fx-stream-preview__head">
        <strong>生成预览</strong>
        <span class="fx-mono fx-tertiary">{{ streamMeta.modelRef }}</span>
      </div>

      <div class="fx-stream-preview__metrics">
        <div class="fx-result-metric">
          <div class="fx-result-metric__label">Tokens</div>
          <div class="fx-result-metric__value">
            <template v-if="bibles.streamDone !== null">
              {{ formatInteger((streamMeta.inputTokens ?? 0) + (streamMeta.outputTokens ?? 0)) }}
            </template>
            <template v-else>—</template>
          </div>
        </div>
        <div class="fx-result-metric">
          <div class="fx-result-metric__label">估算费用</div>
          <div class="fx-result-metric__value">{{ formatUsd(streamMeta.costUsd) }}</div>
        </div>
        <div class="fx-result-metric">
          <div class="fx-result-metric__label">耗时</div>
          <div class="fx-result-metric__value">{{ formatLatency(streamMeta.latencyMs) }}</div>
        </div>
      </div>

      <pre class="fx-stream-preview__text">{{ bibles.streamText || '（等待首个增量片段…）' }}</pre>

      <div class="fx-stream-preview__actions">
        <n-button size="tiny" secondary :disabled="bibles.streamText.length === 0" @click="copyResult">
          <template #icon>
            <n-icon><copy-outline /></n-icon>
          </template>
          复制
        </n-button>
        <n-button
          size="tiny"
          type="primary"
          :disabled="!bibles.hasStreamText || bibles.applying"
          :loading="bibles.applying"
          @click="requestApply('append')"
        >
          追加到文末
        </n-button>
        <n-button
          size="tiny"
          secondary
          :disabled="!bibles.hasStreamText || bibles.applying || selection === null"
          @click="requestApply('replace_selection')"
        >
          替换选中片段
        </n-button>
        <n-button
          size="tiny"
          secondary
          :disabled="!bibles.hasStreamText || bibles.applying"
          @click="requestApply('replace_all')"
        >
          替换全文
        </n-button>
        <n-button size="tiny" quaternary @click="clearResult">清空预览</n-button>
      </div>
      <div v-if="bibles.applyError !== null" class="fx-error-text">{{ bibles.applyError }}</div>
    </div>
  </section>
</template>
