<script setup lang="ts">
import {
  BOOK_STATUS_LABELS,
  EXPORT_FORMAT_META,
  type BookDto,
  type BookStatus,
  type ExportFormat,
} from '@fanxiaoshuo/shared';
import {
  NBadge,
  NButton,
  NDropdown,
  NEmpty,
  NIcon,
  NInput,
  NPopconfirm,
  NSelect,
  NSpin,
  NTag,
  useMessage,
} from 'naive-ui';
import {
  AddOutline,
  CloudDownloadOutline,
  CreateOutline,
  SearchOutline,
  TrashOutline,
  WarningOutline,
} from '@vicons/ionicons5';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import BookFormModal from '@/components/books/BookFormModal.vue';
import BookTrashDrawer from '@/components/books/BookTrashDrawer.vue';
import { describeError } from '@/api/errors';
import { BOOK_STATUS_FILTER_OPTIONS, useBooksStore } from '@/stores/books';
import { formatDateTime, formatInteger, formatWordCount } from '@/utils/format';

const router = useRouter();
const booksStore = useBooksStore();
const message = useMessage();

const formVisible = ref(false);
const editingBook = ref<BookDto | null>(null);
const trashVisible = ref(false);
const keywordInput = ref(booksStore.filters.keyword);
let keywordTimer: ReturnType<typeof setTimeout> | null = null;

const statusOptions = BOOK_STATUS_FILTER_OPTIONS.map((option) => ({
  label: option.label,
  value: option.value ?? 'all',
}));

const statusFilterValue = computed<string>({
  get: () => booksStore.filters.status ?? 'all',
  set: (value) => {
    booksStore.setStatusFilter(value === 'all' ? null : (value as BookStatus));
    void reload();
  },
});

const books = computed(() => booksStore.books);
const isEmpty = computed(() => !booksStore.loading && books.value.length === 0);

const summary = computed(() => {
  const chapters = books.value.reduce((sum, book) => sum + book.chapterCount, 0);
  const words = books.value.reduce((sum, book) => sum + book.totalWordCount, 0);
  return { books: books.value.length, chapters, words };
});

const exportOptions = (Object.keys(EXPORT_FORMAT_META) as ExportFormat[]).map((format) => ({
  label: `导出 ${EXPORT_FORMAT_META[format].label}（.${EXPORT_FORMAT_META[format].extension}）`,
  key: format,
}));

function statusTagType(status: BookStatus): 'default' | 'success' | 'info' | 'warning' {
  switch (status) {
    case 'ongoing':
      return 'success';
    case 'completed':
      return 'info';
    case 'archived':
      return 'warning';
    default:
      return 'default';
  }
}

async function reload(): Promise<void> {
  try {
    await booksStore.loadBooks();
  } catch (error) {
    message.error(describeError(error));
  }
}

function handleKeywordInput(value: string): void {
  keywordInput.value = value;
  if (keywordTimer !== null) {
    clearTimeout(keywordTimer);
  }
  keywordTimer = setTimeout(() => {
    booksStore.setKeyword(value);
    void reload();
  }, 260);
}

function resetFilters(): void {
  if (keywordTimer !== null) {
    clearTimeout(keywordTimer);
    keywordTimer = null;
  }
  keywordInput.value = '';
  booksStore.resetFilters();
  void reload();
}

function openCreate(): void {
  editingBook.value = null;
  formVisible.value = true;
}

function openEdit(book: BookDto): void {
  editingBook.value = book;
  formVisible.value = true;
}

function openWorkspace(book: BookDto): void {
  void router.push(`/books/${book.id}`);
}

async function handleExport(book: BookDto, key: string): Promise<void> {
  if (key !== 'txt' && key !== 'md') {
    return;
  }
  try {
    await booksStore.exportBook(book.id, key);
    message.success(`《${book.title}》已开始下载 ${EXPORT_FORMAT_META[key].label}`);
  } catch (error) {
    message.error(describeError(error));
  }
}

function handleSaved(book: BookDto): void {
  editingBook.value = book;
}

async function handleSoftDelete(book: BookDto): Promise<void> {
  try {
    await booksStore.softDeleteBook(book.id);
    message.success(`《${book.title}》已移入回收站`);
  } catch (error) {
    message.error(describeError(error));
  }
}

onMounted(() => {
  void reload();
});

onUnmounted(() => {
  if (keywordTimer !== null) {
    clearTimeout(keywordTimer);
    keywordTimer = null;
  }
});
</script>

