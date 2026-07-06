export type Segment = {
  uri: string;
  [key: string]: any;
};

export type Playlist = {
  name: string;
  bandwidth: number;
  uri: string;
};

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

export type HlsDownloaderAdapter = {
  name: string;
  onEvent?: <E extends HlsDownloaderEvent>(
    event: E,
    payload?: E extends
      | HlsDownloaderEvent.DOWNLOADING_SEGMENTS
      | HlsDownloaderEvent.STITCHING_SEGMENTS
      ? { total: number; completed: number }
      : undefined,
  ) => void;
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

/** Browser FFmpeg.wasm currently only supports H.264 via preset (no fine-grained options). */
export type HlsDownloaderBrowserTranscodeOptions = {
  preset: 'h264';
};

export type HlsDownloaderDownloadOptions = {
  filename?: string;
  maxRetry?: number;
  downloadConcurrency?: number;
  transcode?: HlsDownloaderTranscodeOptions;
  signal?: AbortSignal;
};

export type HlsDownloaderStreamResult = {
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
  ): Promise<HlsDownloaderStreamResult>;
}
