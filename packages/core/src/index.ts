import { getInternalAdapter, ParseHlsResult } from '@hls-downloader/shared';

import type {
  HlsDownloaderAdapter,
  HlsDownloaderAdapterInternal,
  HlsDownloaderFetchOptions,
} from '@hls-downloader/shared';

export { HlsDownloaderEvent } from '@hls-downloader/shared';

type HlsDownloaderConfigFactory<T> =
  T extends HlsDownloaderAdapterInternal<infer AdditionalOptions, infer DownloadResult>
    ? {
        additionalOptions: AdditionalOptions;
        downloadResult: DownloadResult;
      }
    : never;

export class HlsDownloader<T extends HlsDownloaderAdapter> {
  #isInit: boolean = false;
  #initPromise: Promise<void> | null = null;
  #customOptions: Omit<HlsDownloaderFetchOptions, 'url'> = {};
  readonly #adapter: HlsDownloaderAdapterInternal;
  readonly #initOptions: any;
  get isInit(): boolean {
    return this.#isInit;
  }
  constructor({
    adapter,
    options,
    onEvent,
  }: {
    adapter: T;
    options?: Omit<HlsDownloaderFetchOptions, 'url'> &
      HlsDownloaderConfigFactory<T>['additionalOptions'];
    onEvent?: HlsDownloaderAdapter['onEvent'];
  }) {
    this.#customOptions = options ?? {};
    this.#initOptions = options;
    this.#adapter = getInternalAdapter(adapter) as HlsDownloaderAdapterInternal;
    this.#adapter.onEvent = onEvent;
  }
  async init(): Promise<void> {
    if (this.#isInit) return;
    if (!this.#initPromise) {
      this.#initPromise = this.#adapter
        .init(this.#initOptions)
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
  setOptions(
    options: Omit<HlsDownloaderFetchOptions, 'url'> &
      HlsDownloaderConfigFactory<T>['additionalOptions'],
  ): void {
    this.#customOptions = options;
  }
  async parseHls(options: HlsDownloaderFetchOptions): Promise<ParseHlsResult> {
    return await this.#adapter.parseHls({ ...this.#customOptions, ...options });
  }
  async download(
    options: HlsDownloaderFetchOptions,
  ): Promise<HlsDownloaderConfigFactory<T>['downloadResult']> {
    await this.init();
    return (await this.#adapter.download({
      ...this.#customOptions,
      ...options,
    })) as HlsDownloaderConfigFactory<T>['downloadResult'];
  }
  async getPosterUrl(options: HlsDownloaderFetchOptions): Promise<string | undefined> {
    return await this.#adapter.getPosterUrl({ ...this.#customOptions, ...options });
  }
}

export default HlsDownloader;
