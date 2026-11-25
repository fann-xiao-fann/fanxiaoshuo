<script setup lang="ts">
import type { MenuOption } from 'naive-ui';
import {
  NIcon,
  NLayout,
  NLayoutHeader,
  NLayoutSider,
  NMenu,
} from 'naive-ui';
import {
  BookOutline,
  ChevronBackOutline,
  ChevronForwardOutline,
  ConstructOutline,
  GitNetworkOutline,
  HardwareChipOutline,
  PulseOutline,
} from '@vicons/ionicons5';
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import HealthBadge from '@/components/HealthBadge.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';
import { NAV_ITEMS, type PageMeta } from '@/router/routes';
import { useBookWorkspaceStore } from '@/stores/book-workspace';
import { useHealthStore } from '@/stores/health';

const SIDER_STORAGE_KEY = 'fx.ui.sider.collapsed';

const route = useRoute();
const router = useRouter();
const health = useHealthStore();
const workspace = useBookWorkspaceStore();

/** 沉浸写作模式：隐藏主侧边栏与顶部栏，把整屏留给正文编辑区。 */
const immersive = computed(() => workspace.immersive);

// 离开写作工作区时自动恢复常规布局，避免沉浸状态污染其他页面。
watch(
  () => route.path,
  (path) => {
    if (!path.startsWith('/books/')) {
      workspace.exitImmersive();
    }
  },
);

function resolveCollapsed(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(SIDER_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

const collapsed = ref(resolveCollapsed());

function persistCollapsed(): void {
  try {
    window.localStorage.setItem(SIDER_STORAGE_KEY, collapsed.value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value;
  persistCollapsed();
}

const NAV_ICONS = {
  '/books': BookOutline,
  '/workflows': GitNetworkOutline,
  '/toolbox': ConstructOutline,
  '/models': HardwareChipOutline,
  '/runtime': PulseOutline,
} as const;

function renderIcon(icon: (typeof NAV_ICONS)[keyof typeof NAV_ICONS]) {
  return () => h(NIcon, { size: 19 }, { default: () => h(icon) });
}

const menuOptions = computed<MenuOption[]>(() =>
  NAV_ITEMS.map((item) => ({
    key: item.key,
    label: item.label,
    icon: renderIcon(NAV_ICONS[item.key]),
    extra: collapsed.value ? undefined : item.caption,
  })),
);

const activeKey = computed<string | undefined>(() => {
  const navKey = route.meta.navKey;
  return typeof navKey === 'string' ? navKey : undefined;
});

function handleMenuSelect(key: string): void {
  if (key !== route.path) {
    void router.push(key);
  }
}

const pageMeta = computed<PageMeta>(() => {
  const meta = route.meta as Partial<PageMeta>;
  return {
    title: typeof meta.title === 'string' ? meta.title : '工作台',
    description: typeof meta.description === 'string' ? meta.description : '',
    eyebrow: typeof meta.eyebrow === 'string' ? meta.eyebrow : '梵小说',
  };
});

const currentNavCaption = computed(() => {
  const navKey = route.meta.navKey;
  if (typeof navKey !== 'string') {
    return '工作台';
  }
  return NAV_ITEMS.find((item) => item.key === navKey)?.caption ?? '工作台';
});

/**
 * `<router-view>` 的 key：写作工作区只在「切换书籍」时重新挂载，
 * 同书内切换章节由工作区自行同步，避免整页重建导致输入中断。
 */
const viewKey = computed<string>(() => {
  const bookId = route.params.bookId;
  if (typeof bookId === 'string' && bookId.length > 0) {
    return `book-workspace:${bookId}`;
  }
  return typeof route.name === 'string' ? route.name : route.path;
});

onMounted(() => {
  health.startPolling();
});

onUnmounted(() => {
  health.stopPolling();
});
</script>

<template>
  <n-layout :has-sider="!immersive" class="fx-shell" :class="{ 'fx-shell--immersive': immersive }">
    <n-layout-sider
      v-if="!immersive"
      class="fx-shell__sider"
      bordered
      collapse-mode="width"
      :collapsed="collapsed"
      :width="236"
      :collapsed-width="68"
      :show-trigger="false"
      :native-scrollbar="false"
      :content-style="{ display: 'flex', flexDirection: 'column', height: '100%' }"
    >
      <div class="fx-sider-inner" :class="{ 'fx-sider-collapsed': collapsed }">
        <div class="fx-brand">
          <div class="fx-brand__mark">梵</div>
          <div class="fx-brand__text">
            <div class="fx-brand__name">梵小说</div>
            <div class="fx-brand__tagline">内部批量创作台</div>
          </div>
          <button
            v-if="!collapsed"
            type="button"
            class="fx-sider-toggle"
            aria-label="折叠侧边栏"
            style="margin-left: auto"
            @click="toggleCollapsed"
          >
            <n-icon size="15"><chevron-back-outline /></n-icon>
          </button>
        </div>

        <button
          v-if="collapsed"
          type="button"
          class="fx-sider-toggle"
          aria-label="展开侧边栏"
          style="margin: 10px auto 2px"
          @click="toggleCollapsed"
        >
          <n-icon size="15"><chevron-forward-outline /></n-icon>
        </button>

        <nav class="fx-sider-nav" aria-label="工作台主导航">
          <div class="fx-sider-nav__caption">工作台</div>
          <n-menu
            :value="activeKey"
            :options="menuOptions"
            :collapsed="collapsed"
            :collapsed-width="68"
            :collapsed-icon-size="21"
            :indent="18"
            @update:value="handleMenuSelect"
          />
        </nav>

        <div class="fx-sider-footer">
          <div>书架 · 卷章编辑</div>
          <div style="margin-top: 2px; opacity: 0.8">v0.1.0 · 内部使用</div>
        </div>
      </div>
    </n-layout-sider>

    <n-layout class="fx-shell__main">
      <n-layout-header v-if="!immersive" bordered class="fx-topbar">
        <div class="fx-topbar__context">
          <div class="fx-topbar__eyebrow">
            <span>梵小说 · 内部批量创作台</span>
            <span>/</span>
            <span>{{ currentNavCaption }}</span>
          </div>
          <div class="fx-topbar__title">
            {{ pageMeta.title }}
          </div>
          <div class="fx-topbar__description">{{ pageMeta.description }}</div>
        </div>

        <div class="fx-topbar__actions">
          <health-badge />
          <theme-toggle />
        </div>
      </n-layout-header>

      <main class="fx-content" :class="{ 'fx-content--immersive': immersive }">
        <router-view v-slot="{ Component }">
          <transition name="fx-fade-slide" mode="out-in">
            <component :is="Component" :key="viewKey" />
          </transition>
        </router-view>
      </main>
    </n-layout>
  </n-layout>
</template>
