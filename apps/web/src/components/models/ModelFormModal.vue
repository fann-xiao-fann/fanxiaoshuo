<script setup lang="ts">
import {
  createModelSchema,
  updateModelSchema,
  type CreateModelInputPayload,
  type ModelDto,
  type ProviderDto,
  type UpdateModelInputPayload,
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
  NSwitch,
} from 'naive-ui';
import { computed, reactive, ref, watch } from 'vue';

export type ModelSubmitPayload =
  | { mode: 'create'; payload: CreateModelInputPayload }
  | { mode: 'edit'; payload: UpdateModelInputPayload };

const props = defineProps<{
  show: boolean;
  model: ModelDto | null;
  providers: ProviderDto[];
  saving: boolean;
}>();

const emit = defineEmits<{
  'update:show': [value: boolean];
  submit: [payload: ModelSubmitPayload];
}>();

const form = reactive({
  providerId: null as string | null,
  modelId: '',
  displayName: '',
  contextWindow: null as number | null,
  inputPricePer1M: 0,
  outputPricePer1M: 0,
  isEnabled: true,
});

const formError = ref<string | null>(null);

const isEdit = computed(() => props.model !== null);
const title = computed(() => (isEdit.value ? '编辑模型' : '注册模型'));

const providerOptions = computed(() =>
  props.providers.map((provider) => ({
    label: `${provider.name}（${provider.protocol}）`,
    value: provider.id,
    disabled: !provider.isEnabled,
  })),
);

watch(
  () => props.show,
  (visible) => {
    if (!visible) {
      return;
    }
    formError.value = null;
    const model = props.model;
    if (model === null) {
      form.providerId = props.providers.find((item) => item.isEnabled)?.id ?? null;
      form.modelId = '';
      form.displayName = '';
      form.contextWindow = null;
      form.inputPricePer1M = 0;
      form.outputPricePer1M = 0;
      form.isEnabled = true;
      return;
    }
    form.providerId = model.providerId;
    form.modelId = model.modelId;
    form.displayName = model.displayName;
    form.contextWindow = model.contextWindow;
    form.inputPricePer1M = model.inputPricePer1M;
    form.outputPricePer1M = model.outputPricePer1M;
    form.isEnabled = model.isEnabled;
  },
  { immediate: true },
);

function formatIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '字段'}：${issue.message}`)
    .join('；');
}

function handleSubmit(): void {
  formError.value = null;
  if (form.providerId === null) {
    formError.value = '请选择所属供应商：需先创建至少一个启用的供应商。';
    return;
  }
  const common = {
    modelId: form.modelId.trim(),
    displayName: form.displayName.trim(),
    contextWindow: form.contextWindow === null ? null : Math.round(form.contextWindow),
    inputPricePer1M:
      typeof form.inputPricePer1M === 'number' && Number.isFinite(form.inputPricePer1M)
        ? form.inputPricePer1M
        : 0,
    outputPricePer1M:
      typeof form.outputPricePer1M === 'number' && Number.isFinite(form.outputPricePer1M)
        ? form.outputPricePer1M
        : 0,
    isEnabled: form.isEnabled,
  };

  if (isEdit.value) {
    const parsed = updateModelSchema.safeParse(common);
    if (!parsed.success) {
      formError.value = formatIssues(parsed.error.issues);
      return;
    }
    emit('submit', { mode: 'edit', payload: parsed.data });
    return;
  }

  const parsed = createModelSchema.safeParse({ providerId: form.providerId, ...common });
  if (!parsed.success) {
    formError.value = formatIssues(parsed.error.issues);
    return;
  }
  emit('submit', { mode: 'create', payload: parsed.data });
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="title"
    style="width: 640px; max-width: calc(100vw - 32px)"
    :mask-closable="!saving"
    :close-on-esc="!saving"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <n-alert v-if="formError" type="error" class="fx-form-error" :bordered="false">
      {{ formError }}
    </n-alert>

    <n-form label-placement="top" :show-require-mark="false" @submit.prevent="handleSubmit">
      <div class="fx-form-grid">
        <n-form-item label="所属供应商" required>
          <n-select
            v-model:value="form.providerId"
            :options="providerOptions"
            :disabled="isEdit"
            placeholder="选择供应商"
          />
          <div v-if="isEdit" class="fx-form-hint">模型创建后不支持变更所属供应商。</div>
        </n-form-item>
        <n-form-item label="上游模型标识" required>
          <n-input
            v-model:value="form.modelId"
            class="fx-mono"
            placeholder="deepseek-chat / gpt-4o-mini"
            maxlength="128"
          />
        </n-form-item>
        <n-form-item label="展示名称" required>
          <n-input
            v-model:value="form.displayName"
            placeholder="例如：DeepSeek Chat（主力写手）"
            maxlength="128"
          />
        </n-form-item>
        <n-form-item label="上下文窗口（tokens）">
          <n-input-number
            v-model:value="form.contextWindow"
            placeholder="未知可留空"
            :min="0"
            :max="10000000"
            :show-button="false"
            clearable
            style="width: 100%"
          />
        </n-form-item>
        <n-form-item label="输入单价（USD / 1M tokens）">
          <n-input-number
            v-model:value="form.inputPricePer1M"
            :min="0"
            :max="1000000"
            :step="0.01"
            :show-button="false"
            style="width: 100%"
          />
        </n-form-item>
        <n-form-item label="输出单价（USD / 1M tokens）">
          <n-input-number
            v-model:value="form.outputPricePer1M"
            :min="0"
            :max="1000000"
            :step="0.01"
            :show-button="false"
            style="width: 100%"
          />
        </n-form-item>
        <n-form-item label="启用状态">
          <n-switch v-model:value="form.isEnabled">
            <template #checked>启用</template>
            <template #unchecked>停用</template>
          </n-switch>
        </n-form-item>
      </div>
      <p class="fx-form-hint" style="margin-top: 4px">
        单价统一按 <strong>USD / 1M tokens</strong> 记录；若中转站以人民币计价，请先自行换算，
        以保证用量账本口径一致。
      </p>
    </n-form>

    <template #footer>
      <div class="fx-modal-footer">
        <n-button :disabled="saving" @click="emit('update:show', false)">取消</n-button>
        <n-button type="primary" :loading="saving" @click="handleSubmit">
          {{ isEdit ? '保存修改' : '注册模型' }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>
