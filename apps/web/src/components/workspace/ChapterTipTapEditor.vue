<script setup lang="ts">
import {
  CHAPTER_STATUSES,
  CHAPTER_STATUS_LABELS,
  type ChapterStatus,
  type TiptapJson,
} from '@fanxiaoshuo/shared';
import Placeholder from '@tiptap/extension-placeholder';
import StarterKit from '@tiptap/starter-kit';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/vue-3';
import {
  NButton,
  NIcon,
  NInput,
  NSelect,
  NSpin,
  useMessage,
} from 'naive-ui';
import {
  BookmarkOutline,
  ContractOutline,
  EllipsisHorizontalOutline,
  ExpandOutline,
  SaveOutline,
  TimeOutline,
} from '@vicons/ionicons5';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { describeError } from '@/api/errors';
import { useBookWorkspaceStore } from '@/stores/book-workspace';
import {
  createEmptyDoc,
  resolveEditorContent,
  tiptapDocToPlainText,
} from '@/utils/editor-content';
import { formatInteger, formatProgressPercent } from '@/utils/format';
import { describeSaveStatus } from '@/utils/save-status';
import TextPromptModal from './TextPromptModal.vue';

const emit = defineEmits<{
  'open-revisions': [];
  'snapshot-saved': [];
}>();

const workspace = useBookWorkspaceStore();
const message = useMessage();
const snapshotVisible = ref(false);
const snapshotLoading = ref(false);

const editor = useEditor({
  content: (workspace.currentChapter === null
    ? createEmptyDoc()
    : resolveEditorContent(workspace.currentChapter)) as unknown as JSONContent,
  extensions: [
    StarterKit.configure({
      codeBlock: false,
      code: false,
      blockquote: false,
      heading: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      link: false,
      strike: false,
      underline: false,
    }),
    Placeholder.configure({
      placeholder: '在这里开始写正文……空行分段，Ctrl / Cmd + S 立即保存。',
    }),
  ],
  editorProps: {
    attributes: {
      class: 'fx-editor-prose',
      spellcheck: 'false',
      'aria-label': '章节正文编辑器',
    },
  },
  onUpdate: ({ editor: instance }) => {
    const json = instance.getJSON() as TiptapJson;
    workspace.setDraft({
      contentText: tiptapDocToPlainText(json),
      contentJson: json,
    });
  },
});

const chapter = computed(() => workspace.currentChapter);
const immersive = computed(() => workspace.immersive);
const wordCount = computed(() => workspace.draftWordCount);
const targetWords = computed(() => workspace.targetChapterWords);
const progress = computed(() => formatProgressPercent(wordCount.value, targetWords.value));

const titleModel = computed<string>({
  get: () => workspace.draftTitle,
  set: (value: string) => workspace.setDraft({ title: value }),
});

const statusModel = computed<ChapterStatus>({
  get: () => chapter.value?.status ?? 'draft',
  set: (value: ChapterStatus) => {
    const chapterId = workspace.currentChapterId;
    if (chapterId === null) {
      return;
    }
    void workspace.updateChapterStatus(chapterId, value).catch((error: unknown) => {
      message.error(describeError(error));
    });
  },
});

const statusOptions = CHAPTER_STATUSES.map((status) => ({
  label: CHAPTER_STATUS_LABELS[status],
  value: status,
}));

const saveBadge = computed(() => {
  const state = describeSaveStatus(workspace.saveStatus, workspace.lastSavedAt);
  return {
    label: state.label,
    className: state.tone === 'idle' ? '' : `fx-save-badge--${state.tone}`,
  };
});

/** 章节切换 / 回滚后同步编辑器内容（不触发 onUpdate，避免二次脏标记）。 */
watch(
  () => workspace.editorSyncToken,
  () => {
    const instance = editor.value;
    const current = workspace.currentChapter;
    if (instance === undefined || current === null) {
      return;
    }
    instance.commands.setContent(resolveEditorContent(current) as unknown as JSONContent, {
      emitUpdate: false,
    });
  },
);

async function manualSave(): Promise<void> {
  const ok = await workspace.saveContent();
  if (ok) {
    message.success('章节已保存');
  } else if (workspace.saveStatus !== 'conflict') {
    message.error(workspace.saveError ?? '保存失败，请稍后重试');
  }
}

function openSnapshotDialog(): void {
  snapshotVisible.value = true;
}

async function submitSnapshot(note: string): Promise<void> {
  snapshotLoading.value = true;
  try {
    // 先落盘当前草稿，确保快照与正文一致
    if (workspace.isDirty) {
      await workspace.saveContent();
    }
    await workspace.createRevision(note);
    message.success('已生成历史快照');
    snapshotVisible.value = false;
    emit('snapshot-saved');
  } catch (error) {
    message.error(describeError(error));
  } finally {
    snapshotLoading.value = false;
  }
}

function enterImmersive(): void {
  workspace.setImmersive(true);
}

function exitImmersive(): void {
  workspace.exitImmersive();
}

function toggleBold(): void {
  editor.value?.chain().focus().toggleBold().run();
}

function toggleItalic(): void {
  editor.value?.chain().focus().toggleItalic().run();
}

