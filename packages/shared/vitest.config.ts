import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: ['default'],
    // 全仓并发 `pnpm test` 时与其它工作区争抢 CPU，统一放宽超时避免假失败。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    typecheck: {
      enabled: false,
    },
  },
});
