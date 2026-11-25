<script setup lang="ts">
import type { ChapterTreeItem, VolumeTreeNode } from '@fanxiaoshuo/shared';
import { NButton, NModal, NTag } from 'naive-ui';
import { computed, ref, watch } from 'vue';
import { formatWordCount } from '@/utils/format';

const props = defineProps<{
  show: boolean;
  chapter: ChapterTreeItem | null;
  volumes: VolumeTreeNode[];
}>();

const emit = defineEmits<{
  'update:show': [boolean];
  select: [string | null];
}>();

const pendingId = ref<string | 'ungrouped' | null>(null);

watch(
  () => props.show,
  (show) => {
    if (show) {
      pendingId.value = null;
    }
  },
);

const targets = computed(() => {
  const items = props.volumes.map((volume) => ({
    id: volume.id as string | null,
    title: volume.title,
    caption: `${volume.chapters.length} 章 · ${formatWordCount(volume.totalWordCount)}`,
  }));
  items.push({
    id: null,
    title: '未分卷章节',
    caption: '独立于任何分卷的章节区',
  });
  return items;
});

const currentVolumeId = computed<string | null>(() => props.chapter?.volumeId ?? null);

function select(volumeId: string | null): void {
  pendingId.value = volumeId ?? 'ungrouped';
  emit('select', volumeId);
}

function close(): void {
  emit('update:show', false);
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="移动章节到其他分卷"
    style="width: 480px; max-width: 92vw"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <div class="fx-stack" style="gap: 10px">
      <div class="fx-muted" style="font-size: 12.5px">
        目标分卷：<strong>{{ chapter?.title ?? '—' }}</strong> 将被追加到目标分卷末尾。
      </div>
      <div class="fx-move-list">
        <button
          v-for="target in targets"
          :key="target.id ?? 'ungrouped'"
          type="button"
          class="fx-move-option"
          :class="{
            'fx-move-option--active':
              (target.id === currentVolumeId && currentVolumeId !== null) ||
              (target.id === null && currentVolumeId === null),
          }"
          :disabled="target.id === currentVolumeId || pendingId === (target.id ?? 'ungrouped')"
          @click="select(target.id)"
        >
          <span style="display: flex; flex-direction: column; gap: 2px; min-width: 0">
            <span style="font-weight: 600; overflow-wrap: anywhere">{{ target.title }}</span>
            <span class="fx-tertiary" style="font-size: 11.5px">{{ target.caption }}</span>
          </span>
          <n-tag
            v-if="target.id === currentVolumeId"
            size="small"
            round
            :bordered="false"
            type="warning"
          >
            当前
          </n-tag>
        </button>
      </div>
    </div>

    <template #footer>
      <div class="fx-modal-footer">
        <n-button @click="close">取消</n-button>
      </div>
    </template>
  </n-modal>
</template>
