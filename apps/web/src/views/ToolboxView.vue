<script setup lang="ts">
import ModulePlaceholder from '@/components/ModulePlaceholder.vue';

const items = [
  {
    title: '设定抽取与归一化',
    description: '从正文中抽取人物、地点与事件，生成可检索的结构化设定条目。',
  },
  {
    title: '灵感扩写与桥段改写',
    description: '针对卡文片段提供多版本续写候选，并由作者挑选后回填编辑器。',
  },
  {
    title: '文本质检工具',
    description: '错别字、重复用词、视角漂移与节奏分析，逐步接入审稿 Agent 的评分维度。',
  },
];
</script>

<template>
  <div class="fx-page">
    <module-placeholder
      eyebrow="创作"
      title="创作工具盒"
      change-label="Change 5 · 创作辅助工具集"
      lead="工具盒用于承载写作过程中的单点提效工具。它复用统一模型网关与角色路由，不会绕过任何用量计费与审计。"
      :items="items"
      status-label="规划中"
    />
  </div>
</template>
