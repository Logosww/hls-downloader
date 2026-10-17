import type { AudioSelection } from './types';
import type { HlsMediaTime } from './timeline';
import type {
  HlsRecordingOptions,
  HlsRecordingOutput,
  HlsEngineMediaReport,
  HlsRecordingEvent,
  HlsRecordingResult,
  HlsRecordingSession,
  HlsRecordingHost,
} from './recording';

export type HlsTrackMetadata = { language?: string; name?: string; default?: boolean };
export type HlsAudioTrackSelection = {
  id: string;
  selector: AudioSelection;
  metadata?: HlsTrackMetadata;
};
export type HlsSubtitleSidecarRequest = { inputId: string; outputIndex: string };
export type HlsSubtitleSidecar =
  | { type: 'writable'; writable: WritableStream<Uint8Array> }
  | {
      type: 'writables';
      acquire: (request: HlsSubtitleSidecarRequest) => Promise<WritableStream<Uint8Array>>;
    }
  | { type: 'file'; path: string };
export type HlsSubtitleTrackSelection = {
  /** Defaults to true. A sidecar is required when embedding is disabled. */
  embedded?: boolean;
  sidecar?: HlsSubtitleSidecar;
  id: string;
  selector: { groupId: string; name: string };
  /** Source clock to which X-TIMESTAMP-MAP refers. Defaults to primary. */
  timelineInputId?: string;
  metadata?: HlsTrackMetadata;
};
export type HlsMultiTrackPlaybackTarget =
  | 'container'
  | 'direct-browser'
  | 'avfoundation'
  | 'vlc'
  | 'iina'
  | 'ffmpeg';
export type HlsMultiTrackOptions<O extends HlsRecordingOutput = HlsRecordingOutput> = Omit<
  HlsRecordingOptions<O>,
  'audio' | 'timeline' | 'onEvent'
> & {
  embeddedAudio: 'keep' | 'exclude';
  primaryAudio?: HlsTrackMetadata;
  audioTracks?: readonly HlsAudioTrackSelection[];
  subtitleTracks?: readonly HlsSubtitleTrackSelection[];
  playbackTarget?: HlsMultiTrackPlaybackTarget;
  audio?: never;
  timeline?: Omit<NonNullable<HlsRecordingOptions['timeline']>, 'anchors'> & {
    anchors?: {
      inputId: string;
      generation: string;
      epoch: string;
      source: HlsMediaTime;
      presentation: HlsMediaTime;
    }[];
  };
  onEvent?: (event: HlsMultiTrackEvent & { operationId: string }) => void;
};
export type HlsMultiTrackInfo = {
  id: number;
  outputIndex: string;
  inputId: string;
  kind: 'video' | 'audio' | 'subtitle';
  codec: 'Avc' | 'Hevc' | 'AacLc' | 'Wvtt';
  metadata: Required<HlsTrackMetadata>;
  timescale: number;
  duration: string;
  sampleCount: string;
};
export type HlsSubtitleCueReport = {
  trackId: number;
  identifier: string;
  disposition: 'Written' | 'Clipped' | 'RejectedLate' | 'RejectedRange';
  outputIndex: string;
  start: HlsMediaTime;
  end: HlsMediaTime;
};
/** Media accounting is shared; tracks and subtitle receipts are separate from legacy reports. */
export type HlsEngineReport = HlsEngineMediaReport & {
  timelineMap?: import('./timeline').HlsTimelineMap;
  configurationId: number[];
  tracks: HlsMultiTrackInfo[];
  subtitleReports: HlsSubtitleCueReport[];
  trackHistoryTruncated: boolean;
  subtitleHistoryTruncated: boolean;
};
export type HlsSubtitleCommit = {
  cues: (HlsSubtitleCueReport & {
    receipt: string;
    inputId: string;
    generation: string;
    epoch: string;
    payload: string;
    settings: string;
  })[];
  frontiers: {
    inputId: string;
    trackId: number;
    generation: string;
    epoch: string;
    outputIndex: string;
    end: HlsMediaTime;
  }[];
};
export type HlsMultiTrackEvent =
  | { type: 'subtitleCommit'; commit: HlsSubtitleCommit }
  | HlsRecordingEvent
  | {
      type: 'subtitles';
      inputId: string;
      trackId: number;
      accepted: number;
      rejectedLate: number;
      clipped: number;
    };
export type HlsMultiTrackResult<O extends HlsRecordingOutput = HlsRecordingOutput> = Omit<
  HlsRecordingResult<O>,
  'report'
> & { report: HlsMultiTrackReport };
export type HlsMultiTrackSession<O extends HlsRecordingOutput = HlsRecordingOutput> = Omit<
  HlsRecordingSession<O>,
  'result' | 'endInput' | 'restartInput'
> & {
  readonly result: Promise<HlsMultiTrackResult<O>>;
  endInput(inputId: string): Promise<void>;
  restartInput(inputId: string, options: { generation: string; url?: string }): Promise<void>;
};
export type HlsMultiTrackHost = Omit<HlsRecordingHost, 'control'> & {
  control(
    request:
      | Parameters<HlsRecordingHost['control']>[0]
      | {
          action: 'event';
          event: HlsMultiTrackEvent;
        },
  ): Promise<string>;
};
export type HlsMultiTrackCapabilities = Readonly<{
  inputs: readonly ['vod', 'live', 'event'];
  containers: readonly ['ts', 'fmp4', 'packed-aac'];
  maxMediaInputs: 32;
  maxSubtitleTracks: 32;
  subtitles: 'wvtt-plain-text';
  subtitleResources: readonly ['clear', 'AES-128'];
  subtitleSidecars: Readonly<{ outputs: readonly HlsSubtitleSidecar['type'][]; resume: boolean }>;
  decryption: Readonly<{
    methods: readonly string[];
    profiles: readonly Readonly<{
      method: string;
      container: string;
      scheme: string;
      codecs: readonly string[];
    }>[];
  }>;
  outputs: readonly HlsRecordingOutput['type'][];
  pause: 'vod';
  split: true;
  ranges: true;
  resume: boolean;
}>;

export type HlsMultiTrackReport = HlsEngineReport;
