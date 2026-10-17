import type { HlsMultiTrackPlaybackTarget } from './multitrack';
/** Engine remux/recording query; encoder availability is checked by the transcode runtime. */
export type HlsCapabilityQuery = {
  inputs: readonly {
    id: string;
    container: 'ts' | 'fmp4' | 'packed-aac' | 'other';
    encryption:
      | 'clear'
      | 'AES-128'
      | 'clear-and-aes128'
      | 'SAMPLE-AES'
      | 'SAMPLE-AES-CTR'
      | 'AES-256-GCM';
    codecs: readonly ('avc' | 'hevc' | 'aac-lc' | 'other')[];
    scheme?: 'none' | 'cenc' | 'cbcs';
  }[];
  output: 'blob' | 'writable' | 'file-mp4' | 'file-fmp4';
  mode?: 'vod' | 'live' | 'event';
  range?:
    | 'whole-resources'
    | 'clear-byte-ranges'
    | 'complete-encrypted-resources'
    | 'presentation'
    | 'iframe'
    | 'arbitrary-encrypted-ranges';
  embeddedAudio?: 'keep' | 'exclude';
  playbackTarget?: HlsMultiTrackPlaybackTarget;
  subtitles?: boolean;
  decodeGaps?: boolean;
  maxBytes?: number;
  resume?: boolean;
  experimentalGcm?: boolean;
};
export type HlsCapabilityDecision = {
  supported: boolean;
  containerSupported: boolean;
  playbackSupported: boolean;
  rejections: { inputId: string | null; dimension: string }[];
  containerRejections: { inputId: string | null; dimension: string }[];
  playbackRejection: string | null;
  requirements: string[];
};
