import { HlsDownloader } from '../packages/core/src';
import { BrowserAdapter } from '../packages/adapters/src/browser';
import { NodeAdapter } from '../packages/adapters/src/node';
import type {
  AudioSelection,
  Rendition,
  HlsDownloaderSubtitleResult,
} from '../packages/shared/src';
const audio: AudioSelection = { language: 'en' };
for (const adapter of [BrowserAdapter, NodeAdapter]) {
  const d = new HlsDownloader({ adapter });
  void d.download({ url: 'https://example.test/master.m3u8', audio });
  void d.downloadToStream({ url: 'https://example.test/master.m3u8', audio }, () => {});
  void d.downloadToWritable(
    { url: 'https://example.test/master.m3u8', audio },
    new WritableStream<Uint8Array>(),
  );
  const result: Promise<HlsDownloaderSubtitleResult> = d.downloadSubtitles({
    url: 'https://example.test/master.m3u8',
    subtitle: { groupId: 's', name: 'English' },
    audio,
  });
  void result;
  // @ts-expect-error a subtitle selection is required
  void d.downloadSubtitles({ url: 'https://example.test/master.m3u8' });
}
const rendition: Rendition = {
  type: 'audio',
  groupId: 'a',
  name: 'English',
  default: true,
  autoselect: true,
  forced: false,
};
void rendition;
