<script setup lang="ts">
import {
  PROVIDER_PROTOCOLS,
  PROVIDER_PROTOCOL_META,
  createProviderSchema,
  updateProviderSchema,
  type CreateProviderInputPayload,
  type ProviderDto,
  type ProviderProtocol,
  type UpdateProviderInputPayload,
} from '@fanxiaoshuo/shared';
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSwitch,
} from 'naive-ui';
import { computed, reactive, ref, watch } from 'vue';

export type ProviderSubmitPayload =
  | { mode: 'create'; payload: CreateProviderInputPayload }
  | { mode: 'edit'; payload: UpdateProviderInputPayload };

const props = defineProps<{
  show: boolean;
  provider: ProviderDto | null;
  saving: boolean;
}>();

const emit = defineEmits<{
  'update:show': [value: boolean];
  submit: [payload: ProviderSubmitPayload];
}>();

const form = reactive({
  name: '',
  protocol: 'openai-compatible' as ProviderProtocol,
  baseUrl: '',
  apiKey: '',
  isEnabled: true,
});

const formError = ref<string | null>(null);
let previousProtocol: ProviderProtocol = 'openai-compatible';

const isEdit = computed(() => props.provider !== null);
const title = computed(() => (isEdit.value ? '编辑供应商' : '新增供应商'));

const protocolOptions = PROVIDER_PROTOCOLS.map((protocol) => ({
  label: `${PROVIDER_PROTOCOL_META[protocol].label}（${protocol}）`,
  value: protocol,
}));

/** Base URL 占位示例（独立常量避免模板静态属性中的 URL 解析歧义）。 */
const BASE_URL_PLACEHOLDER = 'https://api.example.com/v1';

const apiKeyPlaceholder = computed(() =>
  isEdit.value
    ? `留空则保留原密钥（当前：${props.provider?.apiKeyMask ?? '已加密'}）`
    : '粘贴上游 API Key（落库前 AES-256-GCM 加密）',
);

watch(
  () => props.show,
  (visible) => {
    if (!visible) {
      return;
    }
    formError.value = null;
    const provider = props.provider;
    if (provider === null) {
      form.name = '';
      form.protocol = 'openai-compatible';
      form.baseUrl = PROVIDER_PROTOCOL_META['openai-compatible'].defaultBaseUrl;
      form.apiKey = '';
      form.isEnabled = true;
      previousProtocol = 'openai-compatible';
      return;
    }
    form.name = provider.name;
    form.protocol = provider.protocol;
    form.baseUrl = provider.baseUrl;
    form.apiKey = '';
    form.isEnabled = provider.isEnabled;
    previousProtocol = provider.protocol;
  },
  { immediate: true },
);

watch(
  () => form.protocol,
  (protocol) => {
    const previousDefault = PROVIDER_PROTOCOL_META[previousProtocol].defaultBaseUrl;
    const nextDefault = PROVIDER_PROTOCOL_META[protocol].defaultBaseUrl;
    if (form.baseUrl.trim() === '' || form.baseUrl.trim() === previousDefault) {
      form.baseUrl = nextDefault;
    }
    previousProtocol = protocol;
  },
);

function formatIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '字段'}：${issue.message}`)
    .join('；');
}

function close(): void {
  emit('update:show', false);
}

function handleSubmit(): void {
  formError.value = null;
  const base = {
    name: form.name.trim(),
    protocol: form.protocol,
    baseUrl: form.baseUrl.trim(),
    isEnabled: form.isEnabled,
  };
  const apiKey = form.apiKey.trim();

  if (isEdit.value && props.provider !== null) {
    const payload: UpdateProviderInputPayload = {
      ...base,
      ...(apiKey.length > 0 ? { apiKey } : {}),
    };
    const parsed = updateProviderSchema.safeParse(payload);
    if (!parsed.success) {
      formError.value = formatIssues(parsed.error.issues);
      return;
    }
    emit('submit', { mode: 'edit', payload: parsed.data });
    return;
  }

  const payload = { ...base, apiKey };
  const parsed = createProviderSchema.safeParse(payload);
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
    style="width: 560px; max-width: calc(100vw - 32px)"
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
        <n-form-item label="供应商名称" required>
          <n-input v-model:value="form.name" placeholder="例如：内部中转站 A" maxlength="64" />
        </n-form-item>
        <n-form-item label="协议类型" required>
          <n-select v-model:value="form.protocol" :options="protocolOptions" />
        </n-form-item>
        <n-form-item label="Base URL" required class="fx-form-grid--full">
          <n-input
            v-model:value="form.baseUrl"
            :placeholder="BASE_URL_PLACEHOLDER"
            maxlength="2048"
          />
        </n-form-item>
        <n-form-item label="API Key" :required="!isEdit" class="fx-form-grid--full">
          <n-input
            v-model:value="form.apiKey"
            type="password"
            show-password-on="click"
            :placeholder="apiKeyPlaceholder"
            maxlength="512"
          />
          <div class="fx-form-hint">
            密钥仅以 AES-256-GCM 密文落库，接口只返回脱敏指纹（如
            <code class="fx-mono">sk-***9f2a</code>）。
          </div>
        </n-form-item>
        <n-form-item label="启用状态">
          <n-switch v-model:value="form.isEnabled">
            <template #checked>启用</template>
            <template #unchecked>停用</template>
          </n-switch>
        </n-form-item>
      </div>
    </n-form>

    <template #footer>
      <div class="fx-modal-footer">
        <n-button :disabled="saving" @click="close">取消</n-button>
        <n-button type="primary" :loading="saving" @click="handleSubmit">
          {{ isEdit ? '保存修改' : '创建供应商' }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>
