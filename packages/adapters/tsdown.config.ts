import { defineConfig } from 'tsdown';

const externalFFmpegBase = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist`;
const externalFFmpegMtBase = `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist`;

const sharedDts = {
  compilerOptions: {
    rootDir: 'src',
    isolatedDeclarations: true,
    stripInternal: true,
  },
};

export default defineConfig([
  {
    entry: { wasm: 'src/wasm/index.ts' },
    format: 'esm',
    platform: 'browser',
    minify: true,
    deps: {
      alwaysBundle: ['m3u8-parser', '@ffmpeg/util', 'p-limit'],
    },
    dts: sharedDts,
    define: {
      __FFmpeg_Base__: JSON.stringify(externalFFmpegBase),
      __FFmpeg_Mt_Base__: JSON.stringify(externalFFmpegMtBase),
    },
    inputOptions: {
      resolve: {
        mainFields: ['module', 'main'],
      },
    },
  },
  {
    entry: { rust: 'src/rust/index.ts' },
    format: 'esm',
    platform: 'node',
    minify: true,
    deps: {
      neverBundle: [/native/],
    },
    dts: sharedDts,
  },
]);
