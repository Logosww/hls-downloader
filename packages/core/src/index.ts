import { createOutputManager } from './outputs';
import type {
  HlsDownloaderOutputsOptions,
  HlsOutputFactory,
  HlsOutputsResult,
  HlsDownloaderSubtitleOutputsOptions,
  HlsSidecar,
} from '@hls-downloader/shared';
import type { HlsDecryptionOptions, HlsMediaPlaylist } from '@hls-downloader/shared';
import {
  getInternalAdapter,
  injectContext,
  isRegisteredAdapter,
  HlsDownloaderErrorCode,
  HlsDownloaderEvent,
  normalizeHlsError,
  HlsDownloaderError,
  ParseHlsResult,
} from '@hls-downloader/shared';

import type {
  DownloaderContext,
  AdapterCapabilities,
  HlsDownloaderAdapter,
  HlsDownloaderAdapterInternal,
  HlsDownloaderGlobalDownloadOptions,
  HlsDownloaderFetchOptions,
  HlsDownloaderDownloadOptions,
  HlsDownloaderStreamResult,
  HlsDownloaderSubtitleOptions,
  HlsDownloaderSubtitleResult,
  HlsDownloaderWritableOptions,
  HlsDownloaderTranscodeOptions,
  HlsDownloaderEventPayload,
} from '@hls-downloader/shared';

export { HlsDownloaderEvent } from '@hls-downloader/shared';

type HlsDownloaderConfigFactory<T> =
  T extends HlsDownloaderAdapterInternal<
    infer AdditionalOptions,
    infer DownloadResult,
    infer DownloadOnlyOptions,
    infer RequestOptions
  >
    ? {
        additionalOptions: AdditionalOptions;
        downloadResult: DownloadResult;
        downloadOnlyOptions: DownloadOnlyOptions;
        requestOptions: RequestOptions;
      }
    : never;

export type GlobalOptions<T extends HlsDownloaderAdapter> = {
  download?: HlsDownloaderGlobalDownloadOptions;
  transcode?: HlsDownloaderTranscodeOptions;
} & HlsDownloaderConfigFactory<T>['additionalOptions'];

function pickInitOptions<T extends HlsDownloaderAdapter>(
  options: GlobalOptions<T> | null,
): HlsDownloaderConfigFactory<T>['additionalOptions'] | undefined {
  if (!options) return undefined;

  const { download: _download, transcode: _transcode, ...initOptions } = options;
  return Object.keys(initOptions).length > 0
    ? (initOptions as HlsDownloaderConfigFactory<T>['additionalOptions'])
    : undefined;
}

