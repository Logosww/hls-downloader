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

export type HlsDownloaderFetchOption = {
  url: string;
  headers?: Record<string, string>;
};

export type HlsDownloaderDownloadOption = {
  filename?: string;
  maxRetry?: number;
  downloadConcurrency?: number;
};

export type DownloadResult = {
  blobURL: string;
  totalSegments: number;
} | void;

export interface HlsDownloaderAdapterInternal<
  AdditionalOption extends Record<string, any> = {},
> extends HlsDownloaderAdapter {
  chunkDownloadConcurrency: number;
  segmentRetryAttempts: number;
  init(option?: AdditionalOption): Promise<void>;
  parseHls(option: HlsDownloaderFetchOption): Promise<ParseHlsResult>;
  download(option: HlsDownloaderFetchOption & HlsDownloaderDownloadOption): Promise<DownloadResult>;
  getPosterUrl(option: HlsDownloaderFetchOption): Promise<string | undefined>;
}