function undo(): void {
  editor.value?.chain().focus().undo().run();
}

function redo(): void {
  editor.value?.chain().focus().redo().run();
}

function insertDivider(): void {
  editor.value?.chain().focus().setHorizontalRule().run();
}

function handleKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void manualSave();
    return;
  }
  if (event.key === 'Escape' && workspace.immersive) {
    event.preventDefault();
    workspace.exitImmersive();
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <section :class="immersive ? 'fx-immersive' : 'fx-editor'">
    <n-spin :show="workspace.chapterLoading">
      <!-- 常规工具栏 -->
      <div v-if="!immersive" class="fx-editor__toolbar">
        <n-input
          v-model:value="titleModel"
          class="fx-editor__title-input"
          placeholder="章节标题"
          :maxlength="120"
          :bordered="false"
        />
        <n-select v-model:value="statusModel" :options="statusOptions" style="width: 108px" size="small" />
        <div class="fx-editor__meta">
          <div class="fx-editor__words">
            <strong>{{ formatInteger(wordCount) }}</strong>
            <span>/ {{ formatInteger(targetWords) }} 字 · {{ progress }}%</span>
          </div>
          <span class="fx-save-badge" :class="saveBadge.className">{{ saveBadge.label }}</span>
          <n-button size="tiny" secondary :loading="workspace.saveStatus === 'saving'" @click="manualSave">
            <template #icon>
              <n-icon><save-outline /></n-icon>
            </template>
            保存
          </n-button>
          <n-button size="tiny" quaternary @click="openSnapshotDialog">
            <template #icon>
              <n-icon><bookmark-outline /></n-icon>
            </template>
            保存快照
          </n-button>
          <n-button size="tiny" quaternary @click="emit('open-revisions')">
            <template #icon>
              <n-icon><time-outline /></n-icon>
            </template>
            历史版本
          </n-button>
          <n-button size="tiny" quaternary @click="enterImmersive">
            <template #icon>
              <n-icon><expand-outline /></n-icon>
            </template>
            沉浸模式
          </n-button>
        </div>
      </div>

      <!-- 沉浸模式悬浮状态条 -->
      <div v-else class="fx-immersive__bar">
        <span class="fx-muted fx-truncate" style="font-size: 13px; max-width: 260px">
          {{ workspace.draftTitle || '未命名章节' }}
        </span>
        <div class="fx-editor__words">
          <strong>{{ formatInteger(wordCount) }}</strong>
          <span>/ {{ formatInteger(targetWords) }} 字 · {{ progress }}%</span>
        </div>
        <span class="fx-save-badge" :class="saveBadge.className">{{ saveBadge.label }}</span>
        <span class="fx-immersive__spacer" />
        <n-button size="tiny" secondary :loading="workspace.saveStatus === 'saving'" @click="manualSave">
          <template #icon>
            <n-icon><save-outline /></n-icon>
          </template>
          保存
        </n-button>
        <n-button size="tiny" quaternary @click="openSnapshotDialog">
          <template #icon>
            <n-icon><bookmark-outline /></n-icon>
          </template>
          快照
        </n-button>
        <n-button size="tiny" quaternary @click="emit('open-revisions')">
          <template #icon>
            <n-icon><ellipsis-horizontal-outline /></n-icon>
          </template>
          历史
        </n-button>
        <n-button size="tiny" secondary @click="exitImmersive">
          <template #icon>
            <n-icon><contract-outline /></n-icon>
          </template>
          退出沉浸（Esc）
        </n-button>
      </div>

      <!-- 格式工具栏：仅保留网文正文需要的轻量能力 -->
      <div v-if="!immersive" class="fx-editor__formatbar">
        <n-button
          size="tiny"
          quaternary
          :type="editor?.isActive('bold') ? 'primary' : 'default'"
          @click="toggleBold"
        >
          <strong>B</strong>
        </n-button>
        <n-button
          size="tiny"
          quaternary
          :type="editor?.isActive('italic') ? 'primary' : 'default'"
          @click="toggleItalic"
        >
          <em>I</em>
        </n-button>
        <n-button size="tiny" quaternary @click="insertDivider">分隔线</n-button>
        <n-button size="tiny" quaternary :disabled="editor?.can().undo() === false" @click="undo">
          撤销
        </n-button>
        <n-button size="tiny" quaternary :disabled="editor?.can().redo() === false" @click="redo">
          重做
        </n-button>
        <span class="fx-tertiary" style="margin-left: auto; font-size: 11px">
          自动保存已开启 · Ctrl / Cmd + S 立即保存
        </span>
      </div>

      <div :class="immersive ? 'fx-immersive__canvas' : 'fx-editor__scroll'">
        <div :class="{ 'fx-editor__canvas': !immersive }">
          <div class="fx-prose">
            <editor-content :editor="editor" />
          </div>
        </div>
      </div>
    </n-spin>

    <text-prompt-modal
      v-model:show="snapshotVisible"
      title="保存历史快照"
      label="快照备注（可选）"
      placeholder="例如：冲突爆发前的版本"
      confirm-text="生成快照"
      :max-length="200"
      :loading="snapshotLoading"
      allow-empty
      @confirm="submitSnapshot"
    />
  </section>
</template>
