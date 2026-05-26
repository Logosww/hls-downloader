import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 120000,
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@hls-downloader/shared': resolve(__dirname, '../packages/shared/src/index.ts'),
    },
  },
});
