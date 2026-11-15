import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: { target: 'es2022' },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
