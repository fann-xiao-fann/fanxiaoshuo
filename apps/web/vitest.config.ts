import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

/** 前端单元测试配置：与 Vite 一致的路径别名，使用 happy-dom 提供 localStorage / document。 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@fanxiaoshuo/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/__tests__/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    css: false,
  },
});
