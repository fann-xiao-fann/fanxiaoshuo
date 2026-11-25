<script setup lang="ts">
import { NButton, NIcon, NSpin, useDialog, useMessage } from 'naive-ui';
import { AddOutline, ChevronForwardOutline, DocumentTextOutline } from '@vicons/ionicons5';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { describeError } from '@/api/errors';
import ChapterConflictModal from '@/components/workspace/ChapterConflictModal.vue';
import ChapterRevisionsDrawer from '@/components/workspace/ChapterRevisionsDrawer.vue';
import ChapterTipTapEditor from '@/components/workspace/ChapterTipTapEditor.vue';
import BookTrashDrawer from '@/components/workspace/BookTrashDrawer.vue';
import TextPromptModal from '@/components/workspace/TextPromptModal.vue';
import WorkspaceTreePanel from '@/components/workspace/WorkspaceTreePanel.vue';
import { useBookWorkspaceStore } from '@/stores/book-workspace';
import { formatInteger, formatWordCount } from '@/utils/format';

const route = useRoute();
const router = useRouter();
const workspace = useBookWorkspaceStore();
const dialog = useDialog();
const message = useMessage();

const treeCollapsed = ref(false);
const trashVisible = ref(false);
const revisionsVisible = ref(false);
const conflictLoading = ref(false);
const firstChapterVisible = ref(false);
const firstChapterLoading = ref(false);

const bookId = computed(() => {
  const value = route.params.bookId;
  return typeof value === 'string' ? value : '';
});

const routeChapterId = computed(() => {
  const value = route.params.chapterId;
  return typeof value === 'string' && value.length > 0 ? value : null;
});

const chapter = computed(() => workspace.currentChapter);
const hasChapters = computed(() => workspace.flatChapters.length > 0);
const conflictVisible = computed(() => workspace.saveStatus === 'conflict');

function syncUrl(chapterId: string): void {
  const target = `/books/${bookId.value}/${chapterId}`;
  if (route.path !== target) {
    void router.replace(target);
  }
}

function promptDiscard(targetId: string): void {
  dialog.warning({
    title: '存在未保存的改动',
    content:
      '当前章节的本地草稿未能成功保存（可能命中版本冲突或网络异常）。直接切换章节将丢弃这份草稿，确认继续？',
    positiveText: '放弃并切换',
    negativeText: '留在此页',
    onPositiveClick: () => {
      void workspace.openChapter(targetId, { flush: false }).then(
        (ok) => {
          if (ok) {
            syncUrl(targetId);
          }
        },
        (error: unknown) => message.error(describeError(error)),
      );
    },
  });
}

async function selectChapter(targetId: string): Promise<void> {
  if (targetId === workspace.currentChapterId) {
    syncUrl(targetId);
    return;
  }
  try {
    const ok = await workspace.openChapter(targetId);
    if (!ok) {
      promptDiscard(targetId);
      return;
    }
    syncUrl(targetId);
  } catch (error) {
    message.error(describeError(error));
  }
}

async function bootstrap(): Promise<void> {
  if (bookId.value.length === 0) {
    return;
  }
  workspace.reset();
  try {
    await workspace.loadTree(bookId.value);
  } catch (error) {
    message.error(describeError(error));
    return;
  }

  const preferred = routeChapterId.value ?? workspace.flatChapters[0]?.id ?? null;
  if (preferred !== null) {
    await selectChapter(preferred);
  }
}

async function createFirstChapter(title: string): Promise<void> {
  firstChapterLoading.value = true;
  try {
    const created = await workspace.createChapter({ volumeId: null, title });
    if (created !== null) {
      firstChapterVisible.value = false;
      await selectChapter(created.id);
    }
  } catch (error) {
    message.error(describeError(error));
  } finally {
    firstChapterLoading.value = false;
  }
}

/** 冲突弹窗：重新加载服务端最新正文（放弃本地过期草稿）。 */
async function handleConflictReload(): Promise<void> {
  conflictLoading.value = true;
  try {
    await workspace.reloadCurrentChapter();
    message.success('已加载服务端最新版本');
  } catch (error) {
    message.error(describeError(error));
  } finally {
    conflictLoading.value = false;
  }
}

/** 冲突弹窗：先由服务端留底快照，再用本地内容强制覆盖。 */
async function handleConflictOverwrite(): Promise<void> {
  conflictLoading.value = true;
  try {
    const ok = await workspace.forceOverwrite();
    if (ok) {
      message.success('已强制覆盖，服务端已自动备份原稿');
    } else if (workspace.saveStatus !== 'conflict') {
      message.error(workspace.saveError ?? '强制覆盖失败，请稍后重试');
    }
  } finally {
    conflictLoading.value = false;
  }
}

