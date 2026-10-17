import { HlsDownloader } from '../packages/core/src/index';
import { NodeAdapter, type NodeAdapterResumeOptions } from '../packages/adapters/src/node/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
const resume: NodeAdapterResumeOptions = { directory: './task' };
const node = new HlsDownloader({ adapter: NodeAdapter });
node.download({ url: 'https://example.test/media.m3u8', resume });
// @ts-expect-error Recovery storage is not a global option.
new HlsDownloader({ adapter: NodeAdapter, options: { resume } });
// @ts-expect-error Streaming callbacks cannot resume file output.
node.downloadToStream({ url: 'https://example.test/media.m3u8', resume }, () => {});
const browser = new HlsDownloader({ adapter: BrowserAdapter });
// @ts-expect-error Node-only download options must not leak into Browser.
browser.download({ url: 'https://example.test/media.m3u8', resume });
browser.downloadToWritable(
  // @ts-expect-error Writable output cannot resume file output.
  { url: 'https://example.test/media.m3u8', resume },
  new WritableStream(),
);

node.startRecording({
  url: 'https://example.test/live.m3u8',
  output: { type: 'file', path: 'capture.mp4' },
  resume: { directory: './job', durability: 'sync-all' },
});
node.downloadMultiTrack({
  url: 'x',
  embeddedAudio: 'keep',
  output: { type: 'file', path: 'x.mp4' },
  resume: { directory: 'job', durability: 'flush' },
});
browser.startRecording({
  url: 'x',
  output: { type: 'blob', maxBytes: 1024 },
  // @ts-expect-error Only deterministic Node file paths support recovery.
  resume: { directory: 'job' },
});
node.startRecording({
  url: 'x',
  output: { type: 'files', acquire: async () => 'x.mp4' },
  // @ts-expect-error Only deterministic Node file paths support recovery.
  resume: { directory: 'job' },
});
node.downloadMultiTrack({
  url: 'x',
  embeddedAudio: 'keep',
  output: { type: 'writables', acquire: async () => new WritableStream() },
  // @ts-expect-error Only deterministic Node file paths support recovery.
  resume: { directory: 'job' },
});
node.queryCapability({
  inputs: [
    { id: 'primary', container: 'packed-aac', encryption: 'AES-256-GCM', codecs: ['aac-lc'] },
  ],
  output: 'file-fmp4',
  experimentalGcm: true,
  resume: true,
});
