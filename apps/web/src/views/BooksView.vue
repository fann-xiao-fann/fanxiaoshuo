<script setup lang="ts">
import ModulePlaceholder from '@/components/ModulePlaceholder.vue';

const items = [
  {
    title: '书库与卷章树',
    description: '按书 / 卷 / 章组织作品，支持批量导入、状态标签与写作进度概览。',
  },
  {
    title: 'TipTap 章节编辑器',
    description: '沉浸式正文写作、字数统计、自动保存与版本快照，作为后续写书流水线的落地容器。',
  },
  {
    title: '书设定集入口',
    description: '人物卡、世界观条目与章节摘要将在 Change 3 中与设定档案员 Agent 联动。',
  },
];
</script>

<template>
  <div class="fx-page">
    <module-placeholder
      eyebrow="书库"
      title="书架"
      change-label="Change 2 · 书库与编辑器"
      lead="这里是后续书库、卷章树与正文编辑的归属模块。Change 1 仅提供导航外壳与占位视图，确保后续增量开发不推翻现有布局。"
      :items="items"
      status-label="尚未开放"
    />
  </div>
</template>
