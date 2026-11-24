<script setup lang="ts">
import { NButton, NIcon, NTooltip } from 'naive-ui';
import { MoonOutline, SunnyOutline } from '@vicons/ionicons5';
import { useThemeStore } from '@/stores/theme';

const themeStore = useThemeStore();
</script>

<template>
  <n-tooltip trigger="hover" placement="bottom">
    <template #trigger>
      <n-button
        quaternary
        circle
        size="small"
        :aria-label="themeStore.isDark ? '切换到浅色主题' : '切换到暗黑主题'"
        @click="themeStore.toggleTheme()"
      >
        <template #icon>
          <n-icon size="18">
            <sunny-outline v-if="themeStore.isDark" />
            <moon-outline v-else />
          </n-icon>
        </template>
      </n-button>
    </template>
    {{ themeStore.isDark ? '切换到浅色主题' : '切换到暗黑主题' }}
  </n-tooltip>
</template>