function handleConflictCancel(): void {
  workspace.cancelConflict();
}

/** 关闭 / 刷新页面前的最后一道防丢稿：尽力异步保存并提示浏览器。 */
function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!workspace.hasUnsavedChanges) {
    return;
  }
  void workspace.saveContent();
  event.preventDefault();
  event.returnValue = '';
}

watch(routeChapterId, (chapterId) => {
  if (chapterId === null || chapterId === workspace.currentChapterId) {
    return;
  }
  void selectChapter(chapterId);
});

watch(
  () => workspace.bookId,
  (current, previous) => {
    if (current !== null && previous !== null && current !== previous) {
      void bootstrap();
    }
  },
);

onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload);
  void bootstrap();
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload);
  workspace.cancelAutoSave();
});

onBeforeRouteLeave(async () => {
  workspace.cancelAutoSave();
  if (workspace.immersive) {
    workspace.exitImmersive();
  }
  if (!workspace.hasUnsavedChanges) {
    return true;
  }
  const saved = await workspace.flushPendingSave();
  if (saved) {
    return true;
  }
  if (workspace.saveStatus === 'conflict') {
    message.warning('请先在冲突弹窗中处理未保存的正文，再离开当前章节');
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    dialog.warning({
      title: '正文尚未保存',
      content: '当前章节的改动未能保存成功。离开将丢失这些改动，确认离开？',
      positiveText: '放弃并离开',
      negativeText: '留在本页',
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
      onMaskClick: () => resolve(false),
    });
  });
});
</script>

<template>
  <div class="fx-workspace">
    <template v-if="!workspace.immersive">
      <aside
        v-if="treeCollapsed"
        class="fx-workspace__aside fx-workspace__aside--collapsed"
        style="align-items: center; padding-top: 14px"
      >
        <n-button circle size="tiny" aria-label="展开目录" @click="treeCollapsed = false">
          <template #icon>
            <n-icon size="13"><chevron-forward-outline /></n-icon>
          </template>
        </n-button>
      </aside>
      <workspace-tree-panel
        v-else
        @select-chapter="selectChapter"
        @open-trash="trashVisible = true"
        @toggle-collapse="treeCollapsed = true"
      />
    </template>

    <div class="fx-workspace__main">
      <n-spin v-if="workspace.chapterLoading && chapter === null" :show="true" style="flex: 1">
        <div style="height: 100%" />
      </n-spin>

      <chapter-tip-tap-editor
        v-else-if="chapter !== null"
        @open-revisions="revisionsVisible = true"
      />

      <div v-else class="fx-workspace__empty">
        <div class="fx-workspace__empty-card">
          <n-icon size="34" color="var(--fx-accent)"><document-text-outline /></n-icon>
          <div v-if="!hasChapters">
            <div style="font-size: 17px; font-weight: 680; margin-bottom: 6px">
              《{{ workspace.book?.title ?? '本书' }}》还没有章节
            </div>
            <div class="fx-muted" style="font-size: 13px; line-height: 1.75">
              先创建第一章开始写作，之后可在左侧目录树中继续新建分卷与章节。
              <br />
              全书当前共 {{ formatInteger(workspace.totalChapterCount) }} 章 ·
              {{ formatWordCount(workspace.totalWordCount) }}。
            </div>
          </div>
          <div v-else>
            <div style="font-size: 17px; font-weight: 680; margin-bottom: 6px">
              从左侧目录选择要编辑的章节
            </div>
            <div class="fx-muted" style="font-size: 13px; line-height: 1.75">
              也可以直接在左侧新建章节，编辑器会立即打开新稿。
            </div>
          </div>
          <n-button type="primary" :loading="firstChapterLoading" @click="firstChapterVisible = true">
            <template #icon>
              <n-icon><add-outline /></n-icon>
            </template>
            新建第一章
          </n-button>
        </div>
      </div>
    </div>

    <chapter-revisions-drawer v-model:show="revisionsVisible" />
    <book-trash-drawer v-model:show="trashVisible" />
    <chapter-conflict-modal
      :show="conflictVisible"
      :current-version="workspace.conflictCurrentVersion"
      :local-word-count="workspace.draftWordCount"
      :loading="conflictLoading"
      @reload="handleConflictReload"
      @overwrite="handleConflictOverwrite"
      @cancel="handleConflictCancel"
    />
    <text-prompt-modal
      v-model:show="firstChapterVisible"
      title="新建第一章"
      label="章节标题"
      placeholder="例如：第一章 风起灯河"
      confirm-text="创建并开始写作"
      :loading="firstChapterLoading"
      @confirm="createFirstChapter"
    />
  </div>
</template>
