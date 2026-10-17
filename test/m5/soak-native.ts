import { HlsDownloader, NodeAdapter } from '../../dist/index.js';
import { readdirSync } from 'node:fs';
import { beginSoak, type SoakConfig } from './soak-client.ts';

const config: SoakConfig = JSON.parse(process.argv[2]!);
function resources() {
  const fdDirectory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  return {
    descriptors: process.platform === 'win32' ? null : readdirSync(fdDirectory).length,
    active: process.getActiveResourcesInfo().sort(),
  };
}
const initial = resources();
let before: ReturnType<typeof resources> | undefined;
const operation = beginSoak(new HlsDownloader({ adapter: NodeAdapter }), config);
const sample = () => {
  const metrics = operation.snapshot();
  const current = resources();
  if (metrics.committed > 0) before ??= current;
  process.send?.({
    type: 'sample',
    sample: { ...metrics, ...process.memoryUsage(), descriptors: current.descriptors },
  });
};
const cancel = () => operation.cancel();
process.on('SIGTERM', cancel);
process.on('SIGINT', cancel);
process.on('message', (message) => {
  if (message === 'cancel') cancel();
});
process.on('disconnect', cancel);
sample();
const timer = setInterval(sample, config.sampleMs);
try {
  const result = await operation.result;
  clearInterval(timer);
  sample();
  await new Promise((r) => setTimeout(r, 1500));
  globalThis.gc?.();
  const after = resources();
  const leftovers = readdirSync(process.cwd());
  if (!before) throw Error('Missing active recording resource baseline');
  if (before.descriptors !== null && after.descriptors! > before.descriptors + 4)
    throw Error('Native descriptors grew after completion');
  if (after.active.includes('ProcessWrap')) throw Error('Unexpected native child process remains');
  if (leftovers.length)
    throw Error('Native recording left temporary files: ' + leftovers.join(', '));
  await new Promise<void>((resolve, reject) =>
    process.send!(
      {
        type: 'result',
        result,
        cleanup: { initial, before, after, leftovers },
        version: process.version,
      },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
} catch (error) {
  await new Promise<void>((resolve) =>
    process.send?.({ type: 'error', error: String(error) + '\n' + JSON.stringify(error) }, () =>
      resolve(),
    ),
  );
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  process.off('SIGTERM', cancel);
  process.off('SIGINT', cancel);
  if (process.connected) process.disconnect?.();
}
