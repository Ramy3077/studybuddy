import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Shared Postgres -> run test files sequentially for determinism.
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
