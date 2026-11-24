import { defineStore } from 'pinia';

/** 主题偏好持久化键：与 `index.html` 内联脚本严格一致。 */
export const THEME_STORAGE_KEY = 'fx.ui.theme';

export type ThemeMode = 'light' | 'dark';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

/** 读取系统配色偏好（无 matchMedia 时按浅色处理）。 */
export function getSystemTheme(): ThemeMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 解析初始主题：localStorage 中合法的显式偏好优先，其次跟随系统。
 * localStorage 被禁用（隐私模式）时静默降级，不影响渲染。
 */
export function resolveInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'light';
  }
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(stored)) {
      return stored;
    }
  } catch {
    /* localStorage 不可用：继续跟随系统 */
  }
  return getSystemTheme();
}

function persistTheme(mode: ThemeMode): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* 写入失败不阻断主题切换 */
  }
}

/**
 * 将主题同步到 `<html>`：阻止暗色刷新闪白的关键链路之一。
 * 同时维护 `class="dark"`、`data-theme`、`color-scheme` 与首屏底色变量。
 */
export function applyThemeToDocument(mode: ThemeMode): void {
  if (typeof document === 'undefined') {
    return;
  }
  const root = document.documentElement;
  const isDark = mode === 'dark';
  root.classList.toggle('dark', isDark);
  root.setAttribute('data-theme', mode);
  root.style.colorScheme = mode;
  const background = isDark ? '#0b0f14' : '#f5f7fa';
  root.style.setProperty('--fx-bg-body', background);
  root.style.backgroundColor = background;
}

/**
 * 明暗双主题 store：切换立即生效并持久化至 `localStorage['fx.ui.theme']`。
 */
export const useThemeStore = defineStore('fx-theme', {
  state: () => ({
    mode: resolveInitialTheme() as ThemeMode,
  }),
  getters: {
    isDark: (state): boolean => state.mode === 'dark',
    /** 供 naive-ui `<n-config-provider :theme>` 直接使用 */
    naiveThemeName: (state): 'dark' | 'light' => state.mode,
  },
  actions: {
    applyTheme(): void {
      applyThemeToDocument(this.mode);
    },
    setTheme(mode: ThemeMode): void {
      this.mode = mode;
      persistTheme(mode);
      applyThemeToDocument(mode);
    },
    toggleTheme(): void {
      this.setTheme(this.mode === 'dark' ? 'light' : 'dark');
    },
    /** 清除用户显式偏好，恢复跟随系统（不写入 localStorage）。 */
    resetToSystem(): void {
      this.mode = getSystemTheme();
      applyThemeToDocument(this.mode);
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.removeItem(THEME_STORAGE_KEY);
        } catch {
          /* ignore */
        }
      }
    },
  },
});
