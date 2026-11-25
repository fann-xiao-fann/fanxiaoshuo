<script setup lang="ts">
import {
  KNOWLEDGE_CARD_CATEGORIES,
  KNOWLEDGE_CARD_CATEGORY_LABELS,
  knowledgeCardCategorySchema,
  type CreateKnowledgeCardInputPayload,
  type KnowledgeCardCategory,
  type KnowledgeCardDto,
  type UpdateKnowledgeCardInputPayload,
  type UpsertBookOutlineInputPayload,
} from '@fanxiaoshuo/shared';
import {
  NButton,
  NIcon,
  NInput,
  NModal,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui';
import {
  AddOutline,
  ColorWandOutline,
  CreateOutline,
  SearchOutline,
  Star,
  StarOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { describeError } from '@/api/errors';
import { useBookBibleStore } from '@/stores/book-bible';
import { useBookWorkspaceStore } from '@/stores/book-workspace';
import { formatDateTime } from '@/utils/format';

const bibles = useBookBibleStore();
const workspace = useBookWorkspaceStore();
const router = useRouter();
const message = useMessage();
const dialog = useDialog();

/** 携当前作品直达创作工具盒（预选关联作品上下文）。 */
function goToToolbox(): void {
  const bookId = workspace.book?.id ?? workspace.bookId;
  void router.push(bookId === null ? '/toolbox' : `/toolbox?bookId=${bookId}`);
}

type BibleView = 'cards' | 'outline';
const view = ref<BibleView>('cards');

const CATEGORY_OPTIONS: Array<{ label: string; value: string }> = [
  { label: '全部分类', value: '' },
  ...KNOWLEDGE_CARD_CATEGORIES.map((category) => ({
    label: KNOWLEDGE_CARD_CATEGORY_LABELS[category],
    value: category as string,
  })),
];

/** NSelect 的值为 `string | number | null`，这里统一收敛回契约枚举。 */
const categoryFilterModel = computed<string>({
  get: () => bibles.categoryFilter ?? '',
  set: (value) => {
    const parsed = knowledgeCardCategorySchema.safeParse(value);
    bibles.categoryFilter = parsed.success ? parsed.data : null;
  },
});

/* -------------------------------------------------------------------------- */
/*                                 设定卡表单                                  */
/* -------------------------------------------------------------------------- */

interface CardFormState {
  category: KnowledgeCardCategory;
  title: string;
  summary: string;
  content: string;
  aliases: string;
  tags: string;
  pinned: boolean;
}

function emptyForm(): CardFormState {
  return {
    category: 'character',
    title: '',
    summary: '',
    content: '',
    aliases: '',
    tags: '',
    pinned: false,
  };
}

const modalVisible = ref(false);
const editingCard = ref<KnowledgeCardDto | null>(null);
const submitting = ref(false);
const formError = ref<string | null>(null);
const form = reactive<CardFormState>(emptyForm());

const formCategoryModel = computed<string | null>({
  get: () => form.category,
  set: (value) => {
    const parsed = knowledgeCardCategorySchema.safeParse(value);
    if (parsed.success) {
      form.category = parsed.data;
    }
  },
});

function splitTokens(value: string): string[] {
  return value
    .split(/[,，\n]/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .slice(0, 20);
}

function openCreate(): void {
  editingCard.value = null;
  Object.assign(form, emptyForm());
  formError.value = null;
  modalVisible.value = true;
}

function openEdit(card: KnowledgeCardDto): void {
  editingCard.value = card;
  Object.assign(form, {
    category: card.category,
    title: card.title,
    summary: card.summary,
    content: card.content,
    aliases: card.aliases.join('，'),
    tags: card.tags.join('，'),
    pinned: card.pinned,
  });
  formError.value = null;
  modalVisible.value = true;
}

function currentBookId(): string | null {
  return workspace.bookId;
}

async function submitForm(): Promise<void> {
  const bookId = currentBookId();
  if (bookId === null) {
    formError.value = '当前还没有打开的作品';
    return;
  }
  const title = form.title.trim();
  if (title.length === 0) {
    formError.value = '请填写设定卡名称';
    return;
  }

  const payload: CreateKnowledgeCardInputPayload = {
    category: form.category,
    title,
    summary: form.summary.trim(),
    content: form.content,
    aliases: splitTokens(form.aliases),
    tags: splitTokens(form.tags),
    pinned: form.pinned,
  };

  submitting.value = true;
  formError.value = null;
  try {
    if (editingCard.value === null) {
      await bibles.createCard(bookId, payload);
      message.success('设定卡已创建');
    } else {
      const updatePayload: UpdateKnowledgeCardInputPayload = payload;
      await bibles.updateCard(bookId, editingCard.value.id, updatePayload);
      message.success('设定卡已更新');
    }
    modalVisible.value = false;
  } catch (error) {
    formError.value = describeError(error);
  } finally {
    submitting.value = false;
  }
}

async function togglePinned(card: KnowledgeCardDto): Promise<void> {
  const bookId = currentBookId();
  if (bookId === null) {
    return;
  }
  try {
    await bibles.toggleCardPinned(bookId, card.id);
  } catch (error) {
    message.error(describeError(error));
  }
}

function confirmDelete(card: KnowledgeCardDto): void {
  const bookId = currentBookId();
  if (bookId === null) {
    return;
  }
  dialog.warning({
    title: '删除设定卡',
    content: `确认删除「${card.title}」？删除后该卡片不再参与上下文召回，此操作不可撤销。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      void bibles.deleteCard(bookId, card.id).then(
        () => message.success('设定卡已删除'),
        (error: unknown) => message.error(describeError(error)),
      );
    },
  });
}

/* -------------------------------------------------------------------------- */
/*                                 筛选与加载                                  */
/* -------------------------------------------------------------------------- */

let searchTimer: ReturnType<typeof setTimeout> | null = null;

function clearSearchTimer(): void {
  if (searchTimer !== null) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
}

async function reloadCards(): Promise<void> {
  const bookId = currentBookId();
  if (bookId === null) {
    return;
  }
  await bibles.loadCards(bookId);
}

watch(
  () => bibles.searchQuery,
  () => {
    clearSearchTimer();
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void reloadCards();
    }, 350);
  },
);

watch([() => bibles.categoryFilter, () => bibles.pinnedOnly], () => {
  void reloadCards();
});

onUnmounted(() => {
  clearSearchTimer();
});

/* -------------------------------------------------------------------------- */
/*                                  总大纲                                     */
/* -------------------------------------------------------------------------- */

const outlineDraft = reactive({
  mainPlot: '',
  worldSetting: '',
  styleGuide: '',
  endingPlan: '',
});

watch(
  () => bibles.outline,
  (outline) => {
    outlineDraft.mainPlot = outline?.mainPlot ?? '';
    outlineDraft.worldSetting = outline?.worldSetting ?? '';
    outlineDraft.styleGuide = outline?.styleGuide ?? '';
    outlineDraft.endingPlan = outline?.endingPlan ?? '';
  },
  { immediate: true },
);

const outlineUpdatedLabel = computed(() => {
  const updatedAt = bibles.outline?.updatedAt;
  return updatedAt === null || updatedAt === undefined ? '尚未保存' : formatDateTime(updatedAt);
});

async function saveOutlineDraft(): Promise<void> {
  const bookId = currentBookId();
  if (bookId === null) {
    message.warning('当前还没有打开的作品');
    return;
  }
  const payload: UpsertBookOutlineInputPayload = {
    mainPlot: outlineDraft.mainPlot,
    worldSetting: outlineDraft.worldSetting,
    styleGuide: outlineDraft.styleGuide,
    endingPlan: outlineDraft.endingPlan,
  };
  try {
    await bibles.saveOutline(bookId, payload);
    message.success('全书总大纲已保存');
  } catch (error) {
    message.error(describeError(error));
  }
}
</script>

<template>
  <section class="fx-assistant__section">
    <div class="fx-assistant__field-row" style="justify-content: space-between; align-items: center">
      <span class="fx-tertiary" style="font-size: 11px; letter-spacing: 0.06em">作品设定集</span>
      <n-button size="tiny" quaternary :title="'在创作工具盒中生成并回写设定'" @click="goToToolbox">
        <template #icon>
          <n-icon><color-wand-outline /></n-icon>
        </template>
        工具盒生成
      </n-button>
    </div>

    <div class="fx-subtabs" role="tablist" aria-label="设定集子视图">
      <button
        type="button"
        role="tab"
        class="fx-subtabs__item"
        :class="{ 'fx-subtabs__item--active': view === 'cards' }"
        :aria-selected="view === 'cards'"
        @click="view = 'cards'"
      >
        设定卡
        <span class="fx-subtabs__count">{{ bibles.cards.length }}</span>
      </button>
      <button
        type="button"
        role="tab"
        class="fx-subtabs__item"
        :class="{ 'fx-subtabs__item--active': view === 'outline' }"
        :aria-selected="view === 'outline'"
        @click="view = 'outline'"
      >
        总大纲
      </button>
    </div>

    <template v-if="view === 'cards'">
      <div class="fx-assistant__field-row">
        <n-select
          v-model:value="categoryFilterModel"
          size="small"
          :options="CATEGORY_OPTIONS"
          style="flex: 1"
        />
        <label class="fx-assistant__switch">
          <n-switch v-model:value="bibles.pinnedOnly" size="small" />
          <span>仅看常驻</span>
        </label>
      </div>

      <div class="fx-assistant__field-row">
        <n-input
          v-model:value="bibles.searchQuery"
          size="small"
          clearable
          placeholder="搜索名称 / 别名 / 摘要 / 正文"
          style="flex: 1"
        >
          <template #prefix>
            <n-icon size="14"><search-outline /></n-icon>
          </template>
        </n-input>
        <n-button size="small" type="primary" secondary @click="openCreate">
          <template #icon>
            <n-icon><add-outline /></n-icon>
          </template>
          新建
        </n-button>
      </div>

      <div v-if="bibles.cardsError !== null" class="fx-error-text">{{ bibles.cardsError }}</div>

      <n-spin :show="bibles.cardsLoading">
        <div v-if="bibles.cards.length === 0" class="fx-assistant__empty">
          {{ bibles.pinnedOnly || bibles.searchQuery.trim().length > 0 || bibles.categoryFilter !== null
            ? '没有匹配的设定卡，试试调整筛选条件。'
            : '还没有设定卡。新建第一张人物或世界观卡片，让 AI 写作有据可依。' }}
        </div>
        <div v-else class="fx-card-list">
          <article v-for="card in bibles.cards" :key="card.id" class="fx-card-item">
            <div class="fx-card-item__head">
              <n-tag size="tiny" :bordered="false" type="info">
                {{ KNOWLEDGE_CARD_CATEGORY_LABELS[card.category] }}
              </n-tag>
              <strong class="fx-card-item__title">{{ card.title }}</strong>
              <n-button
                quaternary
                circle
                size="tiny"
                :aria-label="card.pinned ? '取消常驻置顶' : '设为常驻置顶'"
                :title="card.pinned ? '取消常驻置顶' : '设为常驻置顶'"
                @click="togglePinned(card)"
              >
                <template #icon>
                  <n-icon :color="card.pinned ? 'var(--fx-accent)' : undefined">
                    <star v-if="card.pinned" />
                    <star-outline v-else />
                  </n-icon>
                </template>
              </n-button>
            </div>
            <div v-if="card.aliases.length > 0 || card.tags.length > 0" class="fx-card-item__meta">
              <span v-if="card.aliases.length > 0">别名：{{ card.aliases.join('、') }}</span>
              <span v-if="card.tags.length > 0">#{{ card.tags.join(' #') }}</span>
            </div>
            <p v-if="card.summary.trim().length > 0" class="fx-card-item__summary">
              {{ card.summary }}
            </p>
            <div class="fx-card-item__actions">
              <n-button size="tiny" quaternary @click="openEdit(card)">
                <template #icon>
                  <n-icon><create-outline /></n-icon>
                </template>
                编辑
              </n-button>
              <n-button size="tiny" quaternary type="error" @click="confirmDelete(card)">
                <template #icon>
                  <n-icon><trash-outline /></n-icon>
                </template>
                删除
              </n-button>
            </div>
          </article>
        </div>
      </n-spin>
    </template>

    <template v-else>
      <div class="fx-assistant__hint">
        总大纲会作为「全局约束」进入每次 AI 写作上下文，建议只保留最关键的主线与禁忌。
      </div>
      <n-spin :show="bibles.outlineLoading">
        <div class="fx-outline-form">
          <label class="fx-assistant__field">
            <span class="fx-assistant__label">核心主线</span>
            <n-input
              v-model:value="outlineDraft.mainPlot"
              type="textarea"
              size="small"
              :autosize="{ minRows: 3, maxRows: 8 }"
              :maxlength="50000"
              placeholder="一句话故事 + 三幕式推进 + 核心爽点与反转节点。"
            />
          </label>
          <label class="fx-assistant__field">
            <span class="fx-assistant__label">世界观概览</span>
            <n-input
              v-model:value="outlineDraft.worldSetting"
              type="textarea"
              size="small"
              :autosize="{ minRows: 3, maxRows: 8 }"
              :maxlength="50000"
              placeholder="时代背景、力量体系、地理势力与基本规则。"
            />
          </label>
          <label class="fx-assistant__field">
            <span class="fx-assistant__label">文风与禁忌</span>
            <n-input
              v-model:value="outlineDraft.styleGuide"
              type="textarea"
              size="small"
              :autosize="{ minRows: 3, maxRows: 8 }"
              :maxlength="50000"
              placeholder="叙事人称、节奏偏好、必须避免的设定与词汇。"
            />
          </label>
          <label class="fx-assistant__field">
            <span class="fx-assistant__label">阶段与结局规划</span>
            <n-input
              v-model:value="outlineDraft.endingPlan"
              type="textarea"
              size="small"
              :autosize="{ minRows: 3, maxRows: 8 }"
              :maxlength="50000"
              placeholder="分卷目标、关键转折与最终结局走向。"
            />
          </label>
        </div>
      </n-spin>
      <div class="fx-outline-footer">
        <span class="fx-tertiary">最近更新：{{ outlineUpdatedLabel }}</span>
        <n-button size="small" type="primary" :loading="bibles.outlineSaving" @click="saveOutlineDraft">
          保存总大纲
        </n-button>
      </div>
      <div v-if="bibles.outlineError !== null" class="fx-error-text">{{ bibles.outlineError }}</div>
    </template>

    <n-modal
      v-model:show="modalVisible"
      preset="card"
      :title="editingCard === null ? '新建设定卡' : '编辑设定卡'"
      style="width: 560px; max-width: 92vw"
      :bordered="false"
    >
      <div class="fx-form-grid">
        <label class="fx-assistant__field fx-form-grid--full">
          <span class="fx-assistant__label">名称</span>
          <n-input v-model:value="form.title" size="small" :maxlength="100" placeholder="例如：沈照夜" />
        </label>
        <label class="fx-assistant__field">
          <span class="fx-assistant__label">分类</span>
          <n-select
            v-model:value="formCategoryModel"
            size="small"
            :options="KNOWLEDGE_CARD_CATEGORIES.map((category) => ({
              label: KNOWLEDGE_CARD_CATEGORY_LABELS[category],
              value: category,
            }))"
          />
        </label>
        <label class="fx-assistant__field">
          <span class="fx-assistant__label">常驻置顶</span>
          <n-switch v-model:value="form.pinned" size="small" />
        </label>
        <label class="fx-assistant__field fx-form-grid--full">
          <span class="fx-assistant__label">摘要（进入上下文的高频字段）</span>
          <n-input
            v-model:value="form.summary"
            type="textarea"
            size="small"
            :autosize="{ minRows: 2, maxRows: 5 }"
            :maxlength="1000"
            placeholder="一两句话概括这个设定，便于被召回与快速理解。"
          />
        </label>
        <label class="fx-assistant__field fx-form-grid--full">
          <span class="fx-assistant__label">详细设定</span>
          <n-input
            v-model:value="form.content"
            type="textarea"
            size="small"
            :autosize="{ minRows: 4, maxRows: 10 }"
            :maxlength="20000"
            placeholder="人物动机、能力边界、关系网、已知伏笔等。"
          />
        </label>
        <label class="fx-assistant__field">
          <span class="fx-assistant__label">别名（逗号或换行分隔）</span>
          <n-input
            v-model:value="form.aliases"
            type="textarea"
            size="small"
            :autosize="{ minRows: 2, maxRows: 4 }"
            placeholder="例如：沈公子，夜哥"
          />
        </label>
        <label class="fx-assistant__field">
          <span class="fx-assistant__label">标签（逗号或换行分隔）</span>
          <n-input
            v-model:value="form.tags"
            type="textarea"
            size="small"
            :autosize="{ minRows: 2, maxRows: 4 }"
            placeholder="例如：主角，守夜人，剑修"
          />
        </label>
      </div>
      <div v-if="formError !== null" class="fx-error-text" style="margin-top: 10px">{{ formError }}</div>
      <template #footer>
        <div class="fx-modal-footer">
          <n-button size="small" @click="modalVisible = false">取消</n-button>
          <n-button size="small" type="primary" :loading="submitting" @click="submitForm">
            {{ editingCard === null ? '创建设定卡' : '保存修改' }}
          </n-button>
        </div>
      </template>
    </n-modal>
  </section>
</template>
