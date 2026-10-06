import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  selectBestVariant,
  type HlsDownloaderAdapterInternal,
  type HlsRecordingOptions,
  type HlsRecordingHost,
  type HlsRecordingCapabilities,
  type HlsRecordingReport,
  type HlsMediaPlaylist,
  type HlsDownloaderBrowserOperationOptions,
} from '@hls-downloader/shared';
import { executeKeyed, decryptionProfile, type KeyedEngine } from './keyed';
import { parseManifest, selectAudio, type SelectedMedia, type RequestOptions } from './renditions';
import { readBoundedResource } from './bounded';
import { assertActive, cancellable } from './browser/request';
import { camelCaseReport } from './timeline';

export function recordingCapabilities(browser: boolean): HlsRecordingCapabilities {
  return Object.freeze({
    inputs: Object.freeze(['vod', 'live', 'event'] as const),
    externalAudio: true,
    pause: 'vod',
    outputs: Object.freeze(
      browser
        ? (['writable', 'writables', 'blob'] as const)
        : (['writable', 'writables', 'file', 'files'] as const),
    ),
    split: true,
    ranges: true,
    methods: decryptionProfile.methods,
    resume: false,
    startPosition: 'window-start',
  });
}
export type RecordingBridge = {
  command(value: string): Promise<string>;
  run(): Promise<string>;
  dispose(): void;
};
export type RecordingBridgeFactory = (
  request: string,
  read: Parameters<KeyedEngine>[1],
  write: Parameters<KeyedEngine>[2],
  resolve: Parameters<KeyedEngine>[3],
  abort: Parameters<KeyedEngine>[4],
  control: (value: string) => Promise<string>,
) => Promise<RecordingBridge>;
export function checkRecording(value: string): any {
  const result = camelCaseReport(JSON.parse(value));
  if (result.error) {
    const { code, ...details } = result.error;
    throw new HlsDownloaderError(code, `Recording failed: ${details.reason ?? code}`, details);
  }
  return result;
}
export function recordingDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new HlsDownloaderError(Code.ABORTED, 'Operation aborted'));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
const emptyReport = (): HlsRecordingReport => ({
  schemaVersion: 1,
  endReason: 'Stop',
  inputs: [],
  bytesWritten: '0',
  duration: { ticks: '0', timescale: 1 },
  requestedRange: null,
  actualRange: null,
  gapCount: '0',
  outputs: [],
  mappings: [],
  historyTruncated: false,
  peaks: { queuedDescriptors: '0', queuedMetadataBytes: '0', samples: '0', sampleBytes: '0' },
});
type Snapshot = { url: string; text: string; metadata: HlsMediaPlaylist };

