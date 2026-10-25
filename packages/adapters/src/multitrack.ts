import {
  createTimelineRecorder,
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  selectBestVariant,
  type HlsDownloaderAdapterInternal,
  type HlsMediaPlaylist,
  type HlsDownloaderBrowserOperationOptions,
} from '@hls-downloader/shared';
import { executeKeyed, decryptionProfile, type KeyedEngine } from './keyed';
import { parseManifest, selectAudio, type SelectedMedia, type RequestOptions } from './renditions';
import { createSidecars } from './sidecars';
import { readBoundedResource } from './bounded';
import { assertActive, cancellable } from './browser/request';
import { camelCaseReport } from './timeline';

import {
  recordingDelay,
  checkRecording,
  type RecordingBridge,
  type RecordingBridgeFactory,
} from './recording';
import { parseEmbeddedWebVtt } from './multitrack-subtitles';
import type {
  HlsMultiTrackOptions,
  HlsMultiTrackHost,
  HlsMultiTrackReport,
  HlsMultiTrackCapabilities,
  HlsTrackMetadata,
  Rendition,
} from '@hls-downloader/shared';

function subtitleFingerprint(segment: HlsMediaPlaylist['segments'][number]): string {
  // Declaration ordinals are local to a playlist snapshot. Sliding windows
  // renumber unchanged keys, including a MAP's captured key context.
  const stableKeys = (keys: typeof segment.keys) =>
    keys.map(({ declaration: _declaration, ...key }) => key);
  return JSON.stringify({
    ...segment,
    keys: stableKeys(segment.keys),
    map: segment.map && { ...segment.map, keys: stableKeys(segment.map.keys) },
  });
}

