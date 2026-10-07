import type { AudioSelection } from './types';
import type { HlsMediaTime } from './timeline';
import type {
  HlsRecordingOptions,
  HlsRecordingOutput,
  HlsRecordingReport,
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
export type HlsSubtitleTrackSelection = {
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
  disposition: 'Written' | 'Clipped' | 'RejectedLate';
  outputIndex: string;
  start: HlsMediaTime;
  end: HlsMediaTime;
};
/** Media accounting is shared; tracks and subtitle receipts are separate from legacy reports. */
export type HlsMultiTrackReport = HlsRecordingReport & {
  configurationId: number[];
  tracks: HlsMultiTrackInfo[];
  subtitleReports: HlsSubtitleCueReport[];
  trackHistoryTruncated: boolean;
  subtitleHistoryTruncated: boolean;
};
export type HlsMultiTrackEvent =
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
  resume: false;
}>;
