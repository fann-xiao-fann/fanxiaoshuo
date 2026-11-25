<script setup lang="ts">
import { NButton, NInput, NModal, NFormItem } from 'naive-ui';
import { ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    show: boolean;
    title: string;
    label: string;
    placeholder?: string;
    initialValue?: string;
    confirmText?: string;
    maxLength?: number;
    loading?: boolean;
    /** 允许提交空字符串（如可选的快照备注）。 */
    allowEmpty?: boolean;
  }>(),
  {
    placeholder: '',
    initialValue: '',
    confirmText: '确定',
    maxLength: 120,
    loading: false,
    allowEmpty: false,
  },
);

const emit = defineEmits<{
  'update:show': [boolean];
  confirm: [string];
}>();

const value = ref(props.initialValue);
const touched = ref(false);

watch(
  () => [props.show, props.initialValue] as const,
  ([show, initial]) => {
    if (show) {
      value.value = initial;
      touched.value = false;
    }
  },
  { immediate: true },
);

const isInvalid = (): boolean => !props.allowEmpty && value.value.trim().length === 0;

function close(): void {
  emit('update:show', false);
}

function submit(): void {
  touched.value = true;
  if (isInvalid()) {
    return;
  }
  emit('confirm', value.value.trim());
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="title"
    style="width: 440px; max-width: 92vw"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <n-form-item
      :label="label"
      :validation-status="touched && isInvalid() ? 'error' : undefined"
      :feedback="touched && isInvalid() ? '内容不能为空' : undefined"
    >
      <n-input
        v-model:value="value"
        :placeholder="placeholder"
        :maxlength="maxLength"
        show-count
        autofocus
        @keydown.enter.prevent="submit"
      />
    </n-form-item>

    <template #footer>
      <div class="fx-modal-footer">
        <n-button :disabled="loading" @click="close">取消</n-button>
        <n-button type="primary" :loading="loading" @click="submit">{{ confirmText }}</n-button>
      </div>
    </template>
  </n-modal>
</template>
