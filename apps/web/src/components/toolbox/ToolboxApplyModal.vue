<script setup lang="ts">
import {
  KNOWLEDGE_CARD_CATEGORIES,
  KNOWLEDGE_CARD_CATEGORY_LABELS,
  TOOLBOX_OUTLINE_APPLY_MODES,
  TOOLBOX_OUTLINE_APPLY_MODE_LABELS,
  TOOLBOX_OUTLINE_FIELDS,
  TOOLBOX_OUTLINE_FIELD_LABELS,
  type KnowledgeCardCategory,
  type ToolboxOutlineApplyMode,
  type ToolboxOutlineField,
  type ToolboxResultItem,
} from '@fanxiaoshuo/shared';
import {
  NAlert,
  NButton,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NSelect,
  NSwitch,
  useMessage,
  type SelectOption,
} from 'naive-ui';
import { CheckmarkCircleOutline } from '@vicons/ionicons5';
import { computed, ref, watch } from 'vue';
import { useToolboxStore } from '@/stores/toolbox';

/**
 * 结果条目回写弹窗：支持「存为设定卡」与「写入全书总大纲」两种模式。
 *
 * 分类默认取条目的 `suggestedCardCategory`，标题默认取条目标题，
 * 目标作品默认取当前关联书籍（未关联时要求用户显式选择）。
 */

const props = defineProps<{
  show: boolean;
  mode: 'card' | 'outline';
  item: ToolboxResultItem | null;
  itemIndex: number;
  runId: string | null;
  defaultBookId: string | null;
  bookOptions: SelectOption[];
}>();

const emit = defineEmits<{
  'update:show': [boolean];
  applied: [bookId: string];
}>();

const store = useToolboxStore();
const message = useMessage();

const bookId = ref<string | null>(null);
const cardCategory = ref<KnowledgeCardCategory>('world');
const cardTitle = ref('');
const pinned = ref(false);
const outlineField = ref<ToolboxOutlineField>('mainPlot');
const outlineMode = ref<ToolboxOutlineApplyMode>('append');
const formError = ref<string | null>(null);
const appliedBookId = ref<string | null>(null);

const categoryOptions = KNOWLEDGE_CARD_CATEGORIES.map((category) => ({
  label: KNOWLEDGE_CARD_CATEGORY_LABELS[category],
  value: category,
}));

const outlineFieldOptions = TOOLBOX_OUTLINE_FIELDS.map((field) => ({
  label: TOOLBOX_OUTLINE_FIELD_LABELS[field],
  value: field,
}));

const outlineModeOptions = TOOLBOX_OUTLINE_APPLY_MODES.map((mode) => ({
  label: TOOLBOX_OUTLINE_APPLY_MODE_LABELS[mode],
  value: mode,
}));

const title = computed(() =>
  props.mode === 'card' ? '存为设定卡' : '写入全书总大纲',
);

const subtitle = computed(() =>
  props.mode === 'card'
    ? '把这条产出沉淀到目标作品的 Book Bible，后续 AI 写作会自动召回。'
    : '把这条产出写入目标作品的全书总大纲，作为跨章一致性的全局约束。',
);

function resetForm(): void {
  const item = props.item;
  bookId.value = props.defaultBookId;
  cardCategory.value = item?.suggestedCardCategory ?? 'world';
  cardTitle.value = item?.title ?? '';
  pinned.value = false;
  outlineField.value = 'mainPlot';
  outlineMode.value = 'append';
  formError.value = null;
  appliedBookId.value = null;
}

watch(
  () => [props.show, props.item, props.mode] as const,
  ([show]) => {
    if (show) {
      resetForm();
    }
  },
  { immediate: true },
);

function close(): void {
  emit('update:show', false);
}

function goToBook(bookIdValue: string): void {
  close();
  emit('applied', bookIdValue);
}

