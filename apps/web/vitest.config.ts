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
    // 全仓并发执行 `pnpm test` 时，懒加载 Naive UI 页面组件（首次 transform + 大量
    // 按需引入的组件模块）偶发超过 Vitest 默认 5000ms 上限；单跑时因本地缓存命中而通过。
    // 这里统一放宽到 30s，并给 hook 留出同等预算，避免机器负载抖动导致的假失败。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Vitest 5 已移除 poolOptions，改为顶层 maxWorkers。
    // 并发跑全仓测试时限制线程数，避免与其它工作区抢占 CPU 造成偶发超时。
    maxWorkers: 4,
    // 预打包体积庞大的第三方依赖（naive-ui / 图标），把首次 transform 成本
    // 从测试执行阶段（计入 testTimeout）前移到依赖优化阶段并缓存复用。
    deps: {
      optimizer: {
        client: {
          enabled: true,
          include: ['naive-ui', '@vicons/ionicons5'],
        },
      },
    },
  },
});
