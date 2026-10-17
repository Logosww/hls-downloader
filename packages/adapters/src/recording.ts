import { runMultiTrack } from './multitrack';
import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  type HlsDownloaderAdapterInternal,
  type HlsRecordingOptions,
  type HlsRecordingHost,
  type HlsRecordingCapabilities,
  type HlsRecordingReport,
  type HlsDownloaderBrowserOperationOptions,
} from '@hls-downloader/shared';
import { decryptionProfile, type KeyedEngine } from './keyed';
import { camelCaseReport } from './timeline';

export function recordingCapabilities(browser: boolean): HlsRecordingCapabilities {
  return Object.freeze({
    inputs: Object.freeze(['vod', 'live', 'event'] as const),
    externalAudio: true,
    pause: 'vod',
    outputs: Object.freeze(
      browser
        ? (['writable', 'writables', 'blob'] as const)
        : (['writable', 'writables', 'file', 'files'] as const),
    ),
    split: true,
    ranges: true,
    methods: decryptionProfile.methods,
    resume: !browser,
    startPosition: 'window-start',
  });
}
export type RecordingBridge = {
  command(value: string): Promise<string>;
  run(): Promise<string>;
  dispose(): void;
};
export type RecordingBridgeFactory = ((
  request: string,
  read: Parameters<KeyedEngine>[1],
  write: Parameters<KeyedEngine>[2],
  resolve: Parameters<KeyedEngine>[3],
  abort: Parameters<KeyedEngine>[4],
  control: (value: string) => Promise<string>,
) => Promise<RecordingBridge>) & {
  inspectRecovery?: (directory: string) => Promise<RecoveryInspection>;
};
export type RecoveryInspection = { request?: any; journal?: any[]; terminal?: boolean };

export function checkRecording(value: string): any {
  const result = camelCaseReport(JSON.parse(value));
  if (result.error) {
    const { code, ...details } = result.error;
    throw new HlsDownloaderError(code, `Recording failed: ${details.reason ?? code}`, details);
  }
  return result;
}
export function recordingDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new HlsDownloaderError(Code.ABORTED, 'Operation aborted'));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function runRecording(
  adapter: HlsDownloaderAdapterInternal,
  options: HlsRecordingOptions & HlsDownloaderBrowserOperationOptions,
  host: HlsRecordingHost,
  factory: RecordingBridgeFactory,
): Promise<{ report: HlsRecordingReport }> {
  return runMultiTrack(
    adapter,
    {
      ...options,
      onEvent: undefined,
      audio: undefined,
      embeddedAudio: options.audio ? 'exclude' : 'keep',
      audioTracks: options.audio ? [{ id: 'audio', selector: options.audio }] : [],
    },
    host,
    factory,
    false,
    !options.audio,
  );
}
