<script setup lang="ts">
import {
  AGENT_ROLE_LABELS,
  TOOLBOX_CATEGORY_LABELS,
  uuidSchema,
  type BookDto,
} from '@fanxiaoshuo/shared';
import { NAlert, NButton, NIcon, NSpin, NTag, useMessage } from 'naive-ui';
import {
  ArrowForwardOutline,
  BookOutline,
  ColorWandOutline,
  CreateOutline,
  HardwareChipOutline,
  RefreshOutline,
  TimeOutline,
} from '@vicons/ionicons5';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { booksApi } from '@/api/books';
import { describeError } from '@/api/errors';
import ToolboxApplyModal from '@/components/toolbox/ToolboxApplyModal.vue';
import ToolboxForm from '@/components/toolbox/ToolboxForm.vue';
import ToolboxHistoryDrawer from '@/components/toolbox/ToolboxHistoryDrawer.vue';
import ToolboxResultList from '@/components/toolbox/ToolboxResultList.vue';
import { useToolboxStore } from '@/stores/toolbox';

/**
 * 创作工具盒工作台 `/toolbox`。
 *
 * 数据流：左侧按 3 大分类选择内置工具 → 中部关联作品 / 覆盖角色 + Schema 驱动表单 →
 * 下方结构化结果卡片 → 一键复制或回写 Book Bible 设定卡 / 全书总大纲。
 * 历史抽屉支持筛选、回看与删除；`/toolbox?bookId=<uuid>` 会自动预选关联作品。
 */

const route = useRoute();
const router = useRouter();
const message = useMessage();
const store = useToolboxStore();

const books = ref<BookDto[]>([]);
const booksLoading = ref(false);
const booksError = ref<string | null>(null);

const historyVisible = ref(false);
const applyVisible = ref(false);
const applyMode = ref<'card' | 'outline'>('card');
const applyIndex = ref(0);

const bookOptions = computed(() =>
  books.value.map((book) => ({ label: book.title, value: book.id })),
);

const applyItem = computed(() => {
  const items = store.activeRun?.output?.items ?? [];
  return items[applyIndex.value] ?? null;
});

const activeBookLabel = computed(() => {
  const bookId = store.selectedBookId;
  if (bookId === null) {
    return '未关联作品';
  }
  return books.value.find((book) => book.id === bookId)?.title ?? '已关联作品';
});

/** 当前结果关联的作品（展示「前往作品」快捷入口）。 */
const activeRunBookId = computed(() => store.activeRun?.bookId ?? null);

async function loadBooks(): Promise<void> {
  booksLoading.value = true;
  booksError.value = null;
  try {
    const response = await booksApi.list({ includeDeleted: 'exclude' });
    books.value = response.items;
  } catch (error) {
    booksError.value = describeError(error);
  } finally {
    booksLoading.value = false;
  }
}

async function execute(): Promise<void> {
  const run = await store.executeCurrentTool();
  if (run === null) {
    if (store.error !== null && store.errorCode !== 'VALIDATION_ERROR') {
      message.error('本次生成未成功，请查看上方提示。');
    }
    return;
  }
  message.success(`已生成 ${run.itemCount} 条结果`);
}

function openApply(mode: 'card' | 'outline', itemIndex: number): void {
  if (store.activeRun === null) {
    message.warning('请先生成或回看一次结果');
    return;
  }
  applyMode.value = mode;
  applyIndex.value = itemIndex;
  applyVisible.value = true;
}

function openHistory(): void {
  historyVisible.value = true;
}

function goToModels(): void {
  void router.push('/models');
}

function goToBook(bookId: string): void {
  void router.push(`/books/${bookId}`);
}

function syncBookFromRoute(): void {
  const value = route.query.bookId;
  if (typeof value === 'string' && uuidSchema.safeParse(value).success) {
    store.setBookContext(value);
  }
}

watch(
  () => route.query.bookId,
  () => {
    syncBookFromRoute();
  },
);

onMounted(async () => {
  syncBookFromRoute();
  await Promise.all([
    loadBooks(),
    store.loadTools(),
    store.loadHistory().catch(() => {
      /* 历史列表失败不影响工具目录与表单 */
    }),
  ]);
});
</script>

