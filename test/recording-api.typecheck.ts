import { HlsDownloader } from '../packages/core/src/index';
import { BrowserAdapter } from '../packages/adapters/src/browser';
import { NodeAdapter } from '../packages/adapters/src/node';
const browser = new HlsDownloader({ adapter: BrowserAdapter });
const node = new HlsDownloader({ adapter: NodeAdapter });
const blob = browser.startRecording({
  url: 'https://example.test/live.m3u8',
  output: { type: 'blob', maxBytes: 1024 },
});
blob.result.then((r) => {
  const b: Blob = r.blob;
  void b;
});
const file = node.startRecording({
  url: 'https://example.test/live.m3u8',
  output: { type: 'file', path: 'capture.mp4' },
});
file.result.then((r) => {
  const path: string = r.filePath;
  void path;
});
// @ts-expect-error bounded memory requires an explicit capacity
browser.startRecording({ url: 'https://example.test/live.m3u8', output: { type: 'blob' } });
node.startRecording({
  url: 'https://example.test/live.m3u8',
  // @ts-expect-error recording does not transcode
  transcode: { preset: 'h264' },
  output: { type: 'file', path: 'capture.mp4' },
});
// @ts-expect-error wide generation must be lossless
blob.restartInput('primary', { generation: 1 });
blob.restartInput('primary', { generation: '9007199254740993' });
// @ts-expect-error state is read only
blob.state = 'paused';

browser.startRecording({
  url: 'https://example.test/a',
  // @ts-expect-error Browser cannot publish native files
  output: { type: 'file', path: 'capture.mp4' },
});
// @ts-expect-error Node recording does not expose Browser Blob output
node.startRecording({ url: 'https://example.test/a', output: { type: 'blob', maxBytes: 1024 } });
