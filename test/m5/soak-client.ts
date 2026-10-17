import type { HlsMultiTrackSession } from '../../packages/shared/src/multitrack';

export type SoakConfig = {
  url: string;
  count: number;
  durationMs: number;
  sampleMs: number;
  stallTimeoutMs: number;
  writeDelayMs: number;
  workload?: 'aac' | 'av';
  sinkStallMs?: number;
};

export function beginSoak(
  downloader: { startMultiTrackRecording(options: any): HlsMultiTrackSession },
  config: SoakConfig,
) {
  const started = performance.now();
  let lastProgress = started,
    committed = 0,
    cues = 0,
    mediaBytes = 0,
    subtitleBytes = 0;
  let stalls = 0,
    lastStall = -1;
  let mediaClosed = false,
    subtitleClosed = false,
    activeWrites = 0,
    peakWrites = 0;
  const media = new WritableStream<Uint8Array>({
    async write(bytes) {
      if (++activeWrites !== 1) throw Error('Overlapping media writes');
      peakWrites = Math.max(peakWrites, activeWrites);
      mediaBytes += bytes.byteLength;
      try {
        await new Promise((r) => setTimeout(r, config.writeDelayMs));
        if (config.sinkStallMs && committed !== lastStall && committed % 4 === 0) {
          lastStall = committed;
          stalls++;
          await new Promise((r) => setTimeout(r, config.sinkStallMs));
        }
      } finally {
        activeWrites--;
      }
    },
    close() {
      mediaClosed = true;
    },
  });
  const subtitles = new WritableStream<Uint8Array>({
    async write(bytes) {
      subtitleBytes += bytes.byteLength;
      await new Promise((r) => setTimeout(r, config.writeDelayMs));
    },
    close() {
      subtitleClosed = true;
    },
  });
  const session = downloader.startMultiTrackRecording({
    url: config.url,
    embeddedAudio: 'keep',
    ...(config.workload === 'av'
      ? {
          audioTracks: [
            { id: 'en', selector: { groupId: 'a', name: 'English' } },
            { id: 'fr', selector: { groupId: 'a', name: 'French' } },
          ],
        }
      : {}),
    output: { type: 'writable', writable: media },
    limits: { historyEntries: 16, queuedDescriptors: 32, queuedMetadataBytes: 2 * 1024 ** 2 },
    subtitleTracks: [
      {
        id: 'captions',
        selector: { groupId: 's', name: 'English' },
        embedded: false,
        sidecar: { type: 'writable', writable: subtitles },
      },
    ],
    onEvent(event: any) {
      if (event.type === 'progress' && event.input.inputId === 'primary') {
        const next = Number(event.input.committed);
        if (next > committed) {
          committed = next;
          lastProgress = performance.now();
        }
      }
      if (event.type === 'subtitleCommit') cues += event.commit.cues.length;
    },
  });
  const snapshot = () => ({
    elapsedMs: performance.now() - started,
    committed,
    cues,
    mediaBytes,
    subtitleBytes,
    stalls,
    progressAgeMs: performance.now() - lastProgress,
    state: session.state,
  });
  let watchdogFailure: Error | undefined;
  const watchdog = setInterval(
    () => {
      if (performance.now() - lastProgress > config.stallTimeoutMs) {
        watchdogFailure = Error('Recording made no progress within stall timeout');
        session.cancel();
      }
    },
    Math.min(1000, config.stallTimeoutMs / 2),
  );
  const result = session.result
    .then((result) => {
      const metrics = snapshot(),
        report = result.report;
      if (metrics.elapsedMs < config.durationMs)
        throw Error('Recording ended before requested real elapsed duration');
      if (report.endReason !== 'Eof' || committed !== config.count || cues !== config.count)
        throw Error(
          `Incomplete recording: ${committed}/${config.count} media, ${cues}/${config.count} cues, ${report.endReason}`,
        );
      if (!mediaClosed || !subtitleClosed || !mediaBytes || !subtitleBytes || peakWrites !== 1)
        throw Error('Incomplete sink closure or output');
      if (
        report.mappings.length > 16 ||
        report.subtitleReports.length > 16 ||
        BigInt(report.peaks.queuedDescriptors) > 32n
      )
        throw Error('Engine history/queue bounds exceeded');
      if (report.outputs.some((o) => o.classicIndexSamples !== '0'))
        throw Error('Unexpected classic index in fMP4 sink');
      if (config.sinkStallMs && !stalls) throw Error('No sink stall was exercised');
      if (config.workload === 'av') {
        if (
          report.tracks.filter((t) => t.kind === 'video').length !== 1 ||
          report.tracks.filter((t) => t.kind === 'audio').length !== 2
        )
          throw Error('Expected one video and two audio tracks');
        for (const id of ['en', 'fr'])
          if (report.inputs.find((i) => i.inputId === id)?.committed !== String(config.count))
            throw Error(`Incomplete audio track ${id}`);
        if (mediaBytes / (config.count * 2.56) < 300_000)
          throw Error('Video fixture bitrate is too low for stress qualification');
      }
      return { ...metrics, mediaClosed, subtitleClosed, peakWrites, report };
    })
    .catch((error) => {
      throw watchdogFailure ?? error;
    })
    .finally(() => clearInterval(watchdog));
  // Avoid an unhandled rejection between start and the harness attaching its waiter.
  result.catch(() => {});
  return { snapshot, result, cancel: () => session.cancel() };
}
