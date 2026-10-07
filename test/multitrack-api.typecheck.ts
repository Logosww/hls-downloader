import { HlsDownloader } from '../packages/core/src/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
const browser = new HlsDownloader({ adapter: BrowserAdapter });
const node = new HlsDownloader({ adapter: NodeAdapter });
const blob = browser.downloadMultiTrack({
  url: '',
  embeddedAudio: 'keep',
  output: { type: 'blob', maxBytes: 1 },
});
blob.then((r) => {
  const b: Blob = r.blob;
  const kind: 'video' | 'audio' | 'subtitle' = r.report.tracks[0]!.kind;
});
const file = node.downloadMultiTrack({
  url: '',
  embeddedAudio: 'exclude',
  output: { type: 'file', path: 'out.mp4' },
  audioTracks: [{ id: 'en', selector: { language: 'en' } }],
});
file.then((r) => {
  const path: string = r.filePath;
});
const session = node.startMultiTrackRecording({
  url: '',
  embeddedAudio: 'keep',
  output: { type: 'writable', writable: new WritableStream<Uint8Array>() },
});
session.endInput('arbitrary-media-id');
session.restartInput('arbitrary-media-id', { generation: '2' });
// @ts-expect-error Browser cannot write native paths.
browser.downloadMultiTrack({ url: '', embeddedAudio: 'keep', output: { type: 'file', path: 'x' } });
// @ts-expect-error Node has no Blob output.
node.downloadMultiTrack({ url: '', embeddedAudio: 'keep', output: { type: 'blob', maxBytes: 1 } });
// @ts-expect-error Embedded audio choice is mandatory.
browser.downloadMultiTrack({ url: '', output: { type: 'blob', maxBytes: 1 } });
browser.downloadMultiTrack({
  url: '',
  embeddedAudio: 'keep',
  // @ts-expect-error No legacy replacement-audio option.
  audio: { language: 'en' },
  output: { type: 'blob', maxBytes: 1 },
});
// @ts-expect-error Blob memory cap is mandatory.
browser.downloadMultiTrack({ url: '', embeddedAudio: 'keep', output: { type: 'blob' } });
