'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HlsDownloader from '@hls-downloader/core';
import { BrowserAdapter } from '@hls-downloader/adapters/browser';
import type { Playlist } from '@hls-downloader/shared';

export type HlsMetadata = {
  filename: string;
  previewSrc: string;
  playlist: Playlist[];
};

function revokeBlobUrl(url?: string): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

export function useHlsMetadata() {
  const downloader = useMemo(() => new HlsDownloader({ adapter: BrowserAdapter }), []);
  const [metadata, setMetadata] = useState<HlsMetadata>();
  const requestId = useRef(0);
  const previewUrls = useRef(new Set<string>());

  useEffect(
    () => () => {
      requestId.current++;
      for (const url of previewUrls.current) revokeBlobUrl(url);
      previewUrls.current.clear();
    },
    [],
  );

  const resolveMetadata = useCallback(
    async (url: string, headers?: Record<string, string>): Promise<boolean> => {
      const currentRequest = ++requestId.current;
      const result = await downloader.parseHls({ url, headers });
      if (currentRequest !== requestId.current || result.type === 'error') return false;

      const playlist =
        result.type === 'playlist'
          ? result.data
          : [{ name: '默认', bandwidth: 0, uri: url } satisfies Playlist];
      if (playlist.length === 0) return false;

      setMetadata({ filename: '', previewSrc: '', playlist });

      try {
        const previewSrc = await downloader.getPosterUrl({ url: playlist[0]!.uri, headers });
        if (currentRequest !== requestId.current) {
          revokeBlobUrl(previewSrc);
          return true;
        }
        if (previewSrc) {
          if (previewSrc.startsWith('blob:')) previewUrls.current.add(previewSrc);
          setMetadata((current) => (current ? { ...current, previewSrc } : current));
        }
      } catch {
        // Poster extraction is optional and must not block a valid download.
      }
      return true;
    },
    [downloader],
  );

  return { metadata, resolveMetadata };
}
