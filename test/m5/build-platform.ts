// Portable assembly for the six-host acceptance workflow. No publication.
import { cpSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evidence, root, pnpmArgs, pnpmCommand } from './harness.ts';
const e = evidence('platform-build');
await e.finish(async () => {
  for (const [name, script] of [
    ['shared', 'build'],
    ['core', 'build'],
    ['adapters', 'build:wasm'],
    ['adapters', 'build:ts'],
  ]) {
    await e.run(
      `${name}-${script!.replace(':', '-')}`,
      pnpmCommand(),
      pnpmArgs(['--filter', `@hls-downloader/${name}`, 'run', script!]),
      { timeoutMs: 1800_000 },
    );
  }
  const dist = join(root, 'packages/adapters/dist');
  for (const name of readdirSync(join(root, 'packages/adapters/src/node')).filter(
    (f) => /^native\..*\.(node|js|ts)$/.test(f) || f === 'native.js',
  )) {
    cpSync(join(root, 'packages/adapters/src/node', name), join(dist, name));
  }
  cpSync(
    join(root, 'packages/adapters/src/browser/generated/hls_transmux_browser_wasm_bg.wasm'),
    join(dist, 'hls_transmux_browser_wasm_bg.wasm'),
  );
  for (const name of ['index.mjs', 'index.d.mts'])
    writeFileSync(
      join(dist, name),
      'export * from "@hls-downloader/shared";\nexport * from "./browser.mjs";\nexport * from "./node.mjs";\n',
    );
  await e.run('root', pnpmCommand(), pnpmArgs(['run', 'build:root']));
});
