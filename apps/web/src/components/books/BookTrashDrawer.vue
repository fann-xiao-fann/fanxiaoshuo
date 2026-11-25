<script setup lang="ts">
import type { BookDto } from '@fanxiaoshuo/shared';
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
import { RefreshOutline, TrashOutline, WarningOutline } from '@vicons/ionicons5';
import { computed, ref, watch } from 'vue';
import { describeError } from '@/api/errors';
import { useBooksStore } from '@/stores/books';
import { formatDateTime, formatInteger, formatWordCount } from '@/utils/format';

const props = defineProps<{ show: boolean }>();

const emit = defineEmits<{
  'update:show': [boolean];
}>();

const booksStore = useBooksStore();
const message = useMessage();
const pendingId = ref<string | null>(null);

const books = computed<BookDto[]>(() => booksStore.trashBooks);

watch(
  () => props.show,
  (show) => {
    if (show) {
      void booksStore.loadTrash().catch((error: unknown) => {
        message.error(describeError(error));
      });
    }
  },
);

async function restore(book: BookDto): Promise<void> {
  pendingId.value = book.id;
  try {
    await booksStore.restoreBook(book.id);
    message.success(`《${book.title}》已恢复到书架`);
  } catch (error) {
    message.error(describeError(error));
  } finally {
    pendingId.value = null;
  }
}

async function purge(book: BookDto): Promise<void> {
  pendingId.value = book.id;
  try {
    await booksStore.purgeBook(book.id);
    message.success(`《${book.title}》已彻底删除`);
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
    :width="440"
    placement="right"
    @update:show="emit('update:show', $event)"
  >
    <n-drawer-content title="书架回收站" closable>
      <template #header>
        <div class="fx-inline">
          <n-icon size="16"><warning-outline /></n-icon>
          <span>书架回收站</span>
          <n-tag size="small" round :bordered="false">{{ books.length }}</n-tag>
        </div>
      </template>

      <n-spin :show="booksStore.trashLoading">
        <n-empty
          v-if="books.length === 0"
          description="回收站是空的，移入回收站的书籍会保留全部卷章与正文"
          style="padding: 48px 0"
        />

        <div v-else class="fx-trash-list">
          <div v-for="book in books" :key="book.id" class="fx-trash-item">
            <div class="fx-stack" style="min-width: 0">
              <div style="font-weight: 650; overflow-wrap: anywhere">{{ book.title }}</div>
              <div class="fx-tertiary" style="font-size: 11.5px">
                {{ book.authorPenName || '未署名' }} · 删除于 {{ formatDateTime(book.deletedAt) }}
              </div>
              <div class="fx-tertiary" style="font-size: 11.5px">
                {{ formatInteger(book.volumeCount) }} 卷 · {{ formatInteger(book.chapterCount) }} 章 ·
                {{ formatWordCount(book.totalWordCount) }}
              </div>
            </div>
            <div class="fx-inline" style="gap: 6px; flex-shrink: 0">
              <n-button
                size="tiny"
                secondary
                :loading="pendingId === book.id"
                @click="restore(book)"
              >
                <template #icon>
                  <n-icon><refresh-outline /></n-icon>
                </template>
                恢复
              </n-button>
              <n-popconfirm @positive-click="purge(book)">
                <template #trigger>
                  <n-button size="tiny" quaternary type="error" :loading="pendingId === book.id">
                    <template #icon>
                      <n-icon><trash-outline /></n-icon>
                    </template>
                    彻底删除
                  </n-button>
                </template>
                彻底删除《{{ book.title }}》将连同全部卷、章与历史快照一并移除，且不可恢复。确认继续？
              </n-popconfirm>
            </div>
          </div>
        </div>
      </n-spin>
    </n-drawer-content>
  </n-drawer>
</template>
