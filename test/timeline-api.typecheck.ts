import { HlsDownloader } from '../packages/core/src/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import {
  exportChapters,
  type HlsKeyResolver,
  type HlsTimelineReport,
} from '../packages/shared/src/index';
const browser = new HlsDownloader({ adapter: BrowserAdapter });
const node = new HlsDownloader({ adapter: NodeAdapter });
const timeline = {
  range: { start: { ticks: '1', timescale: 1 }, end: { ticks: '4', timescale: 1 } },
};
const resolver: HlsKeyResolver = async (request) => {
  const method: 'AES-128' | 'SAMPLE-AES' | 'SAMPLE-AES-CTR' = request.method;
  const kid: string | undefined = request.kid;
  void method;
  void kid;
  return { key: new Uint8Array(16) };
};
async function check(report: HlsTimelineReport) {
  const a = await browser.download({ url: 'x', timeline, decryption: { keyResolver: resolver } });
  const blob: string = a.blobURL;
  void blob;
  const b = await node.downloadOutputs({
    url: 'x',
    timeline: { ...timeline, changePolicy: 'split' },
  });
  const file: string = b.outputs[0]!.filePath;
  void file;
  await browser.downloadToWritables(
    { url: 'x', timeline: { changePolicy: 'split' } },
    async (descriptor) => {
      const i: string = descriptor.index;
      void i;
      return new WritableStream<Uint8Array>();
    },
  );
  await browser.downloadSubtitleOutputs({
    url: 'x',
    subtitle: { groupId: 's', name: 'en' },
    timelineReport: report,
  });
  exportChapters({
    timelineReport: report,
    chapters: [{ range: timeline.range, title: 'chapter' }],
  });
  // @ts-expect-error split requires a multi-output method
  await browser.download({ url: 'x', timeline: { changePolicy: 'split' } });
  await node.download({
    url: 'x',
    // @ts-expect-error protocol ticks are strings
    timeline: { range: { start: { ticks: 0, timescale: 1 }, end: { ticks: '1', timescale: 1 } } },
  });
  // @ts-expect-error no recovery on new output APIs
  await node.downloadOutputs({ url: 'x', resume: { directory: 'x' } });
  await browser.downloadToWritables(
    // @ts-expect-error no transcode on new output APIs
    { url: 'x', transcode: { preset: 'h264' } },
    async () => new WritableStream(),
  );
}
void check;
