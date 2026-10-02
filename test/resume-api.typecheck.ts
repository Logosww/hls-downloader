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
