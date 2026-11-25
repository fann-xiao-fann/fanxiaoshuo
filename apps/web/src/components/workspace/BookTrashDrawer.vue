<script setup lang="ts">
import { NBadge, NButton, NDrawer, NDrawerContent, NEmpty, NIcon, NPopconfirm, NSpin, NTabs, NTabPane, NTag, useMessage } from 'naive-ui';
import { TrashOutline, LayersOutline, ListOutline, RefreshOutline, WarningOutline } from '@vicons/ionicons5';
import { computed, ref, watch } from 'vue';
import { describeError } from '@/api/errors';
import { useBookWorkspaceStore } from '@/stores/book-workspace';
import { formatDateTime, formatWordCount } from '@/utils/format';

const props = defineProps<{ show: boolean }>();

const emit = defineEmits<{
  'update:show': [boolean];
}>();

const workspace = useBookWorkspaceStore();
const message = useMessage();
const loading = ref(false);
const pendingId = ref<string | null>(null);

const volumes = computed(() => workspace.trash.volumes);
const chapters = computed(() => workspace.trash.chapters);
const total = computed(() => volumes.value.length + chapters.value.length);

watch(
  () => props.show,
  (show) => {
    if (show) {
      void reload();
    }
  },
);

async function reload(): Promise<void> {
  loading.value = true;
  try {
    await workspace.loadTrash();
  } catch (error) {
    message.error(describeError(error));
  } finally {
    loading.value = false;
  }
}

async function restoreVolume(volumeId: string): Promise<void> {
  pendingId.value = volumeId;
  try {
    await workspace.restoreVolume(volumeId);
    message.success('分卷已恢复');
  } catch (error) {
    message.error(describeError(error));
  } finally {
    pendingId.value = null;
  }
}

async function purgeVolume(volumeId: string): Promise<void> {
  pendingId.value = volumeId;
  try {
    await workspace.purgeVolume(volumeId);
    message.success('分卷已彻底删除');
  } catch (error) {
    message.error(describeError(error));
  } finally {
    pendingId.value = null;
  }
}

async function restoreChapter(chapterId: string): Promise<void> {
  pendingId.value = chapterId;
  try {
    await workspace.restoreChapter(chapterId);
    message.success('章节已恢复');
  } catch (error) {
    message.error(describeError(error));
  } finally {
    pendingId.value = null;
  }
}

async function purgeChapter(chapterId: string): Promise<void> {
  pendingId.value = chapterId;
  try {
    await workspace.purgeChapter(chapterId);
    message.success('章节已彻底删除');
  } catch (error) {
    message.error(describeError(error));
  } finally {
    pendingId.value = null;
  }
}
</script>

<template>
  <n-drawer
    :show="show"
    :width="480"
    placement="right"
    @update:show="emit('update:show', $event)"
  >
    <n-drawer-content title="本书回收站" closable>
      <template #header>
        <div class="fx-inline">
          <n-icon size="16"><warning-outline /></n-icon>
          <span>本书回收站</span>
          <n-badge :value="total" :show="total > 0" type="warning" />
        </div>
      </template>

      <n-spin :show="loading || workspace.trashLoading">
        <n-tabs type="segment" animated>
          <n-tab-pane name="volumes" :tab="`分卷（${volumes.length}）`">
            <n-empty
              v-if="volumes.length === 0"
              description="没有已删除的分卷"
              style="padding: 36px 0"
            />
            <div v-else class="fx-trash-list">
              <div v-for="volume in volumes" :key="volume.id" class="fx-trash-item">
                <div class="fx-stack" style="min-width: 0">
                  <div class="fx-inline" style="gap: 6px">
                    <n-icon size="14"><layers-outline /></n-icon>
                    <span style="font-weight: 640; overflow-wrap: anywhere">{{ volume.title }}</span>
                  </div>
                  <div class="fx-tertiary" style="font-size: 11.5px">
                    {{ volume.chapterCount }} 章 · {{ formatWordCount(volume.totalWordCount) }} · 删除于
                    {{ formatDateTime(volume.deletedAt) }}
                  </div>
                </div>
                <div class="fx-inline" style="gap: 6px; flex-shrink: 0">
                  <n-button
                    size="tiny"
                    secondary
                    :loading="pendingId === volume.id"
                    @click="restoreVolume(volume.id)"
                  >
                    <template #icon>
                      <n-icon><refresh-outline /></n-icon>
                    </template>
                    恢复
                  </n-button>
                  <n-popconfirm @positive-click="purgeVolume(volume.id)">
                    <template #trigger>
                      <n-button size="tiny" quaternary type="error" :loading="pendingId === volume.id">
                        <template #icon>
                          <n-icon><trash-outline /></n-icon>
                        </template>
                        彻底删除
                      </n-button>
                    </template>
                    彻底删除分卷《{{ volume.title }}》后，其下章节会归入「未分卷章节」，此操作不可恢复。确认继续？
                  </n-popconfirm>
                </div>
              </div>
            </div>
          </n-tab-pane>

          <n-tab-pane name="chapters" :tab="`章节（${chapters.length}）`">
            <n-empty
              v-if="chapters.length === 0"
              description="没有已删除的章节"
              style="padding: 36px 0"
            />
            <div v-else class="fx-trash-list">
              <div v-for="chapter in chapters" :key="chapter.id" class="fx-trash-item">
                <div class="fx-stack" style="min-width: 0">
                  <div class="fx-inline" style="gap: 6px">
                    <n-icon size="14"><list-outline /></n-icon>
                    <span style="font-weight: 640; overflow-wrap: anywhere">{{ chapter.title }}</span>
                  </div>
                  <div class="fx-tertiary" style="font-size: 11.5px">
                    v{{ chapter.version }} · {{ formatWordCount(chapter.wordCount) }} · 删除于
                    {{ formatDateTime(chapter.deletedAt) }}
                  </div>
                  <div v-if="chapter.volumeId === null" class="fx-tertiary" style="font-size: 11.5px">
                    原属未分卷区
                  </div>
                  <n-tag v-else size="tiny" :bordered="false" round>原属分卷</n-tag>
                </div>
                <div class="fx-inline" style="gap: 6px; flex-shrink: 0">
                  <n-button
                    size="tiny"
                    secondary
                    :loading="pendingId === chapter.id"
                    @click="restoreChapter(chapter.id)"
                  >
                    <template #icon>
                      <n-icon><refresh-outline /></n-icon>
                    </template>
                    恢复
                  </n-button>
                  <n-popconfirm @positive-click="purgeChapter(chapter.id)">
                    <template #trigger>
                      <n-button size="tiny" quaternary type="error" :loading="pendingId === chapter.id">
                        <template #icon>
                          <n-icon><trash-outline /></n-icon>
                        </template>
                        彻底删除
                      </n-button>
                    </template>
                    彻底删除章节《{{ chapter.title }}》将同时移除其全部历史快照，且不可恢复。确认继续？
                  </n-popconfirm>
                </div>
              </div>
            </div>
          </n-tab-pane>
        </n-tabs>
      </n-spin>
    </n-drawer-content>
  </n-drawer>
</template>
