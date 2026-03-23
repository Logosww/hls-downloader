import type { HlsDownloaderAdapter, HlsDownloaderAdapterInternal, Playlist } from './types';

const instances = new WeakMap();

export function createAdapter(adapter: HlsDownloaderAdapterInternal) {
  const proxy = new Proxy(Object.create(null), {
    get(target, prop) {
      if (prop === 'onEvent') {
        return Reflect.get(target, prop);
      }

      return undefined;
    },
    set(target, prop, value) {
      if (prop === 'onEvent') {
        Reflect.set(target, prop, value);

        return true;
      }

      throw new TypeError(`Cannot set property ${String(prop)} on ${String(target)}`);
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
  });
  instances.set(proxy, adapter);

  return proxy as HlsDownloaderAdapter;
}

export function getInternalAdapter(adapter: HlsDownloaderAdapter) {
  return instances.get(adapter) as HlsDownloaderAdapterInternal;
}

/**
 * Select the variant with the highest bandwidth from a master playlist.
 * Falls back to the first entry when the list is non-empty.
 */
export function selectBestVariant(playlists: Playlist[]): Playlist | undefined {
  if (!playlists.length) return undefined;
  return playlists.reduce((best, cur) => (cur.bandwidth > best.bandwidth ? cur : best));
}
