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
  STICHING_SEGMENTS = 'stiching-segments',
  READY_FOR_DOWNLOAD = 'ready-for-download',
  ERROR = 'error',
}

export type HlsDownloaderAdapter = {
  name: string;
  onEvent?: <E extends HlsDownloaderEvent>(
    event: E,
    payload?: E extends
      | HlsDownloaderEvent.DOWNLOADING_SEGMENTS
      | HlsDownloaderEvent.STICHING_SEGMENTS
      ? { total: number; completed: number }
      : undefined,
  ) => void;
};

export type HlsDownloaderFetchOptions = {
  url: string;
  headers?: Record<string, string>;
};

export type HlsDownloaderDownloadOptions = {
  filename?: string;
  maxRetry?: number;
  downloadConcurrency?: number;
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
}
