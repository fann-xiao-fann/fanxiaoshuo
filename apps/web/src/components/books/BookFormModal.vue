<script setup lang="ts">
import {
  BOOK_STATUS_LABELS,
  DEFAULT_TARGET_CHAPTER_WORDS,
  MAX_TARGET_CHAPTER_WORDS,
  type BookDto,
  type BookStatus,
} from '@fanxiaoshuo/shared';
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  useMessage,
  type FormInst,
  type FormRules,
} from 'naive-ui';
import { computed, reactive, ref, watch } from 'vue';
import { describeError } from '@/api/errors';
import { useBooksStore } from '@/stores/books';

const props = defineProps<{
  show: boolean;
  /** null 表示新建，否则为编辑目标 */
  book: BookDto | null;
}>();

const emit = defineEmits<{
  'update:show': [boolean];
  saved: [BookDto];
}>();

interface BookFormModel {
  title: string;
  authorPenName: string;
  genre: string;
  status: BookStatus;
  targetChapterWords: number | null;
  synopsis: string;
}

const booksStore = useBooksStore();
const message = useMessage();
const formRef = ref<FormInst | null>(null);
const errorMessage = ref<string | null>(null);
const submitting = ref(false);

const isEdit = computed(() => props.book !== null);
const title = computed(() => (isEdit.value ? '编辑书籍信息' : '新建书籍'));

const model = reactive<BookFormModel>({
  title: '',
  authorPenName: '',
  genre: '',
  status: 'draft',
  targetChapterWords: DEFAULT_TARGET_CHAPTER_WORDS,
  synopsis: '',
});

const statusOptions = (Object.keys(BOOK_STATUS_LABELS) as BookStatus[]).map((status) => ({
  label: BOOK_STATUS_LABELS[status],
  value: status,
}));

const rules: FormRules = {
  title: [
    {
      required: true,
      trigger: ['input', 'blur'],
      validator: (_rule: unknown, value: string) => {
        if (typeof value !== 'string' || value.trim().length === 0) {
          return new Error('请输入书名');
        }
        if (value.trim().length > 120) {
          return new Error('书名不能超过 120 个字符');
        }
        return true;
      },
    },
  ],
  targetChapterWords: [
    {
      required: true,
      trigger: ['input', 'blur'],
      validator: (_rule: unknown, value: number | null) => {
        if (value === null || !Number.isInteger(value) || value <= 0) {
          return new Error('单章目标字数必须为正整数');
        }
        if (value > MAX_TARGET_CHAPTER_WORDS) {
          return new Error(`单章目标字数不能超过 ${MAX_TARGET_CHAPTER_WORDS}`);
        }
        return true;
      },
    },
  ],
};

/** 每次打开时用目标书籍（或默认值）重置表单。 */
watch(
  () => [props.show, props.book] as const,
  ([show, book]) => {
    if (!show) {
      return;
    }
    errorMessage.value = null;
    submitting.value = false;
    if (book !== null) {
      model.title = book.title;
      model.authorPenName = book.authorPenName;
      model.genre = book.genre;
      model.status = book.status;
      model.targetChapterWords = book.targetChapterWords;
      model.synopsis = book.synopsis;
    } else {
      model.title = '';
      model.authorPenName = '';
      model.genre = '';
      model.status = 'draft';
      model.targetChapterWords = DEFAULT_TARGET_CHAPTER_WORDS;
      model.synopsis = '';
    }
  },
  { immediate: true },
);

function close(): void {
  emit('update:show', false);
}

async function submit(): Promise<void> {
  errorMessage.value = null;
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  const payload = {
    title: model.title.trim(),
    authorPenName: model.authorPenName.trim(),
    genre: model.genre.trim(),
    status: model.status,
    targetChapterWords: model.targetChapterWords ?? DEFAULT_TARGET_CHAPTER_WORDS,
    synopsis: model.synopsis.trim(),
  };

  submitting.value = true;
  try {
    const saved =
      props.book === null
        ? await booksStore.createBook(payload)
        : await booksStore.updateBook(props.book.id, payload);
    message.success(props.book === null ? '书籍已创建' : '书籍信息已更新');
    emit('saved', saved);
    close();
  } catch (error) {
    errorMessage.value = describeError(error);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="title"
    style="width: 620px; max-width: 94vw"
    :bordered="false"
    :mask-closable="!submitting"
    @update:show="emit('update:show', $event)"
  >
    <n-alert v-if="errorMessage !== null" type="error" class="fx-form-error" :bordered="false">
      {{ errorMessage }}
    </n-alert>

    <n-form ref="formRef" :model="model" :rules="rules" label-placement="top" require-mark-placement="right-hanging">
      <div class="fx-form-grid">
        <n-form-item label="书名" path="title" class="fx-form-grid--full">
          <n-input
            v-model:value="model.title"
            placeholder="例如：长夜灯河"
            :maxlength="120"
            show-count
            clearable
          />
        </n-form-item>

        <n-form-item label="笔名" path="authorPenName">
          <n-input v-model:value="model.authorPenName" placeholder="作者署名（可选）" :maxlength="64" />
        </n-form-item>

        <n-form-item label="题材" path="genre">
          <n-input v-model:value="model.genre" placeholder="例如：东方玄幻 / 都市悬疑" :maxlength="64" />
        </n-form-item>

        <n-form-item label="作品状态" path="status">
          <n-select v-model:value="model.status" :options="statusOptions" />
        </n-form-item>

        <n-form-item label="单章目标字数" path="targetChapterWords">
          <n-input-number
            v-model:value="model.targetChapterWords"
            :min="1"
            :max="MAX_TARGET_CHAPTER_WORDS"
            :step="500"
            style="width: 100%"
          />
        </n-form-item>

        <n-form-item label="简介" path="synopsis" class="fx-form-grid--full">
          <n-input
            v-model:value="model.synopsis"
            type="textarea"
            placeholder="一段话讲清主线与卖点（可选）"
            :maxlength="5000"
            :autosize="{ minRows: 3, maxRows: 6 }"
            show-count
          />
        </n-form-item>
      </div>
      <div class="fx-form-hint">目标字数用于编辑器内的单章进度提示，不会强制截断正文。</div>
    </n-form>

    <template #footer>
      <div class="fx-modal-footer">
        <n-button :disabled="submitting" @click="close">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="submit">
          {{ isEdit ? '保存修改' : '创建书籍' }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>