<template>
  <div class="fx-page">
    <section class="fx-panel">
      <div class="fx-panel__head">
        <div>
          <div class="fx-panel__title">
            <span class="fx-panel__icon"><n-icon size="16"><create-outline /></n-icon></span>
            书架
          </div>
          <div class="fx-panel__subtitle">
            集中管理全部作品：进入写作工作区维护卷章目录与正文，或一键导出整本 TXT / Markdown。
          </div>
        </div>
        <div class="fx-books-summary">
          <span class="fx-books-summary__item">作品<strong>{{ formatInteger(summary.books) }}</strong></span>
          <span class="fx-books-summary__item">章节<strong>{{ formatInteger(summary.chapters) }}</strong></span>
          <span class="fx-books-summary__item">累计<strong>{{ formatWordCount(summary.words) }}</strong></span>
        </div>
      </div>

      <div class="fx-table-toolbar">
        <div class="fx-books-toolbar__filters">
          <n-input
            :value="keywordInput"
            placeholder="搜索书名 / 笔名 / 题材"
            clearable
            style="width: 240px"
            @update:value="handleKeywordInput"
          >
            <template #prefix>
              <n-icon size="15"><search-outline /></n-icon>
            </template>
          </n-input>
          <n-select
            v-model:value="statusFilterValue"
            :options="statusOptions"
            style="width: 132px"
          />
          <n-button quaternary size="small" @click="resetFilters">重置</n-button>
        </div>

        <div class="fx-inline">
          <n-badge :value="booksStore.trashCount" :show="booksStore.trashCount > 0" type="warning">
            <n-button secondary size="small" @click="trashVisible = true">
              <template #icon>
                <n-icon><warning-outline /></n-icon>
              </template>
              书架回收站
            </n-button>
          </n-badge>
          <n-button type="primary" size="small" @click="openCreate">
            <template #icon>
              <n-icon><add-outline /></n-icon>
            </template>
            新建书籍
          </n-button>
        </div>
      </div>

      <div class="fx-panel__body">
        <n-spin :show="booksStore.loading">
          <n-empty
            v-if="isEmpty"
            :description="
              booksStore.hasFilters ? '没有符合当前筛选条件的作品' : '书架还是空的，先创建第一部作品吧'
            "
            style="padding: 56px 0"
          >
            <template #extra>
              <n-button v-if="booksStore.hasFilters" secondary size="small" @click="resetFilters">
                清空筛选
              </n-button>
              <n-button v-else type="primary" size="small" @click="openCreate">
                新建书籍
              </n-button>
            </template>
          </n-empty>

          <div v-else class="fx-books-grid">
            <article
              v-for="book in books"
              :key="book.id"
              class="fx-book-card"
              role="button"
              tabindex="0"
              :aria-label="`打开《${book.title}》写作工作区`"
              @click="openWorkspace(book)"
              @keydown.enter.prevent="openWorkspace(book)"
              @keydown.space.prevent="openWorkspace(book)"
            >
              <div class="fx-book-card__head">
                <div style="min-width: 0">
                  <div class="fx-book-card__title">{{ book.title }}</div>
                  <div class="fx-book-card__meta">
                    <span>{{ book.authorPenName || '未署名' }}</span>
                    <span v-if="book.genre">· {{ book.genre }}</span>
                    <span>单章目标 {{ formatInteger(book.targetChapterWords) }} 字</span>
                  </div>
                </div>
                <n-tag size="small" round :bordered="false" :type="statusTagType(book.status)">
                  {{ BOOK_STATUS_LABELS[book.status] }}
                </n-tag>
              </div>

              <p class="fx-book-card__synopsis">
                {{ book.synopsis || '尚未填写简介，点击卡片进入工作区补充设定与卷章。' }}
              </p>

              <div class="fx-book-card__stats">
                <div>
                  <div class="fx-book-card__stat-label">分卷</div>
                  <div class="fx-book-card__stat-value">{{ formatInteger(book.volumeCount) }}</div>
                </div>
                <div>
                  <div class="fx-book-card__stat-label">章节</div>
                  <div class="fx-book-card__stat-value">{{ formatInteger(book.chapterCount) }}</div>
                </div>
                <div>
                  <div class="fx-book-card__stat-label">总字数</div>
                  <div class="fx-book-card__stat-value">{{ formatWordCount(book.totalWordCount) }}</div>
                </div>
              </div>

              <div class="fx-book-card__footer" @click.stop>
                <span class="fx-book-card__updated">更新于 {{ formatDateTime(book.updatedAt) }}</span>
                <div class="fx-book-card__actions">
                  <n-button size="tiny" quaternary @click="openEdit(book)">
                    <template #icon>
                      <n-icon><create-outline /></n-icon>
                    </template>
                    编辑
                  </n-button>
                  <n-dropdown
                    trigger="click"
                    :options="exportOptions"
                    @select="(key: string) => handleExport(book, key)"
                  >
                    <n-button size="tiny" quaternary>
                      <template #icon>
                        <n-icon><cloud-download-outline /></n-icon>
                      </template>
                      导出
                    </n-button>
                  </n-dropdown>
                  <n-popconfirm @positive-click="handleSoftDelete(book)">
                    <template #trigger>
                      <n-button size="tiny" quaternary type="error">
                        <template #icon>
                          <n-icon><trash-outline /></n-icon>
                        </template>
                        回收站
                      </n-button>
                    </template>
                    将《{{ book.title }}》移入回收站？书籍内容会完整保留，可随时恢复。
                  </n-popconfirm>
                </div>
              </div>
            </article>
          </div>
        </n-spin>
      </div>
    </section>

    <book-form-modal
      v-model:show="formVisible"
      :book="editingBook"
      @saved="handleSaved"
    />
    <book-trash-drawer v-model:show="trashVisible" />
  </div>
</template>
