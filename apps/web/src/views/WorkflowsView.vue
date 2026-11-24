<script setup lang="ts">
import ModulePlaceholder from '@/components/ModulePlaceholder.vue';

const items = [
  {
    title: '总编策划 Showrunner',
    description: '立项定调、拆解细纲，并把大纲转成可执行的章节任务图。',
  },
  {
    title: '设定档案员 Lorekeeper',
    description: '维护人物、世界观与时间线，为每一章提供不失真的长文上下文。',
  },
  {
    title: '执笔写手 Writer × 审稿 Critic',
    description: '按细纲成文后进入审稿闭环，由质检角色定位问题并决定是否返工。',
  },
  {
    title: 'BullMQ 批量调度',
    description: '复用现有 runtime-smoke 队列底座，扩展为可限流、可熔断、可恢复的批量生产流水线。',
  },
];
</script>

<template>
  <div class="fx-page">
    <module-placeholder
      eyebrow="运行期"
      title="批量流水线"
      change-label="Change 4 · 多 Agent 批量成文"
      lead="批量流水线将把模型配置中心的角色路由、运行期 Mastra 引擎与 BullMQ 队列组合成完整的网文生产 DAG。当前变更先交付可验证的单任务冒烟底座。"
      :items="items"
      status-label="规划中"
    />
  </div>
</template>