export function multiTrackCapabilities(browser: boolean): HlsMultiTrackCapabilities {
  return Object.freeze({
    inputs: Object.freeze(['vod', 'live', 'event'] as const),
    containers: Object.freeze(['ts', 'fmp4', 'packed-aac'] as const),
    maxMediaInputs: 32,
    maxSubtitleTracks: 32,
    subtitles: 'wvtt-plain-text',
    subtitleResources: Object.freeze(['clear', 'AES-128'] as const),
    subtitleSidecars: Object.freeze({
      outputs: Object.freeze(
        browser
          ? (['writable', 'writables'] as const)
          : (['writable', 'writables', 'file'] as const),
      ),
      resume: !browser,
    }),
    decryption: Object.freeze({
      methods: decryptionProfile.methods,
      profiles: decryptionProfile.profiles,
    }),
    outputs: Object.freeze(
      browser
        ? (['blob', 'writable', 'writables'] as const)
        : (['file', 'files', 'writable', 'writables'] as const),
    ),
    pause: 'vod',
    split: true,
    ranges: true,
    resume: !browser,
  });
}
const emptyReport = (): HlsMultiTrackReport => ({
  configurationId: [],
  tracks: [],
  subtitleReports: [],
  trackHistoryTruncated: false,
  subtitleHistoryTruncated: false,
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

export async function runMultiTrack(
  adapter: HlsDownloaderAdapterInternal,
  options: HlsMultiTrackOptions & HlsDownloaderBrowserOperationOptions,
  host: HlsMultiTrackHost,
  factory: RecordingBridgeFactory,
  finite: boolean,
  automaticAudio = false,
): Promise<{ report: HlsMultiTrackReport }> {
  const opts = options as HlsMultiTrackOptions & RequestOptions;
  const timelineRecorder = createTimelineRecorder(
    options.limits?.historyEntries ?? 128,
    options.timeline?.gapPolicy === 'collapse',
  );
  const completed: import('@hls-downloader/shared').HlsEngineOutputReport[] = [];
  const outputPaths = new Map<string, string>();
  const describeOutput = (output: import('@hls-downloader/shared').HlsEngineOutputReport) => {
    const filePath =
      outputPaths.get(output.index) ??
      (opts.resume && options.output.type === 'file'
        ? options.output.path +
          (output.index === '0' ? '' : `.part-${output.index.padStart(6, '0')}.mp4`)
        : undefined);
    return { ...output, ...(filePath ? { filePath } : {}) };
  };
  const originalHost = host;
  host = {
    ...host,
    control: async (r) => {
      if (r.action === 'event') timelineRecorder.event(r.event as any);
      if (r.action === 'event' && r.event.type === 'output') {
        r.event.output = describeOutput(r.event.output);
        if (completed.length >= (options.limits?.historyEntries ?? 128))
          outputPaths.delete(completed.shift()!.index);
        completed.push(r.event.output);
      }
      const result = await originalHost.control(r);
      if (r.action === 'acquire' && result && ['file', 'files'].includes(options.output.type))
        outputPaths.set(r.output.index, result);
      return result;
    },
  };
  const out = options.output;
  if (opts.resume && out.type !== 'file')
    throw new HlsDownloaderError(Code.UNSUPPORTED_OUTPUT, 'Recovery requires a native file path');
  validateSelection(options);
  const sidecars = createSidecars(options, !!factory.inspectRecovery);
  if (opts.transcode !== undefined || opts.aria2 !== undefined)
    throw new HlsDownloaderError(
      Code.UNSUPPORTED_OUTPUT,
      'Engine output does not support transcode or aria2',
    );
  if (
    (options.missingSegments === 'split' || options.timeline?.changePolicy === 'split') &&
    !['files', 'writables'].includes(out.type) &&
    !(opts.resume && out.type === 'file')
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
      snapshot?: Snapshot;
    }
  >();
  const tasks = new Set<Promise<unknown>>();
  type TextLane = {
    id: string;
    timelineInputId: string;
    url: string;
    controller: AbortController;
    generation: string;
    revision: bigint;
    lastSequence?: bigint;
    seen: Map<string, string>;
    cueKeys: Set<string>;
    references: Map<string, bigint>;
    ended: boolean;
    task?: Promise<void>;
  };
  const textLanes = new Map<string, TextLane>();
  let textLock: Promise<void> = Promise.resolve();
  let pendingText: Promise<void> | undefined;
  let outputReady: Promise<unknown> = Promise.resolve();
  const send = async (value: object) => {
    const pending = bridge!.command(JSON.stringify(value));
    track(pending);
    return checkRecording(await pending);
  };
  const stopPolling = () => {
    initial.abort();
    for (const lane of lanes.values()) lane.controller.abort();
    for (const lane of textLanes.values()) lane.controller.abort();
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
  const prepareText = (
    lane: TextLane,
    snapshot?: Snapshot,
    initialAdmission = false,
  ): Promise<void> => {
    const task = textLock.then(async () => {
      if (lane.ended || stopped || finished || pendingText) return;
      const signal = lane.controller.signal;
      assertActive(signal);
      assertActive(options.signal);
      await cancellable(outputReady, signal);
      const current = snapshot ?? (await fetchSnapshot(lane.url, signal));
      if (
        current.metadata.segments.some((segment) =>
          [...segment.keys, ...(segment.map?.keys ?? [])].some((key) => key.method !== 'AES-128'),
        )
      )
        throw new HlsDownloaderError(
          Code.UNSUPPORTED_ENCRYPTION,
          'WebVTT supports only clear or AES-128 resources',
        );
      const mediaLane = lanes.get(lane.timelineInputId)!;
      const generation = mediaLane.generation;
      if (lane.generation !== generation) {
        lane.generation = generation;
        lane.seen.clear();
        lane.cueKeys.clear();
        lane.references.clear();
        lane.lastSequence = undefined;
        lane.revision = 0n;
      }
      const indices: number[] = [];
      const seen = new Map<string, string>();
      const epochs = new Set(mediaLane.snapshot?.metadata.segments.map((s) => s.epoch));
      for (const [index, segment] of current.metadata.segments.entries()) {
        if (!epochs.has(segment.epoch))
          throw new HlsDownloaderError(
            Code.SUBTITLE_INVALID,
            'Subtitle epoch has no bound media mapping',
            { inputId: lane.id, epoch: segment.epoch, reason: 'MissingSubtitleMapping' },
          );
        const identity = segment.epoch + ':' + segment.originalSequence;
        const fingerprint = subtitleFingerprint(segment);
        seen.set(identity, fingerprint);
        const old = lane.seen.get(identity);
        if (old !== undefined && old !== fingerprint)
          throw new HlsDownloaderError(Code.RESOURCE_CHANGED, 'Subtitle resource changed', {
            inputId: lane.id,
          });
        if (
          old !== undefined ||
          (lane.lastSequence !== undefined && BigInt(segment.originalSequence) <= lane.lastSequence)
        )
          continue;
        if (segment.gap) {
          if ((options.missingSegments ?? 'fail') === 'fail')
            throw new HlsDownloaderError(Code.SUBTITLE_INVALID, 'Missing subtitle segment', {
              inputId: lane.id,
            });
          continue;
        }
        indices.push(index);
      }
      const command = {
        revision: lane.revision.toString(),
        inputId: lane.id,
        generation,
        url: current.url,
        text: current.text,
        segments: indices,
      };
      const finish = async (acceptance?: {
        trackId: number;
        accepted: number;
        rejectedLate: number;
        clipped: number;
      }) => {
        assertActive(signal);
        if (acceptance)
          await host.control({
            action: 'event',
            event: { type: 'subtitles', inputId: lane.id, ...acceptance },
          });
        lane.seen = seen;
        if (indices.length) lane.revision++;
        const last = current.metadata.segments.at(-1)?.originalSequence;
        if (last !== undefined) lane.lastSequence = BigInt(last);
        for (const epoch of lane.references.keys())
          if (!epochs.has(epoch)) lane.references.delete(epoch);
        if (current.metadata.endList) {
          await send({ action: 'endSubtitles', inputId: lane.id });
          lane.ended = true;
        }
      };
      if (!indices.length) {
        await finish();
        return;
      }
      const priorKeys = lane.cueKeys,
        priorReferences = new Map(lane.references);
      const acceptance = await cancellable(
        send({ ...command, action: initialAdmission ? 'initialText' : 'tryText' }),
        signal,
      );
      if (!acceptance.wouldBlock) {
        await finish(acceptance);
        return;
      }
      lane.cueKeys = priorKeys;
      lane.references = priorReferences;
      // One bounded pending text batch across all tracks. Media must continue to
      // make space: waiting here before admitting media would deadlock the budget.
      const pending = cancellable(send({ ...command, action: 'text' }), signal).then(finish);
      pendingText = pending;
      track(pending);
      void pending
        .catch((e) => {
          if (!signal.aborted) fail(e);
        })
        .finally(() => {
          if (pendingText === pending) pendingText = undefined;
        });
    });
    textLock = task.catch(() => {});
    return task;
  };
  const poll = async (id: string, snapshot?: Snapshot) => {
    const lane = lanes.get(id)!;
    const signal = lane.controller.signal;
    let previous: string | undefined;
    try {
      while (!stopped && !finished && !lane.ended) {
        assertActive(signal);
        await cancellable(outputReady, signal);
        const current = snapshot ?? (await fetchSnapshot(lane.url, signal));
        snapshot = undefined;
        assertActive(signal);
        if (
          current.metadata.segments.some((s) =>
            [...s.keys, ...(s.map?.keys ?? [])].some(
              (k) =>
                !['AES-128', 'SAMPLE-AES', 'SAMPLE-AES-CTR'].includes(k.method) &&
                !(k.method === 'AES-256-GCM' && opts.decryption?.experimentalGcm),
            ),
          )
        )
          throw new HlsDownloaderError(Code.UNSUPPORTED_ENCRYPTION, 'GCM requires experimentalGcm');
        lane.snapshot = current;
        for (const textLane of textLanes.values())
          if (textLane.timelineInputId === id && !textLane.ended) await prepareText(textLane);
        const revision = (lane.revision++).toString();
        const acceptance = send({
          action: 'accept',
          inputId: id,
          generation: lane.generation,
          revision,
          url: current.url,
          text: (current.metadata.endList &&
          [...textLanes.values()].some((t) => t.timelineInputId === id && !t.ended)
            ? current.text.replace(/^#EXT-X-ENDLIST[^\n]*(?:\n|$)/m, '')
            : current.text
          ).replace(
            finite ? /^#EXT-X-PLAYLIST-TYPE:EVENT[^\n]*/m : /$^/,
            '#EXT-X-PLAYLIST-TYPE:VOD',
          ),
        });
        track(acceptance);
        await cancellable(acceptance, signal);
        if (
          current.metadata.endList &&
          ![...textLanes.values()].some((t) => t.timelineInputId === id && !t.ended)
        ) {
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
        throw new HlsDownloaderError(Code.MULTITRACK_FAILED, 'Recording closed', {
          reason: 'Closed',
        });
      if (value.action === 'end' || value.action === 'restart') {
        const lane = lanes.get(value.inputId!);
        if (!lane)
          throw new HlsDownloaderError(Code.MULTITRACK_FAILED, 'Unknown input', {
            reason: 'UnknownInput',
          });
        if (
          value.action === 'restart' &&
          (!/^(0|[1-9]\d*)$/.test(value.generation ?? '') ||
            BigInt(value.generation!) <= BigInt(lane.generation) ||
            BigInt(value.generation!) > 18446744073709551615n)
        )
          throw new HlsDownloaderError(Code.MULTITRACK_FAILED, 'Invalid generation', {
            reason: 'GenerationMismatch',
          });
        if (value.url !== undefined) new URL(value.url);
        if (
          value.action === 'restart' &&
          [...textLanes.values()].some((t) => t.timelineInputId === value.inputId && t.ended)
        )
          throw new HlsDownloaderError(Code.SUBTITLE_INVALID, 'Subtitle binding has ended', {
            reason: 'Closed',
          });
        // Seal before aborting a pending old-generation admission.
        await send(value);
        lane.controller.abort();
        for (const textLane of textLanes.values())
          if (textLane.timelineInputId === value.inputId) textLane.controller.abort();
        await lane.task;
        if (value.action === 'end') {
          lane.ended = true;
          return;
        }
        for (const textLane of textLanes.values()) {
          if (textLane.timelineInputId === value.inputId) {
            if (textLane.ended)
              throw new HlsDownloaderError(
                Code.SUBTITLE_INVALID,
                'Cannot restart a binding after subtitle EOF',
                { reason: 'Closed' },
              );
            textLane.controller.abort();
          }
        }
        lane.generation = value.generation!;
        lane.revision = 0n;
        lane.ended = false;
        lane.url = value.url ?? lane.url;
        lane.controller = new AbortController();
        for (const textLane of textLanes.values())
          if (textLane.timelineInputId === value.inputId)
            textLane.controller = new AbortController();
        lane.task = poll(value.inputId!);
        track(lane.task);
        return;
      }
      await send(value);
    },
  });
  try {
    assertActive(options.signal);
    const restoration =
      opts.resume && factory.inspectRecovery
        ? await factory.inspectRecovery(opts.resume.directory)
        : undefined;
    const prepare = async () => {
      let url = options.url;
      const audioSelections: { id: string; url: string; metadata: HlsTrackMetadata }[] = [];
      const subtitleSelections: {
        id: string;
        url: string;
        timelineInputId: string;
        metadata: HlsTrackMetadata;
      }[] = [];
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
          if (!audioSelections.length && !subtitleSelections.length) {
            const renditions = parsed.renditions ?? [];
            if (automaticAudio && !options.audioTracks?.length) {
              const rendition = selectAudio(renditions, variant.audioGroup);
              if (rendition?.uri)
                audioSelections.push({
                  id: 'audio',
                  url: rendition.uri,
                  metadata: trackMetadata(rendition),
                });
            }
            for (const selection of options.audioTracks ?? []) {
              const rendition = selectAudio(renditions, variant.audioGroup, selection.selector);
              if (!rendition?.uri)
                throw new HlsDownloaderError(
                  Code.UNSUPPORTED_RENDITION,
                  'Use embeddedAudio for primary audio',
                );
              audioSelections.push({
                id: selection.id,
                url: rendition.uri,
                metadata: trackMetadata(rendition, selection.metadata),
              });
            }
            for (const selection of options.subtitleTracks ?? []) {
              const rendition = renditions.find(
                (r) =>
                  r.type === 'subtitles' &&
                  r.groupId === variant.subtitlesGroup &&
                  r.groupId === selection.selector.groupId &&
                  r.name === selection.selector.name,
              );
              if (!rendition?.uri)
                throw new HlsDownloaderError(
                  Code.RENDITION_NOT_FOUND,
                  'Selected subtitle rendition unavailable',
                );
              subtitleSelections.push({
                id: selection.id,
                url: rendition.uri,
                timelineInputId: selection.timelineInputId ?? 'primary',
                metadata: trackMetadata(rendition, selection.metadata),
              });
            }
          }
          if (opts.__rejectAudio && audioSelections.length)
            throw new HlsDownloaderError(
              Code.UNSUPPORTED_OUTPUT,
              'Audio selection cannot be transcoded',
            );
          url = variant.uri;
          continue;
        }
        if (/^#EXT-X-MEDIA:/m.test(text) && !/^#EXTINF:/m.test(text))
          throw new HlsDownloaderError(Code.NO_VARIANT, 'No variant available');
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
      if ((options.audioTracks?.length || options.subtitleTracks?.length) && visited.size === 1)
        throw new HlsDownloaderError(Code.RENDITION_NOT_FOUND, 'Track selection requires a master');
      const selected = [...audioSelections, ...subtitleSelections];
      if (
        new Set(selected.map((t) => t.url)).size !== selected.length ||
        selected.some((t) => t.url === primary.url)
      )
        throw new HlsDownloaderError(Code.UNSUPPORTED_RENDITION, 'Duplicate selected resource');
      for (const list of [
        [
          ...(options.embeddedAudio === 'keep' ? [options.primaryAudio ?? {}] : []),
          ...audioSelections.map((t) => t.metadata),
        ],
        subtitleSelections.map((t) => t.metadata),
      ])
        if (list.filter((t) => t.default).length > 1)
          throw new HlsDownloaderError(Code.UNSUPPORTED_RENDITION, 'Multiple default tracks');
      const snapshots: [string, Snapshot][] = [['primary', primary]];
      for (const audio of audioSelections)
        snapshots.push([audio.id, await fetchSnapshot(audio.url, initial.signal)]);
      const subtitleSnapshots: [string, Snapshot][] = [];
      for (const subtitle of subtitleSelections)
        subtitleSnapshots.push([subtitle.id, await fetchSnapshot(subtitle.url, initial.signal)]);

      const manifestBytes = [...snapshots, ...subtitleSnapshots].reduce(
        (sum, [, s]) => sum + new TextEncoder().encode(s.text).length,
        0,
      );
      if (manifestBytes > (options.limits?.queuedMetadataBytes ?? 4 * 1024 * 1024))
        throw new HlsDownloaderError(
          Code.RESOURCE_LIMIT_EXCEEDED,
          'Selected manifests exceed aggregate metadata budget',
        );
      if (finite && [...snapshots, ...subtitleSnapshots].some(([, s]) => !s.metadata.endList))
        throw new HlsDownloaderError(
          Code.UNSUPPORTED_RENDITION,
          'Multi-track download requires ENDLIST on every selected input',
        );
      const vod =
        finite ||
        [...snapshots, ...subtitleSnapshots].every(
          ([, s]) => s.metadata.endList && s.metadata.playlistType !== 'Event',
        );
      return { snapshots, subtitleSnapshots, audioSelections, subtitleSelections, vod, primary };
    };
    const bootstrap: Awaited<ReturnType<typeof prepare>> =
      restoration?.request?.bootstrap ?? (await prepare());
    const { snapshots, subtitleSnapshots, audioSelections, subtitleSelections, vod, primary } =
      bootstrap;
    const recoverySnapshots: object[] = [];
    if (restoration?.request && !restoration.terminal && !vod) {
      for (const [id, snapshot] of snapshots) {
        const previous = restoration.journal?.findLast(
          (c) => c.action === 'accept' && c.inputId === id,
        );
        if (previous && !/^#EXT-X-ENDLIST/m.test(previous.text)) {
          const current = await fetchSnapshot(previous.url ?? snapshot.url, initial.signal);
          recoverySnapshots.push({
            action: 'accept',
            inputId: id,
            generation: previous.generation,
            revision: (BigInt(previous.revision) + 1n).toString(),
            url: current.url,
            text: current.text,
          });
        }
      }
    }
    if (stopped) return { report: emptyReport() };
    const media: SelectedMedia = {
      primary: { ...primary, segments: [] },
      subtitles: [],
      totalSegments: 0,
    };
    const engine: KeyedEngine = async (request, read, write, resolve, abortRead) => {
      let replayReady!: () => void;
      const replayComplete = new Promise<void>((r) => (replayReady = r));
      const wire = JSON.parse(request);
      const recording = {
        vod,
        outputType: out.type,
        format: 'format' in out ? (out.format ?? 'mp4') : 'fmp4',
        maxBytes: out.type === 'blob' ? out.maxBytes : undefined,
        durationLimit: options.durationLimit,
        missingSegments: options.missingSegments,
        limits: {
          ...options.limits,
          // The engine admits each VOD snapshot atomically. Its recording default
          // of 128 descriptors must not become a finite playlist length limit.
          queuedDescriptors:
            options.limits?.queuedDescriptors ??
            (finite
              ? Math.max(
                  128,
                  snapshots.reduce((total, [, s]) => total + s.metadata.segments.length, 0),
                )
              : undefined),
        },
        timeline: options.timeline ?? {},
      };
      bridge = await factory(
        JSON.stringify({
          ...wire,
          timeline: undefined,
          bridgeVersion: 3,
          bootstrap,
          recoverySnapshots,
          identity: {
            url: options.url,
            output: out,
            variant: options.variant,
            embeddedAudio:
              automaticAudio && audioSelections.length ? 'exclude' : options.embeddedAudio,
            playbackTarget: options.playbackTarget,
            primaryAudio: options.primaryAudio,
            audioTracks: options.audioTracks,
            subtitleTracks: options.subtitleTracks?.map((t) => ({
              ...t,
              sidecar: sidecars.wire(t.id),
            })),
            timeline: options.timeline,
            durationLimit: options.durationLimit,
            missingSegments: options.missingSegments,
            experimentalGcm: options.decryption?.experimentalGcm ?? false,
            encryptedRanges: options.decryption?.encryptedRanges ?? 'reject',
          },
          recording,
          recovery: opts.resume && {
            ...opts.resume,
            path: out.type === 'file' ? out.path : undefined,
          },
          multitrack: {
            embeddedAudio:
              automaticAudio && audioSelections.length ? 'exclude' : options.embeddedAudio,
            primaryAudio: options.primaryAudio ?? {},
            audioTracks: audioSelections.map(({ id, metadata }) => ({ id, metadata })),
            subtitleTracks: subtitleSelections.map(({ id, metadata, timelineInputId }) => ({
              id,
              metadata,
              timelineInputId,
              embedded: options.subtitleTracks?.find((t) => t.id === id)?.embedded,
              sidecar: sidecars.wire(id),
            })),
            playbackTarget: options.playbackTarget,
          },
        }),
        read,
        write,
        resolve,
        abortRead,
        async (text) => {
          try {
            const r = camelCaseReport(JSON.parse(text));
            if (r.action === 'recoveryReady') {
              replayReady();
              return '';
            }
            if (r.action === 'subtitleCommit' || r.action === 'subtitleFinish') {
              await sidecars.control(r);
              if (r.action === 'subtitleCommit')
                await host.control({
                  action: 'event',
                  event: { type: 'subtitleCommit', commit: r.commit },
                });
              return '';
            }
            if (r.action === 'parseSubtitle') {
              const lane = textLanes.get(r.inputId)!;
              const anchor = options.timeline?.anchors?.find(
                (a) =>
                  a.inputId === lane.timelineInputId &&
                  a.generation === r.generation &&
                  a.epoch === r.epoch,
              );
              const parsed = parseEmbeddedWebVtt(r.text, {
                generation: r.generation,
                epoch: r.epoch,
                header: r.header ?? undefined,
                reference:
                  lane.references.get(r.epoch) ??
                  (anchor
                    ? (BigInt(anchor.source.ticks) * 90000n) / BigInt(anchor.source.timescale)
                    : undefined),
              });
              lane.references.set(r.epoch, parsed.reference);
              // HLS repeats a spanning cue in consecutive resources. Preserve
              // duplicate occurrences inside one resource while removing only
              // repetitions already present in the preceding resource.
              const previous = lane.cueKeys;
              lane.cueKeys = new Set(parsed.cues.map((c) => JSON.stringify(c)));
              return JSON.stringify({
                cues: parsed.cues.filter((c) => !previous.has(JSON.stringify(c))),
                keys: [...lane.cueKeys],
                reference: parsed.reference.toString(),
                epoch: r.epoch,
              });
            }
            if (r.action === 'wait') {
              await recordingDelay(Number(r.ms), lifetime.signal);
              return '';
            }
            if (r.action === 'event' && r.event.type === 'mapping') {
              const mapping = r.event.mapping;
              for (const textLane of textLanes.values()) {
                if (
                  textLane.timelineInputId !== mapping.inputId ||
                  textLane.generation !== mapping.generation
                )
                  continue;
                const reference = textLane.references.get(mapping.epoch);
                const source =
                  (BigInt(mapping.sourceStart.ticks) * 90000n) /
                  BigInt(mapping.sourceStart.timescale);
                if (
                  reference !== undefined &&
                  (reference - source >= 1n << 32n || source - reference >= 1n << 32n)
                )
                  throw new HlsDownloaderError(
                    Code.SUBTITLE_INVALID,
                    'Ambiguous subtitle timestamp wrap; provide a source anchor',
                    {
                      inputId: textLane.id,
                      epoch: mapping.epoch,
                      reason: 'MissingSubtitleMapping',
                    },
                  );
              }
            }
            if (
              r.action === 'event' &&
              r.event.type === 'state' &&
              ['draining', 'finalizing', 'completed', 'failed', 'cancelled'].includes(r.event.state)
            )
              stopPolling();
            return await host.control(r);
          } catch (error) {
            firstFailure ??= error;
            throw error;
          }
        },
      );
      for (const [id, snapshot] of snapshots)
        lanes.set(id, {
          controller: new AbortController(),
          generation: '0',
          revision: 0n,
          url: snapshot.url,
          ended: false,
          snapshot,
        });
      for (const selection of subtitleSelections)
        textLanes.set(selection.id, {
          ...selection,
          controller: new AbortController(),
          generation: '0',
          revision: 0n,
          seen: new Map(),
          cueKeys: new Set(),
          references: new Map(),
          ended: false,
        });
      if (restoration?.journal) {
        for (const command of restoration.journal) {
          const lane = lanes.get(command.inputId);
          if (lane && command.action === 'accept') {
            lane.generation = command.generation;
            lane.revision = BigInt(command.revision) + 1n;
            lane.url = command.url;
            lane.ended = /^#EXT-X-ENDLIST/m.test(command.text);
          }
          if (['initialText', 'tryText', 'text'].includes(command.action)) {
            const textLane = textLanes.get(command.inputId)!;
            const metadata = await adapter.parseMediaPlaylist!(command.text, command.url);
            textLane.generation = command.generation;
            textLane.revision = BigInt(command.revision ?? '0') + 1n;
            for (const index of command.segments) {
              const segment = metadata.segments[index];
              textLane.seen.set(
                segment.epoch + ':' + segment.originalSequence,
                subtitleFingerprint(segment),
              );
              textLane.lastSequence = BigInt(segment.originalSequence);
            }
            for (const group of command.groups ?? []) {
              textLane.cueKeys = new Set(group.keys ?? []);
              if (group.reference !== undefined)
                textLane.references.set(group.epoch, BigInt(group.reference));
            }
          }
          if (command.action === 'endSubtitles') {
            const textLane = textLanes.get(command.inputId);
            if (textLane) textLane.ended = true;
          }
        }
      }
      for (const command of recoverySnapshots as any[]) {
        const lane = lanes.get(command.inputId)!;
        lane.generation = command.generation;
        lane.revision = BigInt(command.revision) + 1n;
        lane.url = command.url;
        lane.ended = /^#EXT-X-ENDLIST/m.test(command.text);
      }
      // Initial subtitle batches are admitted atomically before media execution.
      // A full initial budget fails immediately, rather than waiting for an engine not yet running.
      try {
        if (!restoration?.request)
          for (const [id, snapshot] of subtitleSnapshots)
            await prepareText(textLanes.get(id)!, snapshot, true);
      } catch (error) {
        await bridge.command('{"action":"cancel"}').catch(() => {});
        await bridge.run().catch(() => {});
        bridge.dispose();
        bridge = undefined;
        throw error;
      }
      if (stopped) {
        await bridge.command('{"action":"cancel"}');
        await bridge.run();
        bridge.dispose();
        bridge = undefined;
        return JSON.stringify({ report: emptyReport(), totalSegments: 0 });
      }
      const running = bridge.run();
      void running.catch(() => {});
      resolveBridge(bridge);
      try {
        if (restoration?.request && !restoration.terminal)
          await Promise.race([replayComplete, running]);
        if (options.signal?.aborted || lifetime.signal.aborted) await send({ action: 'cancel' });
        else if (stopped) await send({ action: 'stop' });
        else if (!restoration?.terminal)
          for (const [id, snapshot] of snapshots) {
            const lane = lanes.get(id)!;
            if (lane.ended) continue;
            lane.task = poll(id, restoration?.request ? undefined : snapshot);
            track(lane.task);
          }
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
    const execution = (await executeKeyed(
      adapter,
      { ...opts, timeline: undefined, signal: options.signal! },
      media,
      engine,
      'continuous',
      (bytes, index) => {
        const pending = host.write(bytes, index ?? '0');
        outputReady = pending;
        return pending;
      },
    )) as unknown as { report: HlsMultiTrackReport };
    execution.report.outputs = execution.report.outputs.map(describeOutput);
    execution.report.timelineMap = timelineRecorder.finish(execution.report);
    return execution;
  } catch (e) {
    sidecars.abort(e);
    rejectBridge(e);
    if (stopped && !bridge && !options.signal?.aborted) return { report: emptyReport() };
    const cause = firstFailure ?? e;
    if (cause instanceof HlsDownloaderError) {
      const published = cause.completedRecordingOutputs?.map(describeOutput) ?? completed;
      throw new HlsDownloaderError(cause.code, cause.message, {
        ...cause,
        adapter: adapter.name,
        completedOutputs: published,
        completedRecordingOutputs: published,
        completedMultiTrackOutputs: published,
      });
    }
    throw cause;
  } finally {
    finished = true;
    stopPolling();
    lifetime.abort();
    sidecars.abort(new HlsDownloaderError(Code.ABORTED, 'Operation ended'));
    options.signal?.removeEventListener('abort', abort);
  }
}

function trackMetadata(r: Rendition, override?: HlsTrackMetadata): HlsTrackMetadata {
  return { language: r.language ?? 'und', name: r.name, default: r.default, ...override };
}
export function validateSelection(options: HlsMultiTrackOptions): void {
  if (!['keep', 'exclude'].includes(options.embeddedAudio) || options.audio !== undefined)
    throw new HlsDownloaderError(
      Code.UNSUPPORTED_RENDITION,
      'Choose embeddedAudio explicitly; audio is not a multi-track option',
    );
  const audio = options.audioTracks ?? [],
    subtitles = options.subtitleTracks ?? [];
  if (
    !Array.isArray(audio) ||
    !Array.isArray(subtitles) ||
    audio.length > 31 ||
    subtitles.length > 32
  )
    throw new HlsDownloaderError(Code.RESOURCE_LIMIT_EXCEEDED, 'Multi-track input limit exceeded');
  const ids = new Set(['primary']);
  for (const t of [...audio, ...subtitles]) {
    if (typeof t.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(t.id) || ids.has(t.id))
      throw new HlsDownloaderError(
        Code.UNSUPPORTED_RENDITION,
        'Track IDs must be unique and nonempty',
      );
    ids.add(t.id);
    if (
      !t.selector ||
      !('language' in t.selector
        ? typeof t.selector.language === 'string' && t.selector.language.length
        : typeof t.selector.groupId === 'string' && typeof t.selector.name === 'string')
    )
      throw new HlsDownloaderError(Code.UNSUPPORTED_RENDITION, 'Invalid track selector');
  }
  const mediaIds = new Set(['primary', ...audio.map((t) => t.id)]);
  if (
    subtitles.some((t) => !mediaIds.has(t.timelineInputId ?? 'primary')) ||
    options.timeline?.anchors?.some((a) => !mediaIds.has(a.inputId))
  )
    throw new HlsDownloaderError(Code.SUBTITLE_INVALID, 'Unknown timeline input', {
      reason: 'MissingSubtitleMapping',
    });
  if (
    options.playbackTarget !== undefined &&
    !['container', 'direct-browser', 'avfoundation', 'vlc', 'iina', 'ffmpeg'].includes(
      options.playbackTarget,
    )
  )
    throw new HlsDownloaderError(Code.UNSUPPORTED_OUTPUT, 'Unknown playback target');
}
