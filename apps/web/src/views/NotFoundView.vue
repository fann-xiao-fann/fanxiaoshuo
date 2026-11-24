<script setup lang="ts">
import { NButton, NIcon } from 'naive-ui';
import { ArrowBackOutline, CompassOutline } from '@vicons/ionicons5';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();
</script>

<template>
  <div class="fx-page">
    <section class="fx-placeholder" style="padding: 56px 40px">
      <span class="fx-placeholder__badge">
        <n-icon size="12"><compass-outline /></n-icon>
        404 · 路径未找到
      </span>
      <h1 class="fx-placeholder__title">这一页还没有被写进大纲</h1>
      <p class="fx-placeholder__lead">
        你访问的路径
        <code class="fx-mono" style="color: var(--fx-accent)">{{ route.fullPath }}</code>
        不存在或已被移动。工作台不会因此崩溃，请返回主视图继续配置模型或查看运行状态。
      </p>
      <div class="fx-placeholder__actions">
        <n-button type="primary" @click="router.push('/models')">
          <template #icon>
            <n-icon><arrow-back-outline /></n-icon>
          </template>
          一键返回主视图
        </n-button>
        <n-button quaternary @click="router.push('/runtime')">查看用量与状态</n-button>
        <n-button quaternary @click="router.back()">返回上一页</n-button>
      </div>
    </section>
  </div>
</template>
