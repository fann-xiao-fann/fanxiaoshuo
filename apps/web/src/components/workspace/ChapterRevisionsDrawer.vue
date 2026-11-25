<script setup lang="ts">
import {
  REVISION_SOURCE_LABELS,
  type ChapterRevisionSummary,
  type RevisionSource,
} from '@fanxiaoshuo/shared';
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NIcon,
  NPopconfirm,
  NSpin,
  NTag,
  useMessage,
} from 'naive-ui';
import { RefreshOutline, TimeOutline } from '@vicons/ionicons5';
import { computed, ref, watch } from 'vue';
import { describeError } from '@/api/errors';
import { useBookWorkspaceStore } from '@/stores/book-workspace';
import { formatDateTime, formatInteger, formatWordCount } from '@/utils/format';

const props = defineProps<{ show: boolean }>();

const emit = defineEmits<{
  'update:show': [boolean];
}>();

const workspace = useBookWorkspaceStore();
const message = useMessage();
const loading = ref(false);

const revisions = computed<ChapterRevisionSummary[]>(() => workspace.revisions);
const preview = computed(() => workspace.revisionPreview);

watch(
  () => props.show,
  (show) => {
    if (!show) {
      return;
    }
    void reload();
  },
);

async function reload(): Promise<void> {
  loading.value = true;
  try {
    await workspace.loadRevisions();
  } catch (error) {
    message.error(describeError(error));
  } finally {
    loading.value = false;
  }
}

function sourceTagType(source: RevisionSource): 'default' | 'info' | 'warning' | 'success' {
  switch (source) {
    case 'manual':
      return 'info';
    case 'restore':
      return 'warning';
    case 'ai':
      return 'success';
    default:
      return 'default';
  }
}

async function previewRevision(revision: ChapterRevisionSummary): Promise<void> {
  try {
    await workspace.previewRevision(revision.id);
  } catch (error) {
    message.error(describeError(error));
  }
}

async function restoreRevision(revision: ChapterRevisionSummary): Promise<void> {
  try {
    await workspace.restoreRevision(revision.id);
    message.success(`已回滚到 v${revision.version}，回滚前正文已自动留底`);
  } catch (error) {
    message.error(describeError(error));
  }
}
</script>

<template>
  <n-drawer
    :show="show"
    :width="460"
    placement="right"
    @update:show="emit('update:show', $event)"
  >
    <n-drawer-content title="历史版本快照" closable>
      <template #header>
        <div class="fx-inline">
          <n-icon size="16"><time-outline /></n-icon>
          <span>历史版本快照</span>
          <n-tag size="small" round :bordered="false">{{ revisions.length }}</n-tag>
        </div>
      </template>

      <div class="fx-stack" style="gap: 14px">
        <div class="fx-inline" style="justify-content: space-between">
          <span class="fx-tertiary" style="font-size: 11.5px">
            自动快照按 5 分钟节流生成；回滚前正文会自动留底
          </span>
          <n-button size="tiny" quaternary :loading="loading" @click="reload">
            <template #icon>
              <n-icon><refresh-outline /></n-icon>
            </template>
            刷新
          </n-button>
        </div>

        <n-spin :show="loading || workspace.revisionsLoading">
          <n-empty
            v-if="revisions.length === 0"
            description="还没有历史快照，点击编辑器「保存快照」可手动留底"
            style="padding: 40px 0"
          />

          <div v-else class="fx-revision-list">
            <div v-for="revision in revisions" :key="revision.id" class="fx-revision-item">
              <div class="fx-revision-item__head">
                <n-tag size="small" round :bordered="false" :type="sourceTagType(revision.source)">
                  {{ REVISION_SOURCE_LABELS[revision.source] }}
                </n-tag>
                <span class="fx-revision-item__meta">v{{ revision.version }}</span>
                <span class="fx-revision-item__meta">{{ formatWordCount(revision.wordCount) }}</span>
                <span class="fx-revision-item__meta" style="margin-left: auto">
                  {{ formatDateTime(revision.createdAt) }}
                </span>
              </div>
              <div class="fx-revision-item__title fx-truncate">
                {{ revision.titleSnapshot }}
              </div>
              <div v-if="revision.note.length > 0" class="fx-muted" style="font-size: 12px">
                备注：{{ revision.note }}
              </div>
              <div class="fx-inline" style="gap: 6px">
                <n-button size="tiny" secondary @click="previewRevision(revision)">
                  预览正文
                </n-button>
                <n-popconfirm @positive-click="restoreRevision(revision)">
                  <template #trigger>
                    <n-button
                      size="tiny"
                      quaternary
                      type="warning"
                      :loading="workspace.restoringRevisionId === revision.id"
                    >
                      回滚到此版本
                    </n-button>
                  </template>
                  回滚到 v{{ revision.version }}？当前正文会先自动备份为一条「回滚备份」快照，可再次恢复。
                </n-popconfirm>
              </div>
            </div>
          </div>
        </n-spin>

        <div v-if="preview !== null" class="fx-stack" style="gap: 8px">
          <div class="fx-inline" style="justify-content: space-between">
            <span style="font-size: 13px; font-weight: 640">
              预览 v{{ preview.version }} · {{ formatInteger(preview.wordCount) }} 字
            </span>
            <n-button size="tiny" quaternary @click="workspace.clearRevisionPreview()">关闭预览</n-button>
          </div>
          <div class="fx-revision-preview">{{ preview.contentText || '（该快照正文为空）' }}</div>
        </div>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>
