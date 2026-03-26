import { defineConfig, type Rolldown } from 'tsdown';
import { copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ADAPTERS_DIST = 'packages/adapters/dist';

function nativeAdapterPlugin(): Rolldown.Plugin {
  return {
    name: 'native-adapter',
    resolveId(source) {
      if (/native\.js/.test(source)) {
        return { id: './native.js', external: true };
      }
    },
    writeBundle(options) {
      const outDir = options.dir ?? 'dist';
      for (const f of readdirSync(ADAPTERS_DIST)) {
        if (f.startsWith('native')) {
          copyFileSync(join(ADAPTERS_DIST, f), join(outDir, f));
        }
      }
    },
  };
}

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    core: 'src/core.ts',
    shared: 'src/shared.ts',
    'adapters-wasm': 'src/adapters-wasm.ts',
    'adapters-rust': 'src/adapters-rust.ts',
  },
  format: 'esm',
  platform: 'neutral',
  minify: true,
  plugins: [nativeAdapterPlugin()],
  deps: {
    neverBundle: [/^@ffmpeg\/ffmpeg/, /^node:/],
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
