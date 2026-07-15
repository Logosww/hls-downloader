import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    core: 'src/core.ts',
    shared: 'src/shared.ts',
    'adapters-browser': 'src/adapters-browser.ts',
    'adapters-node': 'src/adapters-node.ts',
  },
  format: 'esm',
  platform: 'neutral',
  minify: true,
  deps: {
    neverBundle: [/^@hls-downloader\//, /^node:/],
  },
  inputOptions: {
    resolve: {
      mainFields: ['module', 'main'],
      conditionNames: ['import', 'default'],
    },
  },
  dts: {
    compilerOptions: {
      rootDir: 'src',
      isolatedDeclarations: true,
      stripInternal: true,
    },
  },
});
