import type { HlsDownloaderAdapter, HlsDownloaderAdapterInternal, Playlist } from './types';

const ADAPTER_BRAND = Symbol('hls-downloader.adapter');
const ADAPTER_INTERNAL = Symbol('hls-downloader.adapter.internal');
const DOWNLOADER_CONTEXT = Symbol('hls-downloader.downloader-context');

type BrandedAdapter = HlsDownloaderAdapter & {
  [ADAPTER_BRAND]?: true;
  [ADAPTER_INTERNAL]?: HlsDownloaderAdapterInternal;
};

type BrandedInternal = HlsDownloaderAdapterInternal & {
  [ADAPTER_BRAND]?: true;
};

export type DownloaderContext = {
  readonly internal: HlsDownloaderAdapterInternal;
  getGlobalOptions(): unknown | null;
};

function readContext(options?: Record<string, unknown>): DownloaderContext | undefined {
  return (options as { [DOWNLOADER_CONTEXT]?: DownloaderContext } | undefined)?.[
    DOWNLOADER_CONTEXT
  ];
}

export function createAdapter(adapter: HlsDownloaderAdapterInternal) {
  const target = Object.create(null) as BrandedAdapter;
  target[ADAPTER_BRAND] = true;
  target[ADAPTER_INTERNAL] = adapter;
  (adapter as BrandedInternal)[ADAPTER_BRAND] = true;

  const proxy = new Proxy(target, {
    get(target, prop, receiver) {
      if (prop === ADAPTER_BRAND || prop === ADAPTER_INTERNAL || prop === 'onEvent') {
        return Reflect.get(target, prop, receiver);
      }

      return undefined;
    },
    set(target, prop, value, receiver) {
      if (prop === 'onEvent') {
        Reflect.set(target, prop, value, receiver);

        return true;
      }

      throw new TypeError(`Cannot set property ${String(prop)} on adapter`);
    },
    ownKeys() {
      return [];
    },
    deleteProperty() {
      return false;
    },
    defineProperty() {
      return false;
    },
  }) as BrandedAdapter;

  return proxy as HlsDownloaderAdapter;
}

export function isRegisteredAdapter(
  adapter: HlsDownloaderAdapter,
): adapter is HlsDownloaderAdapter {
  return (adapter as BrandedAdapter)[ADAPTER_BRAND] === true;
}

export function getInternalAdapter(adapter: HlsDownloaderAdapter) {
  return (adapter as BrandedAdapter)[ADAPTER_INTERNAL] as HlsDownloaderAdapterInternal;
}

export function injectContext<O extends Record<string, unknown> | null>(
  options: O,
  context: DownloaderContext,
): O & { [key: symbol]: DownloaderContext } {
  return { ...options, [DOWNLOADER_CONTEXT]: context };
}

export function stripContext<O extends Record<string, unknown>>(options: O): O {
  const { [DOWNLOADER_CONTEXT]: _, ...rest } = options as O & {
    [DOWNLOADER_CONTEXT]?: DownloaderContext;
  };
  return rest as O;
}

export function getAdapterGlobalOptionsFromInternal<G = unknown>(
  internal: HlsDownloaderAdapterInternal,
  options?: Record<string, unknown>,
): G | null {
  if ((internal as BrandedInternal)[ADAPTER_BRAND] !== true) return null;

  const context = readContext(options);
  if (!context || context.internal !== internal) return null;

  return context.getGlobalOptions() as G | null;
}

/**
 * Select the variant with the highest bandwidth from a master playlist.
 * Falls back to the first entry when the list is non-empty.
 */
export function selectBestVariant(playlists: Playlist[]): Playlist | undefined {
  if (!playlists.length) return undefined;
  return playlists.reduce((best, cur) => (cur.bandwidth > best.bandwidth ? cur : best));
}
