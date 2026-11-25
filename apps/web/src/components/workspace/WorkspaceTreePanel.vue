<script setup lang="ts">
import {
  CHAPTER_STATUSES,
  CHAPTER_STATUS_LABELS,
  EXPORT_FORMAT_META,
  type ChapterStatus,
  type ChapterTreeItem,
  type ExportFormat,
  type VolumeTreeNode,
} from '@fanxiaoshuo/shared';
import {
  NBadge,
  NButton,
  NDropdown,
  NIcon,
  NSpin,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui';
import {
  AddOutline,
  ArrowBackOutline,
  ChevronDownOutline,
  ChevronForwardOutline,
  CloudDownloadOutline,
  EllipsisHorizontalOutline,
  LayersOutline,
  ListOutline,
  WarningOutline,
} from '@vicons/ionicons5';
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { downloadBookExport } from '@/api/books';
import { describeError } from '@/api/errors';
import { useBookWorkspaceStore } from '@/stores/book-workspace';
import { formatInteger, formatWordCount } from '@/utils/format';
import MoveChapterModal from './MoveChapterModal.vue';
import TextPromptModal from './TextPromptModal.vue';

const emit = defineEmits<{
  'select-chapter': [string];
  'open-trash': [];
  'toggle-collapse': [];
}>();

const router = useRouter();
const workspace = useBookWorkspaceStore();
const message = useMessage();
const dialog = useDialog();

type PromptMode = 'create-volume' | 'create-chapter' | 'rename-volume' | 'rename-chapter';

interface PromptState {
  show: boolean;
  mode: PromptMode;
  targetId: string | null;
  volumeId: string | null;
  title: string;
  label: string;
  initial: string;
  placeholder: string;
  confirmText: string;
}

const prompt = reactive<PromptState>({
  show: false,
  mode: 'create-volume',
  targetId: null,
  volumeId: null,
  title: '',
  label: '',
  initial: '',
  placeholder: '',
  confirmText: '确定',
});

const promptLoading = ref(false);
const promptSuggestion = computed(() => buildTitleSuggestion(prompt.mode));
const collapsedVolumes = ref<Set<string>>(new Set());
const moveVisible = ref(false);
const movingChapter = ref<ChapterTreeItem | null>(null);

const book = computed(() => workspace.book);
const volumes = computed<VolumeTreeNode[]>(() => workspace.volumes);
const ungrouped = computed<ChapterTreeItem[]>(() => workspace.ungroupedChapters);
const currentChapterId = computed(() => workspace.currentChapterId);

const exportOptions = (Object.keys(EXPORT_FORMAT_META) as ExportFormat[]).map((format) => ({
  label: `导出 ${EXPORT_FORMAT_META[format].label}（.${EXPORT_FORMAT_META[format].extension}）`,
  key: format,
}));

const volumeMenuOptions = [
  { label: '新建章节', key: 'add-chapter' },
  { label: '重命名分卷', key: 'rename' },
  { label: '上移分卷', key: 'up' },
  { label: '下移分卷', key: 'down' },
  { type: 'divider' as const, key: 'divider' },
  { label: '移入回收站', key: 'delete' },
];

const chapterMenuOptions = computed(() => [
  { label: '重命名章节', key: 'rename' },
  {
    label: '切换状态',
    key: 'status',
    children: CHAPTER_STATUSES.map((status) => ({
      label: CHAPTER_STATUS_LABELS[status],
      key: `status:${status}`,
    })),
  },
  { label: '上移', key: 'up' },
  { label: '下移', key: 'down' },
  { label: '移动到其他分卷', key: 'move' },
  { type: 'divider' as const, key: 'divider-chapter' },
  { label: '移入回收站', key: 'delete' },
]);

function buildTitleSuggestion(mode: PromptMode): string {
  if (mode === 'create-volume') {
    return `第 ${workspace.volumes.length + 1} 卷`;
  }
  if (mode === 'create-chapter') {
    const count = workspace.totalChapterCount + 1;
    const target = prompt.volumeId === null ? '未分卷区' : '当前分卷';
    return `${target} · 第 ${count} 章`;
  }
  return '';
}

function statusColor(status: ChapterStatus): string {
  switch (status) {
    case 'outline':
      return 'var(--fx-text-tertiary)';
    case 'draft':
      return 'var(--fx-warning)';
    case 'reviewing':
      return 'var(--fx-info)';
    default:
      return 'var(--fx-success)';
  }
}

function isCollapsed(volumeId: string): boolean {
  return collapsedVolumes.value.has(volumeId);
}

function toggleVolume(volumeId: string): void {
  const next = new Set(collapsedVolumes.value);
  if (next.has(volumeId)) {
    next.delete(volumeId);
  } else {
    next.add(volumeId);
  }
  collapsedVolumes.value = next;
}

function openPrompt(mode: PromptMode, options: { targetId?: string | null; volumeId?: string | null; initial?: string } = {}): void {
  prompt.mode = mode;
  prompt.targetId = options.targetId ?? null;
  prompt.volumeId = options.volumeId ?? null;
  prompt.initial = options.initial ?? '';
  prompt.show = true;
  switch (mode) {
    case 'create-volume':
      prompt.title = '新建分卷';
      prompt.label = '分卷标题';
      prompt.placeholder = '例如：第一卷 灯下山河';
      prompt.confirmText = '创建分卷';
      break;
    case 'create-chapter':
      prompt.title = options.volumeId === null ? '在未分卷区新建章节' : '在分卷下新建章节';
      prompt.label = '章节标题';
      prompt.placeholder = '例如：第三章 夜行船';
      prompt.confirmText = '创建章节';
      break;
    case 'rename-volume':
      prompt.title = '重命名分卷';
      prompt.label = '分卷标题';
      prompt.placeholder = '分卷标题';
      prompt.confirmText = '保存';
      break;
    default:
      prompt.title = '重命名章节';
      prompt.label = '章节标题';
      prompt.placeholder = '章节标题';
      prompt.confirmText = '保存';
      break;
  }
}

async function handlePromptConfirm(value: string): Promise<void> {
  promptLoading.value = true;
  try {
    switch (prompt.mode) {
      case 'create-volume': {
        await workspace.createVolume({ title: value });
        message.success('分卷已创建');
        break;
      }
      case 'create-chapter': {
        const created = await workspace.createChapter({
          volumeId: prompt.volumeId,
          title: value,
        });
        if (created !== null) {
          message.success('章节已创建');
          emit('select-chapter', created.id);
        }
        break;
      }
      case 'rename-volume': {
        if (prompt.targetId !== null) {
          await workspace.updateVolume(prompt.targetId, { title: value });
          message.success('分卷已重命名');
        }
        break;
      }
      default: {
        if (prompt.targetId !== null) {
          await workspace.updateChapterMeta(prompt.targetId, { title: value });
          message.success('章节已重命名');
        }
        break;
      }
    }
    prompt.show = false;
  } catch (error) {
    message.error(describeError(error));
  } finally {
    promptLoading.value = false;
  }
}

function confirmDeleteVolume(volume: VolumeTreeNode): void {
  dialog.warning({
    title: '移入回收站',
    content: `分卷《${volume.title}》及其目录结构将从正文树隐藏，可在本书回收站恢复。确认继续？`,
    positiveText: '移入回收站',
    negativeText: '取消',
    onPositiveClick: () => {
      void workspace.deleteVolume(volume.id).then(
        () => message.success('分卷已移入回收站'),
        (error: unknown) => message.error(describeError(error)),
      );
    },
  });
}

function confirmDeleteChapter(chapter: ChapterTreeItem): void {
  dialog.warning({
    title: '移入回收站',
    content: `章节《${chapter.title}》将从目录树隐藏，正文与历史快照可在本书回收站恢复。确认继续？`,
    positiveText: '移入回收站',
    negativeText: '取消',
    onPositiveClick: () => {
      void workspace.deleteChapter(chapter.id).then(
        () => message.success('章节已移入回收站'),
        (error: unknown) => message.error(describeError(error)),
      );
    },
  });
}

async function handleVolumeAction(volume: VolumeTreeNode, key: string): Promise<void> {
  switch (key) {
    case 'add-chapter':
      openPrompt('create-chapter', { volumeId: volume.id });
      break;
    case 'rename':
      openPrompt('rename-volume', { targetId: volume.id, initial: volume.title });
      break;
    case 'up':
    case 'down':
      await workspace.moveVolume(volume.id, key);
      break;
    case 'delete':
      confirmDeleteVolume(volume);
      break;
    default:
      break;
  }
}

async function handleChapterAction(chapter: ChapterTreeItem, key: string): Promise<void> {
  if (key.startsWith('status:')) {
    const status = key.slice('status:'.length) as ChapterStatus;
    try {
      await workspace.updateChapterStatus(chapter.id, status);
      message.success(`状态已切换为「${CHAPTER_STATUS_LABELS[status]}」`);
    } catch (error) {
      message.error(describeError(error));
    }
    return;
  }
  switch (key) {
    case 'rename':
      openPrompt('rename-chapter', { targetId: chapter.id, initial: chapter.title });
      break;
    case 'up':
    case 'down':
      try {
        await workspace.moveChapter(chapter.id, key);
      } catch (error) {
        message.error(describeError(error));
      }
      break;
    case 'move':
      movingChapter.value = chapter;
      moveVisible.value = true;
      break;
    case 'delete':
      confirmDeleteChapter(chapter);
      break;
    default:
      break;
  }
}

async function handleMoveSelect(volumeId: string | null): Promise<void> {
  const chapter = movingChapter.value;
  if (chapter === null) {
    return;
  }
  try {
    await workspace.moveChapterToVolume(chapter.id, { volumeId });
    message.success('章节已移动');
    moveVisible.value = false;
  } catch (error) {
    message.error(describeError(error));
  }
}

async function handleExport(key: string): Promise<void> {
  const bookId = workspace.bookId;
  if (bookId === null || (key !== 'txt' && key !== 'md')) {
    return;
  }
  try {
    await downloadBookExport(bookId, key);
    message.success(`《${book.value?.title ?? '本书'}》已开始下载`);
  } catch (error) {
    message.error(describeError(error));
  }
}

async function flushAndCreateVolume(): Promise<void> {
  openPrompt('create-volume');
}

async function flushAndCreateChapter(): Promise<void> {
  openPrompt('create-chapter', { volumeId: workspace.currentChapter?.volumeId ?? null });
}
</script>

<template>
  <div class="fx-workspace__panel">
    <div class="fx-tree-head">
      <div class="fx-inline" style="justify-content: space-between">
        <button type="button" class="fx-tree-head__back" @click="router.push('/books')">
          <n-icon size="13"><arrow-back-outline /></n-icon>
          返回书架
        </button>
        <n-button size="tiny" quaternary circle aria-label="折叠目录" @click="emit('toggle-collapse')">
          <template #icon>
            <n-icon size="14"><chevron-back-outline /></n-icon>
          </template>
        </n-button>
      </div>

      <div class="fx-tree-head__title">{{ book?.title ?? '加载中…' }}</div>
      <div class="fx-tree-head__stats">
        <span>分卷<strong>{{ formatInteger(volumes.length) }}</strong></span>
        <span>章节<strong>{{ formatInteger(workspace.totalChapterCount) }}</strong></span>
        <span>总字数<strong>{{ formatWordCount(workspace.totalWordCount) }}</strong></span>
      </div>

      <div class="fx-tree-head__actions">
        <n-button size="tiny" secondary @click="flushAndCreateVolume">
          <template #icon>
            <n-icon><layers-outline /></n-icon>
          </template>
          新建分卷
        </n-button>
        <n-button size="tiny" secondary @click="flushAndCreateChapter">
          <template #icon>
            <n-icon><add-outline /></n-icon>
          </template>
          新建章节
        </n-button>
        <n-dropdown trigger="click" :options="exportOptions" @select="handleExport">
          <n-button size="tiny" quaternary>
            <template #icon>
              <n-icon><cloud-download-outline /></n-icon>
            </template>
            导出
          </n-button>
        </n-dropdown>
        <n-badge :value="workspace.trashCount" :show="workspace.trashCount > 0" type="warning">
          <n-button size="tiny" quaternary @click="emit('open-trash')">
            <template #icon>
              <n-icon><warning-outline /></n-icon>
            </template>
            回收站
          </n-button>
        </n-badge>
      </div>
    </div>

    <div class="fx-tree-body">
      <n-spin :show="workspace.treeLoading">
        <div v-if="volumes.length === 0 && ungrouped.length === 0" class="fx-empty">
          还没有分卷或章节，先新建第一卷或第一章开始写作。
        </div>

        <div v-for="volume in volumes" :key="volume.id" class="fx-tree-volume">
          <div class="fx-tree-volume__head">
            <button type="button" class="fx-tree-volume__toggle" @click="toggleVolume(volume.id)">
              <n-icon size="13">
                <chevron-forward-outline v-if="isCollapsed(volume.id)" />
                <chevron-down-outline v-else />
              </n-icon>
              <span class="fx-tree-volume__title">{{ volume.title }}</span>
              <span class="fx-tree-volume__count">
                {{ volume.chapters.length }} 章 · {{ formatWordCount(volume.totalWordCount) }}
              </span>
            </button>
            <n-dropdown
              trigger="click"
              :options="volumeMenuOptions"
              @select="(key: string) => handleVolumeAction(volume, key)"
            >
              <n-button size="tiny" quaternary circle aria-label="分卷操作">
                <template #icon>
                  <n-icon size="14"><ellipsis-horizontal-outline /></n-icon>
                </template>
              </n-button>
            </n-dropdown>
          </div>

          <div v-if="!isCollapsed(volume.id)" class="fx-tree-chapters">
            <div v-if="volume.chapters.length === 0" class="fx-empty" style="padding: 12px 8px">
              本卷还没有章节
            </div>
            <div
              v-for="chapter in volume.chapters"
              :key="chapter.id"
              role="button"
              tabindex="0"
              class="fx-tree-chapter"
              :class="{ 'fx-tree-chapter--active': chapter.id === currentChapterId }"
              @click="emit('select-chapter', chapter.id)"
              @keydown.enter.prevent="emit('select-chapter', chapter.id)"
              @keydown.space.prevent="emit('select-chapter', chapter.id)"
            >
              <span class="fx-tree-chapter__main">
                <span
                  class="fx-status-dot"
                  :style="{ background: statusColor(chapter.status) }"
                  :title="CHAPTER_STATUS_LABELS[chapter.status]"
                />
                <span class="fx-tree-chapter__title">{{ chapter.title }}</span>
              </span>
              <span class="fx-tree-chapter__words">{{ formatWordCount(chapter.wordCount) }}</span>
              <span class="fx-tree-chapter__more" @click.stop>
                <n-dropdown
                  trigger="click"
                  :options="chapterMenuOptions"
                  @select="(key: string) => handleChapterAction(chapter, key)"
                >
                  <n-button size="tiny" quaternary circle aria-label="章节操作">
                    <template #icon>
                      <n-icon size="13"><ellipsis-horizontal-outline /></n-icon>
                    </template>
                  </n-button>
                </n-dropdown>
              </span>
            </div>
          </div>
        </div>

        <div v-if="ungrouped.length > 0" class="fx-tree-ungrouped">
          <div class="fx-tree-ungrouped__caption">未分卷章节</div>
          <div class="fx-tree-chapters" style="padding: 0">
            <div
              v-for="chapter in ungrouped"
              :key="chapter.id"
              role="button"
              tabindex="0"
              class="fx-tree-chapter"
              :class="{ 'fx-tree-chapter--active': chapter.id === currentChapterId }"
              @click="emit('select-chapter', chapter.id)"
              @keydown.enter.prevent="emit('select-chapter', chapter.id)"
              @keydown.space.prevent="emit('select-chapter', chapter.id)"
            >
              <span class="fx-tree-chapter__main">
                <span
                  class="fx-status-dot"
                  :style="{ background: statusColor(chapter.status) }"
                  :title="CHAPTER_STATUS_LABELS[chapter.status]"
                />
                <span class="fx-tree-chapter__title">{{ chapter.title }}</span>
              </span>
              <span class="fx-tree-chapter__words">{{ formatWordCount(chapter.wordCount) }}</span>
              <span class="fx-tree-chapter__more" @click.stop>
                <n-dropdown
                  trigger="click"
                  :options="chapterMenuOptions"
                  @select="(key: string) => handleChapterAction(chapter, key)"
                >
                  <n-button size="tiny" quaternary circle aria-label="章节操作">
                    <template #icon>
                      <n-icon size="13"><ellipsis-horizontal-outline /></n-icon>
                    </template>
                  </n-button>
                </n-dropdown>
              </span>
            </div>
          </div>
        </div>

        <div v-if="ungrouped.length === 0 && volumes.length > 0" class="fx-empty" style="padding: 16px 8px">
          <n-tag size="small" :bordered="false" round>
            <template #icon>
              <n-icon><list-outline /></n-icon>
            </template>
            暂无未分卷章节
          </n-tag>
        </div>
      </n-spin>
    </div>

    <text-prompt-modal
      v-model:show="prompt.show"
      :title="prompt.title"
      :label="prompt.label"
      :placeholder="prompt.placeholder || promptSuggestion"
      :initial-value="prompt.initial"
      :confirm-text="prompt.confirmText"
      :loading="promptLoading"
      @confirm="handlePromptConfirm"
    />

    <move-chapter-modal
      v-model:show="moveVisible"
      :chapter="movingChapter"
      :volumes="volumes"
      @select="handleMoveSelect"
    />
  </div>
</template>
