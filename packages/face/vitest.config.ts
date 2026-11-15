import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.browser.test.ts'],
          environment: 'node',
        },
      },
      {
        // End to end with real browsers and the real camera path (fake devices), from Node.
        test: {
          name: 'e2e',
          include: ['e2e/**/*.e2e.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Browser tests load the real engine from assets prepared by copy-assets
        // (scripts/prepare-test-assets.mjs, run by `pnpm test` before Vitest starts).
        publicDir: '.test-assets',
        test: {
          name: 'browser',
          include: ['test/**/*.browser.test.ts'],
          testTimeout: 60_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
          },
        },
      },
    ],
  },
});