export class HlsDownloader<T extends HlsDownloaderAdapter> {
  #isInit: boolean = false;
  #initPromise: Promise<void> | null = null;
  #globalOptions: GlobalOptions<T> | null = null;
  readonly #adapterProxy: T;
  readonly #adapter: HlsDownloaderAdapterInternal;
  readonly #context: DownloaderContext;
  readonly #onEvent?: HlsDownloaderAdapter['onEvent'];
  get isInit(): boolean {
    return this.#isInit;
  }
  get capabilities(): AdapterCapabilities {
    return this.#adapter.capabilities;
  }
  constructor({
    adapter,
    options,
    onEvent,
  }: {
    adapter: T;
    options?: GlobalOptions<T>;
    onEvent?: HlsDownloaderAdapter['onEvent'];
  }) {
    if (!isRegisteredAdapter(adapter)) {
      throw new TypeError(
        'Invalid adapter: expected an adapter exported from @hls-downloader/adapters',
      );
    }

    this.#adapterProxy = adapter;
    this.#globalOptions = options ?? null;
    this.#adapter = getInternalAdapter(adapter);
    this.#onEvent = onEvent;
    this.#context = {
      internal: this.#adapter,
      getGlobalOptions: () => this.globalOptions,
    };
  }
  #snapshotContext(): DownloaderContext {
    const globalOptions = this.#globalOptions;
    const snapshot = globalOptions
      ? {
          ...globalOptions,
          download: globalOptions.download
            ? {
                ...globalOptions.download,
                headers: globalOptions.download.headers
                  ? { ...globalOptions.download.headers }
                  : undefined,
              }
            : undefined,
          ...('browserRequest' in globalOptions
            ? { browserRequest: { ...(globalOptions.browserRequest as object) } }
            : {}),
        }
      : null;
    return {
      ...this.#context,
      getGlobalOptions: () => snapshot,
    };
  }
  #createOperationContext(operationId: string): DownloaderContext {
    return {
      ...this.#snapshotContext(),
      operationId,
      emit: <E extends import('@hls-downloader/shared').HlsDownloaderEvent>(
        event: E,
        payload?: Omit<HlsDownloaderEventPayload<E>, 'operationId'>,
      ) => {
        this.#onEvent?.(event, { operationId, ...payload } as HlsDownloaderEventPayload<E>);
      },
    };
  }
  async init(): Promise<void> {
    if (this.#isInit) return;
    if (!this.#initPromise) {
      this.#initPromise = this.#adapter
        .init(injectContext(null, this.#context))
        .then(() => {
          this.#isInit = true;
        })
        .catch((err) => {
          this.#initPromise = null;
          throw err;
        });
    }
    return this.#initPromise;
  }
  setOptions(options: GlobalOptions<T>): void {
    this.#globalOptions = options;
  }
  get globalOptions(): GlobalOptions<T> | null {
    if (!isRegisteredAdapter(this.#adapterProxy)) return null;
    return this.#globalOptions;
  }
  #snapshotRequestOptions<O extends HlsDownloaderFetchOptions>(options: O): O {
    const request = (options as O & { browserRequest?: object }).browserRequest;
    const decryption = (options as O & { decryption?: HlsDecryptionOptions }).decryption;
    return {
      ...options,
      ...('timeline' in options && options.timeline
        ? { timeline: structuredClone(options.timeline) }
        : {}),
      ...('timelineReport' in options && options.timelineReport
        ? { timelineReport: structuredClone(options.timelineReport) }
        : {}),
      ...('track' in options && options.track ? { track: { ...(options.track as object) } } : {}),
      ...(decryption
        ? {
            decryption: {
              ...decryption,
              limits: decryption.limits && { ...decryption.limits },
              keyFormats: decryption.keyFormats?.map((f) => ({ ...f, versions: [...f.versions] })),
            },
          }
        : {}),
      ...(options.headers ? { headers: { ...options.headers } } : {}),
      ...('audio' in options && options.audio ? { audio: { ...(options.audio as object) } } : {}),
      ...('subtitle' in options && options.subtitle
        ? { subtitle: { ...(options.subtitle as object) } }
        : {}),
      ...(request ? { browserRequest: { ...request } } : {}),
    };
  }
  async parseMediaPlaylist(text: string, url: string): Promise<HlsMediaPlaylist> {
    if (!this.#adapter.parseMediaPlaylist)
      throw new HlsDownloaderError(
        HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
        'Structured playlist parsing is unavailable',
      );
    return this.#adapter.parseMediaPlaylist(text, url);
  }
  async parseHls(
    options: HlsDownloaderFetchOptions & HlsDownloaderConfigFactory<T>['requestOptions'],
  ): Promise<ParseHlsResult> {
    return await this.#adapter.parseHls(
      injectContext(this.#snapshotRequestOptions(options), this.#snapshotContext()),
    );
  }
  async download(
    options: HlsDownloaderFetchOptions &
      HlsDownloaderDownloadOptions &
      Partial<HlsDownloaderConfigFactory<T>['additionalOptions']> &
      Partial<HlsDownloaderConfigFactory<T>['downloadOnlyOptions']> &
      HlsDownloaderConfigFactory<T>['requestOptions'],
  ): Promise<HlsDownloaderConfigFactory<T>['downloadResult'] & { operationId: string }> {
    options = this.#snapshotRequestOptions(options);
    const operationId = options.operationId ?? globalThis.crypto.randomUUID();
    options = { ...options, operationId };
    const context = this.#createOperationContext(operationId);
    await this.init();
    try {
      if (
        (options as Record<string, unknown>).resume !== undefined &&
        !this.capabilities.resumableDownload
      ) {
        throw new HlsDownloaderError(
          HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
          'Recovery is not supported by this adapter',
        );
      }
      if ((this.#globalOptions as Record<string, unknown> | null)?.resume !== undefined) {
        throw new HlsDownloaderError(
          HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
          'Recovery is a per-download option',
        );
      }
      const result = await this.#adapter.download(injectContext(options, context));
      return {
        ...(result as object),
        operationId,
      } as HlsDownloaderConfigFactory<T>['downloadResult'] & {
        operationId: string;
      };
    } catch (cause) {
      const error = normalizeHlsError(
        cause,
        options.transcode
          ? HlsDownloaderErrorCode.TRANSCODE_FAILED
          : HlsDownloaderErrorCode.TRANSMUX_FAILED,
        { adapter: this.#adapter.name, url: options.url },
      );
      context.emit?.(HlsDownloaderEvent.ERROR, { error });
      throw error;
    }
  }
  async getPosterUrl(
    options: HlsDownloaderFetchOptions & HlsDownloaderConfigFactory<T>['requestOptions'],
  ): Promise<string | undefined> {
    return await this.#adapter.getPosterUrl(
      injectContext(this.#snapshotRequestOptions(options), this.#snapshotContext()),
    );
  }
  async downloadToStream(
    options: HlsDownloaderFetchOptions &
      HlsDownloaderDownloadOptions &
      HlsDownloaderConfigFactory<T>['requestOptions'],
    onChunk: (bytes: Uint8Array) => void,
  ): Promise<HlsDownloaderStreamResult> {
    options = this.#snapshotRequestOptions(options);
    const operationId = options.operationId ?? globalThis.crypto.randomUUID();
    options = { ...options, operationId };
    const context = this.#createOperationContext(operationId);
    await this.init();
    try {
      if ((options as Record<string, unknown>).resume !== undefined) {
        throw new HlsDownloaderError(
          HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
          'Recovery is not supported for streaming output',
        );
      }
      const result = await this.#adapter.downloadToStream(injectContext(options, context), onChunk);
      return { ...result, operationId };
    } catch (cause) {
      const error = normalizeHlsError(cause, HlsDownloaderErrorCode.TRANSMUX_FAILED, {
        adapter: this.#adapter.name,
        url: options.url,
      });
      context.emit?.(HlsDownloaderEvent.ERROR, { error });
      throw error;
    }
  }
  async downloadSubtitles(
    options: HlsDownloaderSubtitleOptions & HlsDownloaderConfigFactory<T>['requestOptions'],
  ): Promise<HlsDownloaderSubtitleResult> {
    options = this.#snapshotRequestOptions(options);
    const operationId = options.operationId ?? globalThis.crypto.randomUUID();
    options = { ...options, operationId };
    const context = this.#createOperationContext(operationId);
    try {
      if (!this.capabilities.subtitleExport || !this.#adapter.downloadSubtitles)
        throw new HlsDownloaderError(
          HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
          'Subtitle export is unavailable',
        );
      await this.init();
      return {
        ...(await this.#adapter.downloadSubtitles(injectContext(options, context))),
        operationId,
      };
    } catch (cause) {
      const error = normalizeHlsError(cause, HlsDownloaderErrorCode.SUBTITLE_INVALID, {
        adapter: this.#adapter.name,
        url: options.url,
      });
      context.emit?.(HlsDownloaderEvent.ERROR, { error });
      throw error;
    }
  }
  /** Write fMP4 with backpressure. Owns the writer until close, failure or cancellation. */
  async downloadToWritable(
    options: HlsDownloaderWritableOptions & HlsDownloaderConfigFactory<T>['requestOptions'],
    writable: WritableStream<Uint8Array>,
  ): Promise<HlsDownloaderStreamResult> {
    options = this.#snapshotRequestOptions(options);
    const operationId = options.operationId ?? globalThis.crypto.randomUUID();
    options = { ...options, operationId };
    const context = this.#createOperationContext(operationId);
    const controller = new AbortController();
    const aborted = () =>
      new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Operation aborted');
    const onAbort = () => controller.abort(aborted());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    const wait = async <R>(promise: Promise<R>): Promise<R> => {
      const signal = controller.signal;
      let listener: (() => void) | undefined;
      const cancellation = new Promise<never>((_, reject) => {
        listener = () => reject(signal.reason);
        signal.addEventListener('abort', listener, { once: true });
        if (signal.aborted) listener();
      });
      try {
        return await Promise.race([promise, cancellation]);
      } finally {
        if (listener) signal.removeEventListener('abort', listener);
      }
    };
    const output = async (action: () => Promise<void>) => {
      try {
        await wait(action());
      } catch (cause) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new HlsDownloaderError(
          HlsDownloaderErrorCode.OUTPUT_WRITE_FAILED,
          'Writable output failed',
          { cause, adapter: this.#adapter.name },
        );
      }
    };
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (
        !this.capabilities.writableOutput ||
        !this.#adapter.downloadToWritable ||
        options.transcode !== undefined ||
        (options as Record<string, unknown>).resume !== undefined
      ) {
        throw new HlsDownloaderError(
          HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
          'This output requires a writable-capable adapter and does not support transcoding',
        );
      }
      const acquire = () => {
        if (writer) return;
        try {
          writer = writable.getWriter();
        } catch (cause) {
          throw new HlsDownloaderError(
            HlsDownloaderErrorCode.OUTPUT_WRITE_FAILED,
            'Cannot acquire output writer',
            { cause },
          );
        }
        // Observe asynchronous sink failures even while waiting for a network request.
        void writer.closed.catch((cause) => {
          if (!controller.signal.aborted)
            controller.abort(
              new HlsDownloaderError(
                HlsDownloaderErrorCode.OUTPUT_WRITE_FAILED,
                'Writable output failed',
                { cause },
              ),
            );
        });
      };
      if (!options.timeline) acquire();
      await wait(this.init());
      const result = await this.#adapter.downloadToWritable(
        injectContext({ ...options, signal: controller.signal }, context),
        (bytes) => {
          acquire();
          return output(() => writer!.write(bytes));
        },
      );
      acquire();
      await output(() => writer!.close());
      context.emit?.(HlsDownloaderEvent.READY_FOR_DOWNLOAD);
      return { ...result, operationId };
    } catch (cause) {
      const error = normalizeHlsError(cause, HlsDownloaderErrorCode.TRANSMUX_FAILED, {
        adapter: this.#adapter.name,
        url: options.url,
      });
      controller.abort(error);
      // A user sink may never settle its in-flight write. Do not make cancellation
      // depend on that sink; observe abort rejection without delaying cleanup.
      if (writer) void writer.abort(error).catch(() => {});
      context.emit?.(HlsDownloaderEvent.ERROR, { error });
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      writer?.releaseLock();
    }
  }

  async downloadOutputs(
    options: HlsDownloaderOutputsOptions &
      Partial<HlsDownloaderConfigFactory<T>['additionalOptions']> &
      HlsDownloaderConfigFactory<T>['requestOptions'],
  ): Promise<HlsOutputsResult<HlsDownloaderConfigFactory<T>['downloadResult']>> {
    options = this.#snapshotRequestOptions(options);
    const operationId = options.operationId ?? globalThis.crypto.randomUUID();
    const context = this.#createOperationContext(operationId);
    try {
      if (!this.#adapter.downloadOutputs || !this.capabilities.timeline)
        throw new HlsDownloaderError(
          HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
          'Multiple outputs unavailable',
        );
      await this.init();
      const result = await this.#adapter.downloadOutputs(
        injectContext({ ...options, operationId }, context),
      );
      return { ...result, operationId } as HlsOutputsResult<
        HlsDownloaderConfigFactory<T>['downloadResult']
      >;
    } catch (cause) {
      const error = normalizeHlsError(cause, HlsDownloaderErrorCode.TIMELINE_FAILED, {
        adapter: this.#adapter.name,
        url: options.url,
      });
      context.emit?.(HlsDownloaderEvent.ERROR, { error });
      throw error;
    }
  }
  async downloadToWritables(
    options: HlsDownloaderOutputsOptions & HlsDownloaderConfigFactory<T>['requestOptions'],
    outputFactory: HlsOutputFactory,
  ): Promise<
    HlsDownloaderStreamResult & {
      timelineReport: import('@hls-downloader/shared').HlsTimelineReport;
    }
  > {
    options = this.#snapshotRequestOptions(options);
    const operationId = options.operationId ?? globalThis.crypto.randomUUID();
    const context = this.#createOperationContext(operationId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const manager = createOutputManager(outputFactory, controller.signal, () => controller.abort());
    try {
      if (!this.#adapter.downloadToWritables || !this.capabilities.timeline)
        throw new HlsDownloaderError(
          HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
          'Multiple writable outputs unavailable',
        );
      await this.init();
      const result = await this.#adapter.downloadToWritables(
        injectContext({ ...options, operationId, signal: controller.signal }, context),
        manager.write,
        manager.control,
      );
      if (controller.signal.aborted)
        throw new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Operation aborted');
      context.emit?.(HlsDownloaderEvent.READY_FOR_DOWNLOAD);
      return { ...result, operationId };
    } catch (cause) {
      const error = manager.error(cause);
      controller.abort();
      context.emit?.(HlsDownloaderEvent.ERROR, { error });
      throw error;
    } finally {
      manager.dispose();
      options.signal?.removeEventListener('abort', abort);
    }
  }
  async downloadSubtitleOutputs(
    options: HlsDownloaderSubtitleOutputsOptions & HlsDownloaderConfigFactory<T>['requestOptions'],
  ): Promise<{ operationId: string; outputs: HlsSidecar[]; totalSegments: number }> {
    options = this.#snapshotRequestOptions(options);
    const operationId = options.operationId ?? globalThis.crypto.randomUUID();
    const context = this.#createOperationContext(operationId);
    try {
      if (!this.#adapter.downloadSubtitleOutputs)
        throw new HlsDownloaderError(
          HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
          'Timeline subtitles unavailable',
        );
      await this.init();
      const result = await this.#adapter.downloadSubtitleOutputs(
        injectContext({ ...options, operationId }, context),
      );
      context.emit?.(HlsDownloaderEvent.READY_FOR_DOWNLOAD);
      return { ...result, operationId };
    } catch (cause) {
      const error = normalizeHlsError(cause, HlsDownloaderErrorCode.SUBTITLE_INVALID, {
        adapter: this.#adapter.name,
        url: options.url,
      });
      context.emit?.(HlsDownloaderEvent.ERROR, { error });
      throw error;
    }
  }
  /** 清空 adapter 内部的 parseHls / poster 缓存。adapter 未实现时为 no-op。 */
  clearCache(): void {
    this.#adapter.clearCache?.();
  }
}

export default HlsDownloader;
