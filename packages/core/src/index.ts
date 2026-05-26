import {
  getInternalAdapter,
  injectContext,
  isRegisteredAdapter,
  ParseHlsResult,
} from '@hls-downloader/shared';

import type {
  DownloaderContext,
  HlsDownloaderAdapter,
  HlsDownloaderAdapterInternal,
  HlsDownloaderGlobalDownloadOptions,
  HlsDownloaderFetchOptions,
  HlsDownloaderTranscodeOptions,
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
  get isInit(): boolean {
    return this.#isInit;
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
    this.#context = {
      internal: this.#adapter,
      getGlobalOptions: () => this.globalOptions,
    };
    this.#adapter.onEvent = onEvent;
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
    options: HlsDownloaderFetchOptions,
  ): Promise<HlsDownloaderConfigFactory<T>['downloadResult']> {
    await this.init();
    return (await this.#adapter.download(
      injectContext(options, this.#context),
    )) as HlsDownloaderConfigFactory<T>['downloadResult'];
  }
  async getPosterUrl(options: HlsDownloaderFetchOptions): Promise<string | undefined> {
    return await this.#adapter.getPosterUrl(injectContext(options, this.#context));
  }
}

export default HlsDownloader;
