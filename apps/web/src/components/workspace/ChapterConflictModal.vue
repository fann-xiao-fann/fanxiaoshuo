<script setup lang="ts">
import { NAlert, NButton, NModal } from 'naive-ui';
import { computed } from 'vue';

const props = defineProps<{
  show: boolean;
  /** 服务端当前版本号（响应未提供时为 null） */
  currentVersion: number | null;
  localWordCount: number;
  loading?: boolean;
}>();

const emit = defineEmits<{
  reload: [];
  overwrite: [];
  cancel: [];
}>();

const versionText = computed(() =>
  props.currentVersion === null ? '服务端已有更新的版本' : `服务端最新版本为 v${props.currentVersion}`,
);
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="检测到章节版本冲突"
    style="width: 560px; max-width: 92vw"
    :bordered="false"
    :mask-closable="false"
    :closable="false"
  >
    <div class="fx-stack" style="gap: 14px">
      <n-alert type="error" :bordered="false">
        {{ versionText }}，本次保存已被拦截，避免静默覆盖其他标签页或后台流水线写入的新内容。
      </n-alert>

      <div class="fx-muted" style="font-size: 12.5px; line-height: 1.8">
        当前本地草稿约 {{ localWordCount }} 字。请选择处理方式：
      </div>

      <ul class="fx-conflict-list">
        <li>
          <strong>重新加载最新版本</strong>：放弃本地这份过期草稿，改为编辑服务端最新正文。
        </li>
        <li>
          <strong>保留当前内容并强制覆盖</strong>：服务端会先把最新正文自动备份为一条历史快照，再用本地内容覆盖，可随时回滚。
        </li>
      </ul>
    </div>

    <template #footer>
      <div class="fx-modal-footer">
        <n-button :disabled="loading === true" @click="emit('cancel')">稍后再处理</n-button>
        <n-button type="primary" secondary :loading="loading === true" @click="emit('reload')">
          重新加载最新版本
        </n-button>
        <n-button type="warning" :loading="loading === true" @click="emit('overwrite')">
          保留当前内容并强制覆盖
        </n-button>
      </div>
    </template>
  </n-modal>
</template>