async function submit(): Promise<void> {
  formError.value = null;
  appliedBookId.value = null;

  const targetBookId = bookId.value;
  if (targetBookId === null || targetBookId === '') {
    formError.value = '请选择目标作品';
    return;
  }
  const runId = props.runId;
  if (runId === null) {
    formError.value = '缺少运行记录，请重新生成后再回写';
    return;
  }

  if (props.mode === 'card') {
    const trimmedTitle = cardTitle.value.trim();
    const card = await store.applyItemToCard(runId, {
      bookId: targetBookId,
      itemIndex: props.itemIndex,
      category: cardCategory.value,
      ...(trimmedTitle.length > 0 ? { title: trimmedTitle } : {}),
      pinned: pinned.value,
    });
    if (card === null) {
      formError.value = store.error ?? '设定卡保存失败';
      return;
    }
    appliedBookId.value = targetBookId;
    message.success(`已保存为设定卡「${card.title}」`);
    return;
  }

  const outline = await store.applyItemToOutline(runId, {
    bookId: targetBookId,
    itemIndex: props.itemIndex,
    field: outlineField.value,
    mode: outlineMode.value,
  });
  if (outline === null) {
    formError.value = store.error ?? '全书大纲写入失败';
    return;
  }
  appliedBookId.value = targetBookId;
  message.success(
    `已${outlineMode.value === 'append' ? '追加' : '替换'}到「${TOOLBOX_OUTLINE_FIELD_LABELS[outlineField.value]}」`,
  );
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    style="width: 560px"
    :title="title"
    :bordered="false"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <div class="fx-tb-apply">
      <p class="fx-tb-apply__subtitle">{{ subtitle }}</p>

      <div v-if="item !== null" class="fx-tb-apply__preview">
        <div class="fx-tb-apply__preview-title">{{ item.title }}</div>
        <p v-if="item.summary.trim().length > 0" class="fx-tb-apply__preview-summary">
          {{ item.summary }}
        </p>
      </div>

      <n-form-item label="目标作品" :show-feedback="false" style="margin-top: 12px">
        <n-select
          v-model:value="bookId"
          size="small"
          filterable
          clearable
          :options="bookOptions"
          placeholder="选择要回写的作品"
        />
      </n-form-item>

      <template v-if="mode === 'card'">
        <n-form-item label="设定分类" :show-feedback="false">
          <n-select
            v-model:value="cardCategory"
            size="small"
            :options="categoryOptions"
          />
        </n-form-item>
        <n-form-item label="设定卡标题" :show-feedback="false">
          <n-input
            v-model:value="cardTitle"
            size="small"
            maxlength="200"
            show-count
            placeholder="默认使用条目标题，可按作品口径调整"
          />
        </n-form-item>
        <n-form-item label="常驻置顶" :show-feedback="false">
          <n-switch v-model:value="pinned" size="small" />
        </n-form-item>
      </template>

      <template v-else>
        <n-form-item label="写入字段" :show-feedback="false">
          <n-select
            v-model:value="outlineField"
            size="small"
            :options="outlineFieldOptions"
          />
        </n-form-item>
        <n-form-item label="写入模式" :show-feedback="false">
          <n-select
            v-model:value="outlineMode"
            size="small"
            :options="outlineModeOptions"
          />
        </n-form-item>
        <p class="fx-form-hint">
          追加模式会保留原有内容并以空行拼接；替换模式只覆盖所选字段，其余 3 个字段不受影响。
        </p>
      </template>

      <n-alert v-if="formError !== null" type="error" :bordered="false" style="margin-top: 12px">
        {{ formError }}
      </n-alert>

      <n-alert
        v-else-if="appliedBookId !== null"
        type="success"
        :bordered="false"
        style="margin-top: 12px"
      >
        <div class="fx-inline" style="justify-content: space-between; gap: 10px">
          <span class="fx-inline" style="gap: 6px">
            <n-icon size="14"><checkmark-circle-outline /></n-icon>
            写入成功，已同步到该作品的设定集 / 总大纲。
          </span>
          <n-button text size="tiny" type="primary" @click="goToBook(appliedBookId)">
            去作品查看 →
          </n-button>
        </div>
      </n-alert>
    </div>

    <template #footer>
      <div class="fx-modal-footer">
        <n-button size="small" quaternary @click="close">关闭</n-button>
        <n-button size="small" type="primary" :loading="store.applying" @click="submit">
          确认写入
        </n-button>
      </div>
    </template>
  </n-modal>
</template>
