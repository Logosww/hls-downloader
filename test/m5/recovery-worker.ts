import { HlsDownloader, NodeAdapter } from '../../dist/index.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const config = JSON.parse(process.argv[2]!);
let committed = 0;
const options = {
  url: config.url,
  maxRetry: 3,
  retryDelay: 50,
  embeddedAudio: 'keep' as const,
  limits: {
    historyEntries: 16,
    queuedDescriptors: 32,
    queuedMetadataBytes: config.budget ?? 2 * 1024 ** 2,
  },
  output: {
    type: 'file' as const,
    path: join(config.directory, 'recording.mp4'),
    format: 'fmp4' as const,
  },
  subtitleTracks: [
    {
      id: 'captions',
      selector: { groupId: 's', name: 'English' },
      embedded: false,
      sidecar: { type: 'file' as const, path: join(config.directory, 'recording.vtt') },
    },
  ],
  resume: { directory: join(config.directory, 'checkpoint') },
  decryption: {
    keyResolver: async (request: any) => ({
      key: Buffer.alloc(16, config.rotating && Number(request.uri.split('-').at(-1)) % 2 ? 9 : 7),
      version: 'm5-fixed-v1',
    }),
  },
  onEvent(event: any) {
    if (event.type === 'progress' && event.input.inputId === 'primary')
      committed = Number(event.input.committed);
  },
};
const sample = () => {
  const file = join(config.directory, 'checkpoint/engine-state.json');
  const bytes = existsSync(file) ? readFileSync(file) : undefined;
  const state = bytes && JSON.parse(bytes.toString());
  process.send?.({
    type: 'sample',
    committed,
    ...process.memoryUsage(),
    checkpointBytes: bytes?.length ?? 0,
    journalBytes: state ? Buffer.byteLength(JSON.stringify(state.journal)) : 0,
    descriptors:
      process.platform === 'win32'
        ? null
        : readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length,
  });
};
const session = new HlsDownloader({ adapter: NodeAdapter }).startMultiTrackRecording(options);
const timer = setInterval(sample, 1000);
const cancel = () => session.cancel();
process.on('SIGTERM', cancel);
process.on('disconnect', cancel);
try {
  const result = await session.result;
  if (config.budget) throw Error('Journal exhaustion unexpectedly completed');
  sample();
  process.send?.({ type: 'result', report: result.report });
} catch (error) {
  sample();
  const expected =
    config.budget &&
    committed > 0 &&
    (error as any).code === 'RESOURCE_LIMIT_EXCEEDED' &&
    JSON.stringify(error).includes('RecoveryReplayBudget');
  process.send?.({
    type: expected ? 'budget' : 'error',
    error: String(error),
    detail: JSON.stringify(error),
    committed,
  });
  if (!expected) process.exitCode = 1;
} finally {
  clearInterval(timer);
  process.off('SIGTERM', cancel);
  process.off('disconnect', cancel);
  if (process.connected) process.disconnect?.();
}
