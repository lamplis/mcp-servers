import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/__tests__/**/*.test.ts'],
    setupFiles: ['./__tests__/setup.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    restoreMocks: true,
    env: {
      NODE_ENV: 'test',
    },
    coverage: {
      provider: 'v8',
      include: ['**/*.ts'],
      exclude: ['**/__tests__/**', '**/dist/**'],
    },
  },
  esbuild: {
    target: 'node18',
  },
});
