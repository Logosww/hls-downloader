import type {
  HlsMultiTrackEvent,
  HlsMultiTrackSession,
} from '../../packages/shared/src/multitrack';

/** Shared by real Chrome and Native; discard output instead of hiding sink growth. */
export async function record(
  downloader: { startMultiTrackRecording(options: any): HlsMultiTrackSession },
  url: string,
  count: number,
  output?: any,
  observe?: (committed: number) => void,
  cancelAt?: number,
) {
  let mediaBytes = 0,
    subtitleBytes = 0,
    mediaClosed = false,
    subtitleClosed = false;
  let busy = false,
    peakWrites = 0,
    activeWrites = 0,
    subtitleCommits = 0;
  const session = downloader.startMultiTrackRecording({
    url,
    embeddedAudio: 'keep',
    limits: { historyEntries: 16, queuedDescriptors: 32, queuedMetadataBytes: 2 * 1024 * 1024 },
    output: output ?? {
      type: 'writable',
      writable: new WritableStream<Uint8Array>({
        async write(bytes) {
          if (busy) throw Error('Overlapping sink writes');
          busy = true;
          peakWrites = Math.max(peakWrites, ++activeWrites);
          mediaBytes += bytes.byteLength;
          await new Promise((r) => setTimeout(r, 2));
          activeWrites--;
          busy = false;
        },
        close() {
          mediaClosed = true;
        },
      }),
    },
    subtitleTracks: [
      {
        id: 'captions',
        selector: { groupId: 's', name: 'English' },
        embedded: false,
        sidecar: {
          type: 'writable',
          writable: new WritableStream<Uint8Array>({
            async write(bytes) {
              subtitleBytes += bytes.byteLength;
              await new Promise((r) => setTimeout(r, 1));
            },
            close() {
              subtitleClosed = true;
            },
          }),
        },
      },
    ],
    onEvent(event: HlsMultiTrackEvent) {
      if (event.type === 'subtitleCommit') subtitleCommits += event.commit.cues.length;
      if (event.type === 'progress' && event.input.inputId === 'primary') {
        const n = Number(event.input.committed);
        observe?.(n);
        if (cancelAt && n >= cancelAt) session.cancel();
      }
    },
  });
  const timeout = setTimeout(() => session.cancel(), Math.max(120_000, count * 2000));
  try {
    const result = await session.result;
    const report = result.report;
    if (cancelAt) throw Error('Cancellation unexpectedly succeeded');
    if (report.inputs.find((i) => i.inputId === 'primary')?.committed !== String(count))
      throw Error('Lost media');
    if (
      (!output && !mediaClosed) ||
      !subtitleClosed ||
      subtitleBytes === 0 ||
      subtitleCommits < count
    )
      throw Error(`Incomplete sink closure/cues: ${subtitleCommits}/${count}`);
    if (report.mappings.length > 16 || report.subtitleReports.length > 16)
      throw Error('Unbounded history');
    if (BigInt(report.peaks.queuedDescriptors) > 32n) throw Error('Queue budget exceeded');
    return { mediaBytes, subtitleBytes, subtitleCommits, peakWrites, report };
  } catch (error) {
    if (!cancelAt || (error as any).code !== 'ABORTED') throw error;
    return { cancelled: true, mediaBytes, subtitleBytes, subtitleCommits, peakWrites };
  } finally {
    clearTimeout(timeout);
  }
}
