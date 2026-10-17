import {
  emitAdapterEvent,
  HlsDownloaderEvent as Event,
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  type HlsDownloaderAdapterInternal,
  type HlsRecordingOutput,
  type HlsMultiTrackOptions,
  type HlsRecordingHost,
  type HlsEngineReport,
  type HlsOutputControl,
} from '@hls-downloader/shared';
import { runMultiTrack } from './multitrack';
import type { RecordingBridgeFactory } from './recording';
import { withOperation } from './operation';
import { validateTimeline } from './timeline';
import type { RequestOptions } from './renditions';

/** Finite facade: the public core owns borrowed stream close/abort. */
export async function finiteEngine(
  adapter: HlsDownloaderAdapterInternal,
  options: RequestOptions & { resume?: import('@hls-downloader/shared').HlsResumeOptions },
  output: HlsRecordingOutput,
  factory: RecordingBridgeFactory,
  write: (bytes: Uint8Array, index: string) => Promise<void> = async () => {},
  control?: HlsOutputControl,
): Promise<{ report: HlsEngineReport; totalSegments: number; blob?: Blob }> {
  if (options.transcode)
    throw new HlsDownloaderError(Code.UNSUPPORTED_OUTPUT, 'Engine streams cannot be transcoded');
  if (options.timeline)
    validateTimeline(
      options.timeline,
      output.type === 'files' || output.type === 'writables' || !!options.resume,
    );
  emitAdapterEvent(adapter, options, Event.STARTING_DOWNLOAD);
  return withOperation(
    options,
    async (request) => {
      let collected: Uint8Array | undefined;
      const host: HlsRecordingHost = {
        ready() {
          emitAdapterEvent(adapter, options, Event.SOURCE_PARSED);
        },
        async write(bytes, index) {
          if (output.type === 'blob') collected = bytes;
          else await write(bytes, index);
        },
        async control(r) {
          if (r.action === 'acquire') {
            if (control) return control({ action: 'acquire', output: r.output });
            if (output.type === 'file') return output.path;
            if (output.type === 'files') return output.acquire(r.output);
            return '';
          }
          const e = r.event;
          if (e.type === 'progress')
            emitAdapterEvent(adapter, options, Event.DOWNLOADING_SEGMENTS, {
              total: Number(e.input.discovered),
              completed: Number(e.input.committed),
            });
          if (e.type === 'output' && control)
            await control({ action: 'complete', output: e.output });
          return '';
        },
      };
      const timeline = options.timeline;
      const config = {
        ...request,
        output,
        limits: timeline?.limits && {
          samples: timeline.limits.samples,
          queuedDescriptors: timeline.limits.resources,
        },
        missingSegments:
          timeline && 'changePolicy' in timeline && timeline.changePolicy === 'split'
            ? 'split'
            : 'skip',
        embeddedAudio: options.audio ? 'exclude' : 'keep',
        audio: undefined,
        audioTracks: options.audio ? [{ id: 'audio', selector: options.audio }] : [],
        timeline: timeline && {
          range: timeline.range,
          gapPolicy: timeline.gapPolicy,
          changePolicy: 'changePolicy' in timeline ? timeline.changePolicy : undefined,
          tailDuration: timeline.tailDuration,
          anchors: timeline.epochAnchors?.map((a) => ({ ...a, generation: '0' })),
        },
      } as HlsMultiTrackOptions & RequestOptions;
      const { report } = await runMultiTrack(adapter, config, host, factory, true, true);

      return {
        report,
        totalSegments: report.inputs.reduce((n, i) => n + Number(i.committed), 0),
        ...(collected
          ? { blob: new Blob([Uint8Array.from(collected).buffer], { type: 'video/mp4' }) }
          : {}),
      };
    },
    adapter.name,
  );
}
