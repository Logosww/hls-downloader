import { defineConfig } from 'tsdown';

export default defineConfig({
  format: 'esm',
  platform: 'neutral',
  minify: true,
  dts: {
    compilerOptions: {
      rootDir: 'src',
      isolatedDeclarations: true,
    },
  },
});
