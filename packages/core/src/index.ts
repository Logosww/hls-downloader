import { getInternalAdapter, ParseHlsResult, DownloadResult } from '@hls-downloader/shared';

import type {
  HlsDownloaderAdapter,
  HlsDownloaderAdapterInternal,
  HlsDownloaderFetchOption,
} from '@hls-downloader/shared';

export { HlsDownloaderEvent } from '@hls-downloader/shared';

export type GetAdditionalOption<T> =
  T extends HlsDownloaderAdapterInternal<infer AdditionalOption> ? AdditionalOption : never;

export class HlsDownloader<T extends HlsDownloaderAdapter> {
  #isInit: boolean = false;
  #initPromise: Promise<void> | null = null;
  #customOption: Omit<HlsDownloaderFetchOption, 'url'> = {};
  readonly #adapter: HlsDownloaderAdapterInternal;
  readonly #initOption: any;
  get isInit(): boolean {
    return this.#isInit;
  }
  constructor({
    adapter,
    option,
    onEvent,
  }: {
    adapter: T;
    option?: Omit<HlsDownloaderFetchOption, 'url'> & GetAdditionalOption<T>;
    onEvent?: HlsDownloaderAdapter['onEvent'];
  }) {
    this.#customOption = option || {};
    this.#initOption = option;
    this.#adapter = getInternalAdapter(adapter) as HlsDownloaderAdapterInternal;
    this.#adapter.onEvent = onEvent;
  }
  async init(): Promise<void> {
    if (this.#isInit) return;
    if (!this.#initPromise) {
      this.#initPromise = this.#adapter
        .init(this.#initOption)
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
  setOption(option: Omit<HlsDownloaderFetchOption, 'url'> & GetAdditionalOption<T>): void {
    this.#customOption = option;
  }
  async parseHls(option: HlsDownloaderFetchOption): Promise<ParseHlsResult> {
    return await this.#adapter.parseHls({ ...this.#customOption, ...option });
  }
  async download(option: HlsDownloaderFetchOption): Promise<DownloadResult> {
    await this.init();
    return await this.#adapter.download({ ...this.#customOption, ...option });
  }
  async getPosterUrl(option: HlsDownloaderFetchOption): Promise<string | undefined> {
    return await this.#adapter.getPosterUrl({ ...this.#customOption, ...option });
  }
}

export default HlsDownloader;
