import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: ['default'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    typecheck: {
      enabled: false,
    },
  },
});
