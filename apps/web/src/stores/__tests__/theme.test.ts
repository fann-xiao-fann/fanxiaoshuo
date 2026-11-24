import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  getSystemTheme,
  resolveInitialTheme,
  useThemeStore,
} from '@/stores/theme';

function mockSystemDark(isDark: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: isDark && query.includes('dark'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useThemeStore', () => {
  it('切换主题时写入 localStorage 并同步 html class', () => {
    const store = useThemeStore();
    expect(store.isDark).toBe(false);

    store.setTheme('dark');

    expect(store.mode).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--fx-bg-body')).toBe('#0b0f14');

    store.toggleTheme();

    expect(store.mode).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--fx-bg-body')).toBe('#f5f7fa');
  });

  it('初始化时优先读取已持久化的暗色偏好', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    setActivePinia(createPinia());

    const store = useThemeStore();
    expect(store.mode).toBe('dark');
    expect(store.isDark).toBe(true);

    store.applyTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('持久化值非法时跟随系统偏好', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    mockSystemDark(true);
    expect(resolveInitialTheme()).toBe('dark');
  });

  it('无持久化偏好且系统为浅色时默认浅色', () => {
    mockSystemDark(false);
    expect(getSystemTheme()).toBe('light');
    setActivePinia(createPinia());
    expect(useThemeStore().mode).toBe('light');
  });

  it('resetToSystem 移除显式偏好并跟随系统', () => {
    const store = useThemeStore();
    store.setTheme('dark');
    mockSystemDark(false);

    store.resetToSystem();

    expect(store.mode).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('applyThemeToDocument 可独立用于首屏校准', () => {
    applyThemeToDocument('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.backgroundColor).toBeTruthy();
  });
});
