'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HlsDownloader from '@hls-downloader/core';
import { BrowserAdapter } from '@hls-downloader/adapters/browser';
import type { Playlist, Rendition } from '@hls-downloader/shared';

export type HlsMetadata = {
  sourceUrl: string;
  filename: string;
  previewSrc: string;
  playlist: Playlist[];
  renditions?: Rendition[];
};

function revokeBlobUrl(url?: string): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

export function useHlsMetadata() {
  const downloader = useMemo(() => new HlsDownloader({ adapter: BrowserAdapter }), []);
  const [metadata, setMetadata] = useState<HlsMetadata>();
  const requestId = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const previewUrls = useRef(new Set<string>());

  useEffect(
    () => () => {
      requestId.current++;
      activeRequest.current?.abort();
      activeRequest.current = null;
      for (const url of previewUrls.current) revokeBlobUrl(url);
      previewUrls.current.clear();
    },
    [],
  );

  const resolveMetadata = useCallback(
    // null means superseded/unmounted, so callers must not show UI for this result.
    async (url: string, headers?: Record<string, string>): Promise<boolean | null> => {
      const currentRequest = ++requestId.current;
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      const { signal } = controller;
      const isCancelled = () => signal.aborted || currentRequest !== requestId.current;

      const resolve = async (): Promise<boolean | null> => {
        const result = await downloader.parseHls({ url, headers, signal });
        if (isCancelled()) return null;
        if (result.type === 'error') return false;

        const playlist =
          result.type === 'playlist'
            ? result.data
            : [{ name: '默认', bandwidth: 0, uri: url } satisfies Playlist];
        if (playlist.length === 0) return false;

        setMetadata({
          sourceUrl: url,
          filename: '',
          previewSrc: '',
          playlist,
          renditions: result.type === 'playlist' ? result.renditions : undefined,
        });

        try {
          const previewSrc = await downloader.getPosterUrl({
            url: playlist[0]!.uri,
            headers,
            signal,
          });
          if (isCancelled()) {
            revokeBlobUrl(previewSrc);
            return null;
          }
          if (previewSrc) {
            if (previewSrc.startsWith('blob:')) previewUrls.current.add(previewSrc);
            setMetadata((current) => (current ? { ...current, previewSrc } : current));
          }
        } catch {
          // Poster extraction is optional and must not block a valid download.
        }
        return isCancelled() ? null : true;
      };
      return resolve().finally(() => {
        // An older operation must never clear the newer operation's controller.
        if (activeRequest.current === controller) activeRequest.current = null;
      });
    },
    [downloader],
  );

  return { metadata, resolveMetadata };
}
