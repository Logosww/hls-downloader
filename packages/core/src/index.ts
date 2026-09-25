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
  HlsDownloaderWritableOptions,
  HlsDownloaderTranscodeOptions,
  HlsDownloaderEventPayload,
} from '@hls-downloader/shared';

export { HlsDownloaderEvent } from '@hls-downloader/shared';

type HlsDownloaderConfigFactory<T> =
  T extends HlsDownloaderAdapterInternal<infer AdditionalOptions, infer DownloadResult>
    ? {
        additionalOptions: AdditionalOptions;
        downloadResult: DownloadResult;
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
  #createOperationContext(operationId: string): DownloaderContext {
    return {
      ...this.#context,
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
  async parseHls(options: HlsDownloaderFetchOptions): Promise<ParseHlsResult> {
    return await this.#adapter.parseHls(injectContext(options, this.#context));
  }
  async download(
    options: HlsDownloaderFetchOptions &
      HlsDownloaderDownloadOptions &
      Partial<HlsDownloaderConfigFactory<T>['additionalOptions']>,
  ): Promise<HlsDownloaderConfigFactory<T>['downloadResult'] & { operationId: string }> {
    const operationId = options.operationId ?? globalThis.crypto.randomUUID();
    await this.init();
    const context = this.#createOperationContext(operationId);
    try {
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
  async getPosterUrl(options: HlsDownloaderFetchOptions): Promise<string | undefined> {
    return await this.#adapter.getPosterUrl(injectContext(options, this.#context));
  }
  async downloadToStream(
    options: HlsDownloaderFetchOptions & HlsDownloaderDownloadOptions,
    onChunk: (bytes: Uint8Array) => void,
  ): Promise<HlsDownloaderStreamResult> {
    const operationId = options.operationId ?? globalThis.crypto.randomUUID();
    await this.init();
    const context = this.#createOperationContext(operationId);
    try {
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
  /** Write fMP4 with backpressure. Owns the writer until close, failure or cancellation. */
  async downloadToWritable(
    options: HlsDownloaderWritableOptions,
    writable: WritableStream<Uint8Array>,
  ): Promise<HlsDownloaderStreamResult> {
    const operationId = options.operationId ?? globalThis.crypto.randomUUID();
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
        options.transcode !== undefined
      ) {
        throw new HlsDownloaderError(
          HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
          'This output requires a writable-capable adapter and does not support transcoding',
        );
      }
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
      await wait(this.init());
      const result = await this.#adapter.downloadToWritable(
        injectContext({ ...options, signal: controller.signal }, context),
        (bytes) => output(() => writer!.write(bytes)),
      );
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
  /** 清空 adapter 内部的 parseHls / poster 缓存。adapter 未实现时为 no-op。 */
  clearCache(): void {
    this.#adapter.clearCache?.();
  }
}

export default HlsDownloader;
