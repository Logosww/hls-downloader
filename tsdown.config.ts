import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'neutral',
  minify: true,
  deps: {
    neverBundle: [/^@hls-downloader\//],
  },
  dts: {
    compilerOptions: {
      rootDir: 'src',
      isolatedDeclarations: true,
      stripInternal: true,
    },
  },
});
