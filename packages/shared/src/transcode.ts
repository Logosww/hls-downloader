import type {
  HlsDownloaderBrowserTranscodeOptions,
  HlsDownloaderTranscodeOptions,
  HlsDownloaderTranscodePreset,
} from './types';

const TRANSCODE_PRESETS: Record<
  HlsDownloaderTranscodePreset,
  { videoCodec: string; audioCodec: string; format?: string }
> = {
  h264: { videoCodec: 'libx264', audioCodec: 'aac', format: 'mp4' },
  hevc: { videoCodec: 'libx265', audioCodec: 'aac', format: 'mp4' },
  vp9: { videoCodec: 'libvpx-vp9', audioCodec: 'libopus', format: 'webm' },
};

const X264_X265_CODECS = new Set(['libx264', 'libx265']);

const BROWSER_TRANSCODE_FORBIDDEN_KEYS = [
  'videoCodec',
  'audioCodec',
  'format',
  'crf',
  'videoBitrate',
  'audioBitrate',
  'speed',
] as const satisfies readonly (keyof HlsDownloaderTranscodeOptions)[];

function formatBitrate(value: string | number): string {
  return typeof value === 'number' ? String(value) : value;
}

/** Whether download should use FFmpeg for encoding (Node / full transcode options). */
export function needsFfmpegTranscode(
  transcode?: HlsDownloaderTranscodeOptions,
): transcode is HlsDownloaderTranscodeOptions {
  if (!transcode) {
    return false;
  }

  if (transcode.preset) {
    return true;
  }

  const video = transcode.videoCodec;
  const audio = transcode.audioCodec;

  return (!!video && video !== 'copy') || (!!audio && audio !== 'copy');
}

/** Whether BrowserAdapter should load FFmpeg (preset `h264` only). */
export function needsBrowserFfmpegTranscode(
  transcode?: HlsDownloaderBrowserTranscodeOptions,
): transcode is HlsDownloaderBrowserTranscodeOptions {
  return transcode?.preset === 'h264';
}

export function resolveTranscodeOptions(
  transcode: HlsDownloaderTranscodeOptions,
): HlsDownloaderTranscodeOptions {
  if (!transcode.preset) {
    return { ...transcode };
  }

  const defaults = TRANSCODE_PRESETS[transcode.preset];

  return {
    ...transcode,
    videoCodec: transcode.videoCodec ?? defaults.videoCodec,
    audioCodec: transcode.audioCodec ?? defaults.audioCodec,
    format: transcode.format ?? defaults.format,
  };
}

function appendEncodingArgs(
  args: string[],
  options: HlsDownloaderTranscodeOptions,
): void {
  const { videoCodec, audioCodec, crf, videoBitrate, audioBitrate, speed } = options;

  if (videoCodec && videoCodec !== 'copy') {
    if (crf !== undefined) {
      args.push('-crf', String(crf));
    }

    if (videoBitrate !== undefined) {
      args.push('-b:v', formatBitrate(videoBitrate));
    }

    if (speed && videoCodec && X264_X265_CODECS.has(videoCodec)) {
      args.push('-preset', speed);
    }
  }

  if (audioCodec && audioCodec !== 'copy' && audioBitrate !== undefined) {
    args.push('-b:a', formatBitrate(audioBitrate));
  }
}

function appendBrowserOutputArgs(args: string[]): void {
  args.push('-movflags', '+faststart');
}

export function getTranscodeDefaultFilename(transcode: HlsDownloaderTranscodeOptions): string {
  const options = resolveTranscodeOptions(transcode);
  return options.format === 'webm' ? 'output.webm' : 'output.mp4';
}

export function getTranscodeMimeType(transcode: HlsDownloaderTranscodeOptions): string {
  const options = resolveTranscodeOptions(transcode);
  return options.format === 'webm' ? 'video/webm' : 'video/mp4';
}

export function assertBrowserTranscodeOptions(
  transcode: HlsDownloaderBrowserTranscodeOptions,
): HlsDownloaderTranscodeOptions {
  if (transcode.preset !== 'h264') {
    throw new TypeError('BrowserAdapter only supports transcode preset "h264".');
  }

  for (const key of BROWSER_TRANSCODE_FORBIDDEN_KEYS) {
    if ((transcode as HlsDownloaderTranscodeOptions)[key] !== undefined) {
      throw new TypeError(
        `BrowserAdapter transcode does not support "${key}". Use { preset: "h264" } only.`,
      );
    }
  }

  return resolveTranscodeOptions({ preset: 'h264' });
}

export type BuildFfmpegOutputArgsOptions = {
  browser?: boolean;
};

/** Build FFmpeg output arguments from transcode options. */
export function buildFfmpegOutputArgs(
  transcode: HlsDownloaderTranscodeOptions,
  buildOptions?: BuildFfmpegOutputArgsOptions,
): string[] {
  const options = resolveTranscodeOptions(transcode);
  const args = [
    '-c:v',
    options.videoCodec ?? 'copy',
    '-c:a',
    options.audioCodec ?? 'copy',
  ];

  if (options.format) {
    args.push('-f', options.format);
  }

  appendEncodingArgs(args, options);

  if (buildOptions?.browser) {
    appendBrowserOutputArgs(args);
  }

  return args;
}

/** Fixed H.264 output args for BrowserAdapter. */
export function buildBrowserFfmpegOutputArgs(): string[] {
  return buildFfmpegOutputArgs({ preset: 'h264' }, { browser: true });
}
