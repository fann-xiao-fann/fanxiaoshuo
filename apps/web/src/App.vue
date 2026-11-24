<script setup lang="ts">
import {
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  NNotificationProvider,
  dateZhCN,
  darkTheme,
  zhCN,
  type GlobalThemeOverrides,
} from 'naive-ui';
import { computed } from 'vue';
import { RouterView } from 'vue-router';
import { useThemeStore } from '@/stores/theme';

const themeStore = useThemeStore();

const theme = computed(() => (themeStore.isDark ? darkTheme : null));

/**
 * 「梵小说」品牌配色：黛青底色 + 鎏金强调色。
 * 明暗两套 override 分别微调，保证表格与表单在深色下仍有足够对比度。
 */
const themeOverrides = computed<GlobalThemeOverrides>(() => {
  const accent = themeStore.isDark ? '#e0a458' : '#b45309';
  const accentHover = themeStore.isDark ? '#f0bd7c' : '#c2660d';
  const accentPressed = themeStore.isDark ? '#c98d3e' : '#8f3f06';
  return {
    common: {
      primaryColor: accent,
      primaryColorHover: accentHover,
      primaryColorPressed: accentPressed,
      primaryColorSuppl: accentHover,
      borderRadius: '8px',
      borderRadiusSmall: '6px',
      fontFamily:
        '"Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif',
      fontFamilyMono:
        '"JetBrains Mono", "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
    },
    Card: {
      borderRadius: '14px',
    },
    DataTable: {
      thFontWeight: '600',
    },
    Tag: {
      borderRadius: '999px',
    },
  };
});
</script>

<template>
  <n-config-provider
    :theme="theme"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <n-message-provider :max="4">
      <n-dialog-provider>
        <n-notification-provider>
          <router-view />
        </n-notification-provider>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