<template>
  <div class="fx-page fx-tb-page">
    <section class="fx-panel">
      <div class="fx-panel__head">
        <div class="fx-inline">
          <span class="fx-panel__icon">
            <n-icon size="16"><color-wand-outline /></n-icon>
          </span>
          <div>
            <div class="fx-panel__title">创作工具盒</div>
            <div class="fx-panel__subtitle">
              Schema 驱动的单点提效工具集：书名简介、人物卡、世界观势力、金手指、剧情钩子与片段质检。
              全部调用经统一模型网关，自动落盘 Token 与费用，产出可一键沉淀到作品设定集。
            </div>
          </div>
        </div>
        <div class="fx-panel__actions">
          <n-tag size="small" round :bordered="false" type="default" :title="activeBookLabel">
            上下文 · {{ activeBookLabel }}
          </n-tag>
          <n-button size="small" quaternary :loading="historyVisible && store.historyLoading" @click="openHistory">
            <template #icon>
              <n-icon><time-outline /></n-icon>
            </template>
            创作历史
            <span v-if="store.totalRuns > 0" class="fx-tb-count">{{ store.totalRuns }}</span>
          </n-button>
          <n-button size="small" quaternary :loading="store.toolsLoading" @click="store.loadTools()">
            <template #icon>
              <n-icon><refresh-outline /></n-icon>
            </template>
            刷新目录
          </n-button>
        </div>
      </div>

      <div class="fx-panel__body">
        <n-alert
          v-if="store.error !== null"
          :type="store.errorCode === 'VALIDATION_ERROR' ? 'warning' : 'error'"
          :bordered="false"
          closable
          style="margin-bottom: 14px"
          @close="store.clearError()"
        >
          <div class="fx-inline" style="justify-content: space-between; gap: 12px">
            <span>{{ store.error }}</span>
            <n-button v-if="store.needsModelSetup" size="tiny" type="primary" @click="goToModels">
              <template #icon>
                <n-icon><hardware-chip-outline /></n-icon>
              </template>
              去配置模型
            </n-button>
          </div>
        </n-alert>

        <n-alert v-if="booksError !== null" type="warning" :bordered="false" style="margin-bottom: 14px">
          书架加载失败：{{ booksError }}。仍可在不关联作品的情况下使用工具盒。
        </n-alert>

        <div class="fx-tb-layout">
          <!-- 左侧：3 大分类工具目录 -->
          <aside class="fx-tb-catalog">
            <div class="fx-tb-catalog__head">
              <span class="fx-tb-catalog__title">内置工具</span>
              <span class="fx-tertiary" style="font-size: 11px">
                共 {{ store.tools.length }} 个
              </span>
            </div>

            <n-spin :show="store.toolsLoading">
              <div v-for="group in store.toolGroups" :key="group.category" class="fx-tb-group">
                <div class="fx-tb-group__label">
                  <n-icon size="12"><book-outline /></n-icon>
                  {{ TOOLBOX_CATEGORY_LABELS[group.category] }}
                </div>
                <button
                  v-for="tool in group.tools"
                  :key="tool.id"
                  type="button"
                  class="fx-tb-tool"
                  :class="{ 'is-active': store.selectedToolId === tool.id }"
                  @click="store.selectTool(tool.id)"
                >
                  <div class="fx-tb-tool__name">{{ tool.name }}</div>
                  <div class="fx-tb-tool__summary">{{ tool.summary }}</div>
                  <div class="fx-tb-tool__meta">
                    <n-tag size="tiny" round :bordered="false" type="info">
                      {{ AGENT_ROLE_LABELS[tool.defaultRole] }}
                    </n-tag>
                    <span class="fx-tertiary">{{ tool.fields.length }} 项输入</span>
                  </div>
                </button>
              </div>
            </n-spin>

            <div v-if="store.toolsError !== null" class="fx-form-hint">
              工具目录加载失败，已回退到内置离线目录：{{ store.toolsError }}
            </div>
          </aside>

          <!-- 右侧：表单 + 结果 -->
          <main class="fx-tb-main">
            <toolbox-form
              :tool="store.selectedTool"
              :book-options="bookOptions"
              :books-loading="booksLoading"
              @execute="execute"
            />

            <n-spin :show="store.detailLoading">
              <toolbox-result-list
                :run="store.activeRun"
                :running="store.running"
                :tool="store.selectedTool"
                :can-apply-card="store.canApplyCard"
                :can-apply-outline="store.canApplyOutline"
                @apply-card="(index: number) => openApply('card', index)"
                @apply-outline="(index: number) => openApply('outline', index)"
              />
            </n-spin>

            <div class="fx-tb-tips">
              <n-icon size="13"><create-outline /></n-icon>
              <span>
                小贴士：关联作品后再生成人物卡与势力设定，产出会严格贴合已有总大纲与核心设定卡；
                回写后可直达作品工作区继续写作。
              </span>
              <n-button v-if="activeRunBookId !== null" text size="tiny" type="primary" @click="goToBook(activeRunBookId)">
                前往作品
                <template #icon>
                  <n-icon><arrow-forward-outline /></n-icon>
                </template>
              </n-button>
            </div>
          </main>
        </div>
      </div>
    </section>

    <toolbox-apply-modal
      v-model:show="applyVisible"
      :mode="applyMode"
      :item="applyItem"
      :item-index="applyIndex"
      :run-id="store.activeRun?.id ?? null"
      :default-book-id="store.activeRun?.bookId ?? store.selectedBookId"
      :book-options="bookOptions"
      @applied="goToBook"
    />

    <toolbox-history-drawer v-model:show="historyVisible" :book-options="bookOptions" />
  </div>
</template>
