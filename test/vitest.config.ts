import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'path';

const nativeLoader = resolve(import.meta.dirname, '../packages/adapters/src/node/native.js');

export default defineConfig({
  plugins: [
    {
      name: 'resolve-generated-native-loader',
      resolveId(id, importer) {
        // Let unit tests mock the generated loader before the native build.
        // Tests without a mock still load the real file and require that build.
        if (importer && resolve(dirname(importer), id) === nativeLoader) {
          return nativeLoader;
        }
      },
    },
  ],
  test: {
    globals: true,
    testTimeout: 120000,
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@hls-downloader/shared': resolve(import.meta.dirname, '../packages/shared/src/index.ts'),
    },
  },
});
