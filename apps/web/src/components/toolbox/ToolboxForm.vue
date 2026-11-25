<script setup lang="ts">
import {
  AGENT_ROLES,
  AGENT_ROLE_LABELS,
  TOOLBOX_FIELD_TYPE_LABELS,
  type AgentRole,
  type ToolboxToolDefinitionDto,
} from '@fanxiaoshuo/shared';
import {
  NButton,
  NIcon,
  NInput,
  NInputNumber,
  NSelect,
  NTag,
  NTooltip,
  type SelectOption,
} from 'naive-ui';
import { FlashOutline, LibraryOutline, PersonOutline } from '@vicons/ionicons5';
import { computed } from 'vue';
import { useToolboxStore } from '@/stores/toolbox';

/**
 * Schema 驱动的动态表单：严格按 `selectedTool.fields` 渲染
 * `text` / `textarea` / `select` / `number` 四类控件，
 * 支持必填标记、字数上限、帮助文案与 `Ctrl/Cmd + Enter` 直接执行。
 */

const props = defineProps<{
  tool: ToolboxToolDefinitionDto | undefined;
  bookOptions: SelectOption[];
  booksLoading: boolean;
}>();

const emit = defineEmits<{
  execute: [];
}>();

const store = useToolboxStore();

const defaultRoleLabel = computed(() => {
  const role = props.tool?.defaultRole;
  return role === undefined ? '—' : AGENT_ROLE_LABELS[role];
});

const roleOptions = computed(() => [
  {
    label: `按工具推荐（${defaultRoleLabel.value}）`,
    value: 'default',
  },
  ...AGENT_ROLES.map((role) => ({ label: AGENT_ROLE_LABELS[role], value: role })),
]);

const roleValue = computed<string>({
  get: () => store.roleOverride ?? 'default',
  set: (value: string) => {
    const role = value === 'default' ? null : (value as AgentRole);
    store.setRoleOverride(role);
  },
});

function updateRole(value: string): void {
  roleValue.value = value;
}

const bookValue = computed<string | null>({
  get: () => store.selectedBookId,
  set: (value: string | null) => {
    store.setBookContext(value === undefined || value === '' ? null : value);
  },
});

const supportsBookContext = computed(() => props.tool?.supportsBookContext ?? true);

function textValue(key: string): string {
  const value = store.formInputs[key];
  if (typeof value === 'number') {
    return String(value);
  }
  return value ?? '';
}

function numberValue(key: string): number | null {
  const value = store.formInputs[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function updateText(key: string, value: string | null): void {
  store.setFormInput(key, value ?? '');
}

function updateNumber(key: string, value: number | null): void {
  store.setFormInput(key, value === null ? '' : value);
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    emit('execute');
  }
}
</script>

<template>
  <section class="fx-tb-form" @keydown="onKeydown">
    <header class="fx-tb-form__head">
      <div>
        <div class="fx-tb-form__title">
          {{ tool?.name ?? '创作工具盒' }}
          <n-tag v-if="tool" size="tiny" round :bordered="false" type="info">
            推荐角色 · {{ AGENT_ROLE_LABELS[tool.defaultRole] }}
          </n-tag>
        </div>
        <div class="fx-tb-form__summary">
          {{ tool?.summary ?? '请从左侧选择一个创作工具开始。' }}
        </div>
      </div>
    </header>

    <!-- 上下文：关联作品 + 可选角色覆盖 -->
    <div class="fx-tb-context">
      <div class="fx-tb-context__field">
        <span class="fx-tb-context__label">
          <n-icon size="13"><library-outline /></n-icon>
          关联作品上下文
        </span>
        <n-select
          v-model:value="bookValue"
          size="small"
          clearable
          filterable
          :disabled="!supportsBookContext"
          :loading="booksLoading"
          :options="bookOptions"
          :placeholder="supportsBookContext ? '不关联作品（仅按输入生成）' : '该工具不支持作品上下文'"
        />
        <span class="fx-tb-context__hint">
          关联后会注入该书总大纲与核心设定卡，产出更贴合已有设定。
        </span>
      </div>
      <div class="fx-tb-context__field">
        <span class="fx-tb-context__label">
          <n-icon size="13"><person-outline /></n-icon>
          执行角色
        </span>
        <n-select
          :value="roleValue"
          size="small"
          :options="roleOptions"
          @update:value="updateRole"
        />
        <span class="fx-tb-context__hint">默认按工具推荐的写书角色调用其绑定模型。</span>
      </div>
    </div>

    <!-- 动态字段 -->
    <div v-if="tool" class="fx-tb-fields">
      <div
        v-for="field in tool.fields"
        :key="field.key"
        class="fx-tb-field"
        :class="{ 'fx-tb-field--full': field.type === 'textarea' }"
      >
        <label class="fx-tb-field__label" :for="`tb-field-${field.key}`">
          {{ field.label }}
          <span v-if="field.required" class="fx-tb-field__required">*</span>
          <n-tooltip trigger="hover" :disabled="field.help === undefined">
            <template #trigger>
              <n-tag size="tiny" round :bordered="false" type="default">
                {{ TOOLBOX_FIELD_TYPE_LABELS[field.type] }}
              </n-tag>
            </template>
            {{ field.help }}
          </n-tooltip>
        </label>

        <n-input
          v-if="field.type === 'text'"
          :id="`tb-field-${field.key}`"
          :value="textValue(field.key)"
          size="small"
          clearable
          :maxlength="field.maxLength"
          :placeholder="field.placeholder"
          @update:value="(value: string) => updateText(field.key, value)"
        />

        <n-input
          v-else-if="field.type === 'textarea'"
          :id="`tb-field-${field.key}`"
          :value="textValue(field.key)"
          type="textarea"
          size="small"
          :maxlength="field.maxLength"
          :placeholder="field.placeholder"
          :autosize="{ minRows: 3, maxRows: 10 }"
          show-count
          @update:value="(value: string) => updateText(field.key, value)"
        />

        <n-select
          v-else-if="field.type === 'select'"
          :id="`tb-field-${field.key}`"
          :value="textValue(field.key) === '' ? null : textValue(field.key)"
          size="small"
          :options="(field.options ?? []).map((option) => ({ label: option.label, value: option.value }))"
          :placeholder="field.placeholder ?? '请选择'"
          @update:value="(value: string | null) => updateText(field.key, value)"
        />

        <n-input-number
          v-else
          :id="`tb-field-${field.key}`"
          :value="numberValue(field.key)"
          size="small"
          :min="field.min"
          :max="field.max"
          :precision="0"
          :placeholder="field.placeholder"
          style="width: 100%"
          @update:value="(value: number | null) => updateNumber(field.key, value)"
        />

        <div v-if="store.fieldErrors[field.key] !== undefined" class="fx-form-error">
          {{ store.fieldErrors[field.key] }}
        </div>
        <div v-else-if="field.help !== undefined" class="fx-form-hint">{{ field.help }}</div>
      </div>
    </div>

    <footer class="fx-tb-form__footer">
      <span class="fx-tertiary fx-tb-form__shortcut">
        <n-icon size="12"><flash-outline /></n-icon>
        Ctrl / ⌘ + Enter 可直接生成
      </span>
      <n-button
        type="primary"
        size="small"
        :disabled="tool === undefined"
        :loading="store.running"
        @click="emit('execute')"
      >
        {{ store.running ? '生成中…' : '开始生成' }}
      </n-button>
    </footer>
  </section>
</template>
