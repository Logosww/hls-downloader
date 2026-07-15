import { defineConfig } from 'tsdown';

const sharedDts = {
  compilerOptions: {
    rootDir: 'src',
    isolatedDeclarations: true,
    stripInternal: true,
  },
};

export default defineConfig([
  {
    entry: { browser: 'src/browser/index.ts' },
    format: 'esm',
    platform: 'browser',
    minify: true,
    deps: {
      alwaysBundle: ['m3u8-parser', 'p-limit', 'mediabunny'],
    },
    dts: sharedDts,
    inputOptions: {
      resolve: {
        mainFields: ['module', 'main'],
      },
    },
  },
  {
    entry: { node: 'src/node/index.ts' },
    format: 'esm',
    platform: 'node',
    minify: true,
    deps: {
      neverBundle: [/native/],
    },
    dts: sharedDts,
  },
]);
