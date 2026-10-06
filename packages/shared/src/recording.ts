import type { HlsDownloaderFetchOptions, HlsDownloaderDownloadOptions } from './types';
import type { HlsMediaTime, HlsPresentationRange, HlsTimelineTrack } from './timeline';
export type HlsRecordingState =
  | 'preparing'
  | 'running'
  | 'paused'
  | 'draining'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type HlsRecordingInputId = 'primary' | 'audio';
export type HlsRecordingOutputRequest = { index: string; tracks: HlsTimelineTrack[] };
export type HlsRecordingOutputReport = HlsRecordingOutputRequest & {
  bytesWritten: string;
  duration: string;
  durationTimescale: number;
  segmentCount: string;
  collectedBytes: string;
  classicIndexSamples: string;
  filePath?: string;
};
export type HlsRecordingMapping = {
  inputId: string;
  generation: string;
  epoch: string;
  trackId: number;
  sourceStart: HlsMediaTime;
  presentationStart: HlsMediaTime;
  outputStart: HlsMediaTime;
  outputIndex: string;
  configurationId: number[];
  programDateTime: string | null;
};
export type HlsRecordingProgress = {
  inputId: string;
  total: null;
  discovered: string;
  accepted: string;
  downloaded: string;
  decrypted: string;
  committed: string;
  committedSlot: { inputId: string; generation: string; epoch: string; sequence: string } | null;
};
export type HlsRecordingReport = {
  schemaVersion: 1;
  endReason: 'Eof' | 'Stop' | 'DurationLimit';
  inputs: HlsRecordingProgress[];
  bytesWritten: string;
  duration: HlsMediaTime;
  requestedRange: HlsPresentationRange | null;
  actualRange: HlsPresentationRange | null;
  gapCount: string;
  outputs: HlsRecordingOutputReport[];
  mappings: HlsRecordingMapping[];
  historyTruncated: boolean;
  peaks: {
    queuedDescriptors: string;
    queuedMetadataBytes: string;
    samples: string;
    sampleBytes: string;
  };
};
export type HlsRecordingEvent =
  | { type: 'state'; state: HlsRecordingState }
  | { type: 'mapping'; mapping: HlsRecordingMapping }
  | {
      type: 'gap';
      slot: NonNullable<HlsRecordingProgress['committedSlot']>;
      presentationStart: HlsMediaTime;
      duration: HlsMediaTime;
    }
  | { type: 'progress'; input: HlsRecordingProgress; bytesWritten: string }
  | { type: 'output'; output: HlsRecordingOutputReport };
export type HlsRecordingOutput =
  | { type: 'writable'; writable: WritableStream<Uint8Array> }
  | {
      type: 'writables';
      acquire: (output: HlsRecordingOutputRequest) => Promise<WritableStream<Uint8Array>>;
    }
  | { type: 'blob'; maxBytes: number; format?: 'mp4' | 'fmp4' }
  | { type: 'file'; path: string; format?: 'mp4' | 'fmp4' }
  | {
      type: 'files';
      acquire: (output: HlsRecordingOutputRequest) => Promise<string>;
      format?: 'mp4' | 'fmp4';
    };
export type HlsRecordingOptions<O extends HlsRecordingOutput = HlsRecordingOutput> =
  HlsDownloaderFetchOptions &
    Pick<
      HlsDownloaderDownloadOptions,
      'operationId' | 'maxRetry' | 'variant' | 'audio' | 'decryption'
    > & {
      output: O;
      durationLimit?: HlsMediaTime;
      missingSegments?: 'fail' | 'skip' | 'split';
      timeline?: {
        range?: HlsPresentationRange;
        gapPolicy?: 'preserve' | 'collapse';
        changePolicy?: 'fail' | 'split';
        tailDuration?: HlsMediaTime;
        anchors?: {
          inputId: HlsRecordingInputId;
          generation: string;
          epoch: string;
          source: HlsMediaTime;
          presentation: HlsMediaTime;
        }[];
      };
      limits?: {
        queuedDescriptors?: number;
        queuedMetadataBytes?: number;
        historyEntries?: number;
        samples?: number;
        sampleBytes?: number;
        probeSegments?: number;
        maxSkew?: HlsMediaTime;
        inputTimeoutMs?: number;
      };
      onEvent?: (event: HlsRecordingEvent & { operationId: string }) => void;
      transcode?: never;
      resume?: never;
      aria2?: never;
    };
export type HlsRecordingResult<O extends HlsRecordingOutput = HlsRecordingOutput> = {
  operationId: string;
  report: HlsRecordingReport;
} & (O extends { type: 'blob' }
  ? { blob: Blob }
  : O extends { type: 'file' }
    ? { filePath: string }
    : {});
export type HlsRecordingSession<O extends HlsRecordingOutput = HlsRecordingOutput> = {
  readonly operationId: string;
  readonly state: HlsRecordingState;
  readonly result: Promise<HlsRecordingResult<O>>;
  stop(): void;
  cancel(): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  endInput(inputId: HlsRecordingInputId): Promise<void>;
  restartInput(
    inputId: HlsRecordingInputId,
    options: { generation: string; url?: string },
  ): Promise<void>;
};
/** Adapter driver. Controls are independent of its running output future. */
export type HlsRecordingDriver = {
  command(value: {
    action: string;
    inputId?: string;
    generation?: string;
    url?: string;
  }): Promise<void>;
};
export type HlsRecordingHost = {
  ready(driver: HlsRecordingDriver): void;
  write(bytes: Uint8Array, index: string): Promise<void>;
  control(
    request:
      | { action: 'acquire'; output: HlsRecordingOutputRequest }
      | { action: 'event'; event: HlsRecordingEvent },
  ): Promise<string>;
};
export type HlsRecordingCapabilities = Readonly<{
  inputs: readonly ['vod', 'live', 'event'];
  externalAudio: true;
  pause: 'vod';
  outputs: readonly HlsRecordingOutput['type'][];
  split: true;
  ranges: true;
  methods: readonly string[];
  resume: false;
  startPosition: 'window-start';
}>;
