export type Segment = {
  uri: string;
  [key: string]: any;
};

export type Playlist = {
  name: string;
  bandwidth: number;
  uri: string;
  resolution?: { width: number; height: number };
  codecs?: string;
  frameRate?: number;
  /** 无 RESOLUTION 且 codecs 仅含音频时为 true（用于过滤纯音频 variant）。 */
  isAudioOnly?: boolean;
};

/**
 * `selectBestVariant` 的选择偏好。所有字段可选，缺省时取最高分辨率 → 最高带宽。
 * - `maxResolution`：候选 variant 像素数不超过此上限（width*height）。
 * - `maxBandwidth`：候选 variant 带宽不超过此上限（bps）。
 * - `preferredCodec`：优先匹配该 codec 前缀的 variant（如 `'avc1'`、`'hvc1'`）。
 * - `preferredAudio`：优先匹配该音频 codec 前缀的 variant（如 `'mp4a'`、`'ec-3'`）。
 * - `includeAudioOnly`：是否把纯音频 variant 纳入候选，默认 false。
 */
export type VariantSelectOptions = {
  maxResolution?: { width: number; height: number };
  maxBandwidth?: number;
  preferredCodec?: string;
  preferredAudio?: string;
  includeAudioOnly?: boolean;
};

/**
 * 可替换的 variant 选择策略。返回最合适的 variant，或 undefined 表示无候选。
 */
export type VariantSelector = (
  playlists: Playlist[],
  options?: VariantSelectOptions,
) => Playlist | undefined;

export type ParseHlsResult =
  | { type: 'playlist'; data: Playlist[]; message?: undefined }
  | { type: 'segment'; data: Segment[]; message?: undefined }
  | { type: 'error'; data?: undefined; message: string };

export enum HlsDownloaderEvent {
  FFMPEG_LOADING = 'ffmpeg-loading',
  FFMPEG_LOADED = 'ffmpeg-loaded',
  STARTING_DOWNLOAD = 'starting-download',
  SOURCE_PARSED = 'source-parsed',
  DOWNLOADING = 'downloading',
  DOWNLOADING_SEGMENTS = 'downloading-segments',
  STITCHING_SEGMENTS = 'stitching-segments',
  READY_FOR_DOWNLOAD = 'ready-for-download',
  ERROR = 'error',
}

export type HlsDownloaderEventPayload<E extends HlsDownloaderEvent = HlsDownloaderEvent> = {
  operationId: string;
} & (E extends HlsDownloaderEvent.DOWNLOADING_SEGMENTS | HlsDownloaderEvent.STITCHING_SEGMENTS
  ? { total: number; completed: number }
  : Record<string, never>);

export type HlsDownloaderAdapter = {
  name: string;
  onEvent?: <E extends HlsDownloaderEvent>(event: E, payload: HlsDownloaderEventPayload<E>) => void;
};

export type HlsDownloaderFetchOptions = {
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export type HlsDownloaderGlobalDownloadOptions = Omit<HlsDownloaderFetchOptions, 'url'> & {
  concurrency?: number;
  maxRetry?: number;
};

/** Built-in transcode profiles. Explicit codec/format fields override the preset. */
export type HlsDownloaderTranscodePreset = 'h264' | 'hevc' | 'vp9';

/** libx264 / libx265 encoder speed preset (`-preset`). */
export type HlsDownloaderEncoderSpeed =
  | 'ultrafast'
  | 'superfast'
  | 'veryfast'
  | 'faster'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'slower'
  | 'veryslow';

export type HlsDownloaderTranscodeOptions = {
  /** Shorthand encoding profile. Omit `transcode` entirely for default transmux/remux. */
  preset?: HlsDownloaderTranscodePreset;
  videoCodec?: string;
  audioCodec?: string;
  /** Output container format passed to FFmpeg `-f`. */
  format?: string;
  /** Constant rate factor for libx264 / libx265 / libvpx-vp9. Ignored when video is copied. */
  crf?: number;
  videoBitrate?: string | number;
  audioBitrate?: string | number;
  /** libx264 / libx265 `-preset`. Ignored when video is copied or not x264/x265. */
  speed?: HlsDownloaderEncoderSpeed;
};

export type HlsDownloaderBrowserTranscodeOptions = {
  preset: HlsDownloaderTranscodePreset;
  videoBitrate?: string | number;
  audioBitrate?: string | number;
};

export type HlsDownloaderDownloadOptions = {
  /** Stable identifier used to correlate lifecycle events for this operation. */
  operationId?: string;
  filename?: string;
  maxRetry?: number;
  downloadConcurrency?: number;
  transcode?: HlsDownloaderTranscodeOptions;
  signal?: AbortSignal;
  /** Master playlist variant 选择偏好；缺省时取最高分辨率 → 最高带宽。 */
  variant?: VariantSelectOptions;
};

export type HlsDownloaderStreamResult = {
  operationId: string;
  totalSegments: number;
};

export interface HlsDownloaderAdapterInternal<
  AdditionalOptions extends Record<string, any> = {},
  DownloadResult = unknown,
> extends HlsDownloaderAdapter {
  chunkDownloadConcurrency: number;
  segmentRetryAttempts: number;
  init(options?: AdditionalOptions): Promise<void>;
  parseHls(options: HlsDownloaderFetchOptions): Promise<ParseHlsResult>;
  download(
    options: HlsDownloaderFetchOptions & HlsDownloaderDownloadOptions & Partial<AdditionalOptions>,
  ): Promise<DownloadResult>;
  getPosterUrl(options: HlsDownloaderFetchOptions): Promise<string | undefined>;
  downloadToStream(
    options: HlsDownloaderFetchOptions & HlsDownloaderDownloadOptions,
    onChunk: (bytes: Uint8Array) => void,
  ): Promise<Omit<HlsDownloaderStreamResult, 'operationId'>>;
  /** 清空 adapter 内部的 parseHls / poster 缓存。可选实现。 */
  clearCache?(): void;
}
