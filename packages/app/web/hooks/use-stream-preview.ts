'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HlsDownloader from '@hls-downloader/core';
import { BrowserAdapter } from '@hls-downloader/adapters/browser';
import { toast } from 'sonner';

const DIALOG_EXIT_MS = 120;
const MSE_MIME_TYPE = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';

type StreamPreviewState = {
  open: boolean;
  url: string;
  title: string;
  loading: boolean;
  headers?: Record<string, string>;
};

const CLOSED_STATE: StreamPreviewState = { open: false, url: '', title: '', loading: false };

export function useStreamPreview() {
  const downloader = useMemo(() => new HlsDownloader({ adapter: BrowserAdapter }), []);
  const [preview, setPreview] = useState<StreamPreviewState>(CLOSED_STATE);
  const videoRef = useRef<HTMLVideoElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    setPreview(CLOSED_STATE);
  }, []);

  const open = useCallback((url: string, title: string, headers?: Record<string, string>) => {
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(MSE_MIME_TYPE)) {
      toast.error('当前浏览器不支持该视频编码的流式预览');
      return;
    }
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setPreview({ open: true, url, title, loading: true, headers });
    }, DIALOG_EXIT_MS);
  }, []);

  useEffect(() => {
    if (!preview.open || !preview.url) return;
    const video = videoRef.current;
    if (!video) return;
    const controller = new AbortController();
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    const chunks: Uint8Array[] = [];
    let sourceBuffer: SourceBuffer | null = null;
    let ended = false;

    const fail = (error: unknown) => {
      if (controller.signal.aborted) return;
      toast.error(`流式预览失败: ${error instanceof Error ? error.message : String(error)}`);
      setPreview((current) => ({ ...current, loading: false }));
    };
    const flush = () => {
      if (!sourceBuffer || sourceBuffer.updating || chunks.length === 0) return;
      try {
        sourceBuffer.appendBuffer(chunks.shift()!.slice());
      } catch (error) {
        fail(error);
      }
    };
    const finish = () => {
      if (!sourceBuffer?.updating && mediaSource.readyState === 'open') {
        try {
          mediaSource.endOfStream();
        } catch {}
      }
    };
    const onUpdateEnd = () => {
      if (chunks.length > 0) flush();
      else if (ended) finish();
    };
    const onLoadedData = () =>
      setPreview((current) => (current.open ? { ...current, loading: false } : current));
    const onVideoError = () => fail(video.error ?? new Error('unknown playback error'));
    const onSourceOpen = async () => {
      try {
        sourceBuffer = mediaSource.addSourceBuffer(MSE_MIME_TYPE);
        sourceBuffer.addEventListener('updateend', onUpdateEnd);
        await downloader.downloadToStream(
          {
            url: preview.url,
            headers: preview.headers,
            operationId: globalThis.crypto.randomUUID(),
            signal: controller.signal,
          },
          (bytes) => {
            chunks.push(bytes);
            flush();
          },
        );
        ended = true;
        finish();
      } catch (error) {
        fail(error);
      }
    };

    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('error', onVideoError);
    mediaSource.addEventListener('sourceopen', onSourceOpen);
    video.src = objectUrl;

    return () => {
      controller.abort();
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('error', onVideoError);
      mediaSource.removeEventListener('sourceopen', onSourceOpen);
      sourceBuffer?.removeEventListener('updateend', onUpdateEnd);
      if (mediaSource.readyState === 'open') {
        try {
          mediaSource.endOfStream();
        } catch {}
      }
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };
  }, [downloader, preview.headers, preview.open, preview.url]);

  useEffect(
    () => () => {
      if (openTimer.current) clearTimeout(openTimer.current);
    },
    [],
  );

  return { preview, videoRef, open, close };
}
