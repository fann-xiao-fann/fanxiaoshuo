<script setup lang="ts">
import { NButton, NIcon, NTag } from 'naive-ui';
import { ArrowBackOutline, ArrowForwardOutline, SparklesOutline } from '@vicons/ionicons5';
import { useRouter } from 'vue-router';

export interface PlaceholderItem {
  title: string;
  description: string;
}

withDefaults(
  defineProps<{
    eyebrow: string;
    title: string;
    lead: string;
    changeLabel: string;
    items: PlaceholderItem[];
    statusLabel?: string;
  }>(),
  { statusLabel: '规划中' },
);

const router = useRouter();
</script>

<template>
  <section class="fx-placeholder">
    <span class="fx-placeholder__badge">
      <n-icon size="12"><sparkles-outline /></n-icon>
      {{ changeLabel }}
    </span>
    <h1 class="fx-placeholder__title">{{ title }}</h1>
    <p class="fx-placeholder__lead">
      {{ eyebrow }} · {{ lead }}
    </p>

    <ul class="fx-placeholder__list">
      <li v-for="item in items" :key="item.title" class="fx-placeholder__item">
        <strong>{{ item.title }}</strong>
        {{ item.description }}
      </li>
    </ul>

    <div class="fx-placeholder__actions">
      <n-tag type="warning" round size="small">{{ statusLabel }}</n-tag>
      <n-button type="primary" secondary @click="router.push('/models')">
        <template #icon>
          <n-icon><arrow-back-outline /></n-icon>
        </template>
        返回模型配置中心
      </n-button>
      <n-button quaternary @click="router.push('/runtime')">
        查看运行状态
        <template #icon>
          <n-icon><arrow-forward-outline /></n-icon>
        </template>
      </n-button>
    </div>
  </section>
</template>