export async function runRecording(
  adapter: HlsDownloaderAdapterInternal,
  options: HlsRecordingOptions & HlsDownloaderBrowserOperationOptions,
  host: HlsRecordingHost,
  factory: RecordingBridgeFactory,
): Promise<{ report: HlsRecordingReport }> {
  const opts = options as HlsRecordingOptions & RequestOptions;
  const out = options.output;
  if (opts.transcode !== undefined || opts.resume !== undefined || opts.aria2 !== undefined)
    throw new HlsDownloaderError(
      Code.UNSUPPORTED_OUTPUT,
      'Recording does not support transcode, resume or aria2',
    );
  if (
    (options.missingSegments === 'split' || options.timeline?.changePolicy === 'split') &&
    !['files', 'writables'].includes(out.type)
  )
    throw new HlsDownloaderError(Code.UNSUPPORTED_OUTPUT, 'Split requires an output factory');
  if (out.type === 'blob' && (!Number.isSafeInteger(out.maxBytes) || out.maxBytes <= 0))
    throw new HlsDownloaderError(Code.RESOURCE_LIMIT_EXCEEDED, 'Blob recording requires maxBytes');
  for (const [name, value] of Object.entries(options.limits ?? {}))
    if (name !== 'maxSkew' && (!Number.isSafeInteger(value) || (value as number) <= 0))
      throw new HlsDownloaderError(Code.RESOURCE_LIMIT_EXCEEDED, 'Invalid recording limits');
  let stopped = false,
    finished = false,
    firstFailure: unknown;
  let bridge: RecordingBridge | undefined;
  let resolveBridge!: (bridge: RecordingBridge) => void;
  let rejectBridge!: (cause: unknown) => void;
  const bridgeReady = new Promise<RecordingBridge>((resolve, reject) => {
    resolveBridge = resolve;
    rejectBridge = reject;
  });
  void bridgeReady.catch(() => {});
  const initial = new AbortController();
  const lifetime = new AbortController();
  const lanes = new Map<
    string,
    {
      controller: AbortController;
      generation: string;
      revision: bigint;
      url: string;
      task?: Promise<void>;
      ended: boolean;
    }
  >();
  const tasks = new Set<Promise<unknown>>();
  const send = async (value: object) => {
    const pending = bridge!.command(JSON.stringify(value));
    track(pending);
    return checkRecording(await pending);
  };
  const stopPolling = () => {
    initial.abort();
    for (const lane of lanes.values()) lane.controller.abort();
  };
  const abort = () => {
    stopPolling();
    lifetime.abort();
    void bridge?.command('{"action":"cancel"}').catch(() => {});
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const fetchSnapshot = async (url: string, signal: AbortSignal): Promise<Snapshot> => {
    const resource = await readBoundedResource(
      { url },
      opts.decryption?.limits?.manifestBytes ?? 4 * 1024 * 1024,
      opts.headers,
      opts.maxRetry ?? adapter.segmentRetryAttempts,
      signal,
      Code.MANIFEST_FETCH_FAILED,
      opts.browserRequest,
    );
    const text = new TextDecoder().decode(resource.bytes);
    return {
      url: resource.url,
      text,
      metadata: await cancellable(adapter.parseMediaPlaylist!(text, resource.url), signal),
    };
  };
  const fail = (error: unknown) => {
    if (finished || stopped || options.signal?.aborted) return;
    firstFailure ??= error;
    abort();
  };
  const track = (promise: Promise<unknown>) => {
    tasks.add(promise);
    void promise.finally(() => tasks.delete(promise)).catch(() => {});
  };
  const poll = async (id: string, snapshot?: Snapshot) => {
    const lane = lanes.get(id)!;
    const signal = lane.controller.signal;
    let previous: string | undefined;
    try {
      while (!stopped && !finished && !lane.ended) {
        assertActive(signal);
        const current = snapshot ?? (await fetchSnapshot(lane.url, signal));
        snapshot = undefined;
        assertActive(signal);
        const revision = (lane.revision++).toString();
        const acceptance = send({
          action: 'accept',
          inputId: id,
          generation: lane.generation,
          revision,
          url: current.url,
          text: current.text,
        });
        track(acceptance);
        await cancellable(acceptance, signal);
        if (current.metadata.endList) {
          lane.ended = true;
          return;
        }
        const changed = previous !== current.text;
        previous = current.text;
        const seconds = Number(current.metadata.targetDuration);
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2147483647)
          throw new HlsDownloaderError(Code.MANIFEST_INVALID, 'Invalid target duration');
        await recordingDelay(seconds * (changed ? 1000 : 500), signal);
      }
    } catch (e) {
      if (!signal.aborted && !stopped && !finished) fail(e);
    }
  };
  host.ready({
    async command(value) {
      if (value.action === 'stop') {
        stopped = true;
        stopPolling();
        if (bridge) await send(value);
        return;
      }
      if (value.action === 'cancel') {
        abort();
        return;
      }
      await cancellable(bridgeReady, lifetime.signal);
      if (stopped || finished)
        throw new HlsDownloaderError(Code.RECORDING_FAILED, 'Recording closed', {
          reason: 'Closed',
        });
      if (value.action === 'end' || value.action === 'restart') {
        const lane = lanes.get(value.inputId!);
        if (!lane)
          throw new HlsDownloaderError(Code.RECORDING_FAILED, 'Unknown input', {
            reason: 'UnknownInput',
          });
        if (
          value.action === 'restart' &&
          (!/^(0|[1-9]\d*)$/.test(value.generation ?? '') ||
            BigInt(value.generation!) <= BigInt(lane.generation) ||
            BigInt(value.generation!) > 18446744073709551615n)
        )
          throw new HlsDownloaderError(Code.RECORDING_FAILED, 'Invalid generation', {
            reason: 'GenerationMismatch',
          });
        if (value.url !== undefined) new URL(value.url);
        // Seal before aborting a pending old-generation admission.
        await send(value);
        lane.controller.abort();
        await lane.task;
        if (value.action === 'end') {
          lane.ended = true;
          return;
        }
        lane.generation = value.generation!;
        lane.revision = 0n;
        lane.ended = false;
        lane.url = value.url ?? lane.url;
        lane.controller = new AbortController();
        lane.task = poll(value.inputId!);
        track(lane.task);
        return;
      }
      await send(value);
    },
  });
  try {
    assertActive(options.signal);
    let url = options.url;
    let audioUrl: string | undefined;
    let primary!: Snapshot;
    const visited = new Set<string>();
    for (let depth = 0; depth <= 8; depth++) {
      assertActive(initial.signal);
      if (visited.has(url))
        throw new HlsDownloaderError(Code.MANIFEST_INVALID, 'Master playlist cycle');
      visited.add(url);
      const resource = await readBoundedResource(
        { url },
        opts.decryption?.limits?.manifestBytes ?? 4 * 1024 * 1024,
        opts.headers,
        opts.maxRetry ?? adapter.segmentRetryAttempts,
        initial.signal,
        Code.MANIFEST_FETCH_FAILED,
        opts.browserRequest,
      );
      const text = new TextDecoder().decode(resource.bytes);
      if (/^\s*#EXT-X-STREAM-INF:/m.test(text)) {
        const parsed = parseManifest(text, resource.url);
        if (parsed.type !== 'playlist')
          throw new HlsDownloaderError(Code.MANIFEST_INVALID, 'Invalid master');
        const variant = selectBestVariant(parsed.data, opts.variant);
        if (!variant) throw new HlsDownloaderError(Code.NO_VARIANT, 'No variant available');
        if (variant.videoGroup)
          throw new HlsDownloaderError(Code.UNSUPPORTED_RENDITION, 'Alternate video unavailable');
        if (variant.audioGroup !== undefined || opts.audio)
          audioUrl = selectAudio(parsed.renditions ?? [], variant.audioGroup, opts.audio)?.uri;
        url = variant.uri;
        continue;
      }
      primary = {
        url: resource.url,
        text,
        metadata: await cancellable(
          adapter.parseMediaPlaylist!(text, resource.url),
          initial.signal,
        ),
      };
      break;
    }
    if (!primary) throw new HlsDownloaderError(Code.MANIFEST_INVALID, 'Master recursion limit');
    if (options.audio && visited.size === 1)
      throw new HlsDownloaderError(Code.RENDITION_NOT_FOUND, 'Audio selection requires a master');
    const audio = audioUrl ? await fetchSnapshot(audioUrl, initial.signal) : undefined;
    if (stopped) return { report: emptyReport() };
    const snapshots = [['primary', primary], ...(audio ? [['audio', audio]] : [])] as [
      string,
      Snapshot,
    ][];
    const vod = snapshots.every(
      ([, s]) => s.metadata.endList && s.metadata.playlistType !== 'Event',
    );
    const media: SelectedMedia = {
      primary: { ...primary, segments: [] },
      audio: audio && { ...audio, segments: [] },
      subtitles: [],
      totalSegments: 0,
    };
    const engine: KeyedEngine = async (request, read, write, resolve, abortRead) => {
      const wire = JSON.parse(request);
      const recording = {
        vod,
        outputType: out.type,
        format: 'format' in out ? (out.format ?? 'mp4') : 'fmp4',
        maxBytes: out.type === 'blob' ? out.maxBytes : undefined,
        durationLimit: options.durationLimit,
        missingSegments: options.missingSegments,
        limits: options.limits ?? {},
        timeline: options.timeline ?? {},
      };
      bridge = await factory(
        JSON.stringify({ ...wire, timeline: undefined, bridgeVersion: 1, recording }),
        read,
        write,
        resolve,
        abortRead,
        async (text) => {
          const r = camelCaseReport(JSON.parse(text));
          if (r.action === 'wait') {
            await recordingDelay(Number(r.ms), lifetime.signal);
            return '';
          }
          if (
            r.action === 'event' &&
            r.event.type === 'state' &&
            ['draining', 'finalizing', 'completed', 'failed', 'cancelled'].includes(r.event.state)
          )
            stopPolling();
          return host.control(r);
        },
      );
      const running = bridge.run();
      void running.catch(() => {});
      for (const [id, snapshot] of snapshots)
        lanes.set(id, {
          controller: new AbortController(),
          generation: '0',
          revision: 0n,
          url: snapshot.url,
          ended: false,
        });
      resolveBridge(bridge);
      if (options.signal?.aborted || lifetime.signal.aborted) await send({ action: 'cancel' });
      else if (stopped) await send({ action: 'stop' });
      else
        for (const [id, snapshot] of snapshots) {
          const lane = lanes.get(id)!;
          lane.task = poll(id, snapshot);
          track(lane.task);
        }
      try {
        const result = await running;
        if (firstFailure) throw firstFailure;
        return result;
      } finally {
        finished = true;
        stopPolling();
        lifetime.abort();
        await Promise.allSettled([...tasks]);
        bridge.dispose();
      }
    };
    return (await executeKeyed(
      adapter,
      { ...opts, timeline: undefined, signal: options.signal! },
      media,
      engine,
      'continuous',
      (bytes, index) => host.write(bytes, index ?? '0'),
    )) as unknown as { report: HlsRecordingReport };
  } catch (e) {
    rejectBridge(e);
    if (stopped && !bridge && !options.signal?.aborted) return { report: emptyReport() };
    throw firstFailure ?? e;
  } finally {
    finished = true;
    stopPolling();
    lifetime.abort();
    options.signal?.removeEventListener('abort', abort);
  }
}
