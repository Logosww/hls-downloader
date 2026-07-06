import {
  AppendOnlyStreamTarget,
  BufferSource,
  BufferTarget,
  Conversion,
  CustomPathedSource,
  HLS_FORMATS,
  Input,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';

export type TransmuxHlsToMp4BufferOptions = {
  url: string;
  headers?: Record<string, string>;
  segmentUrls?: string[];
  onSegmentLoaded?: (loaded: number) => void;
  signal?: AbortSignal;
};

export type TransmuxHlsToMp4StreamOptions = {
  url: string;
  headers?: Record<string, string>;
  segmentUrls?: string[];
  onSegmentLoaded?: (loaded: number) => void;
  signal?: AbortSignal;
};

export async function transmuxHlsToMp4Buffer({
  url,
  headers,
  segmentUrls = [],
  onSegmentLoaded,
  signal,
}: TransmuxHlsToMp4BufferOptions): Promise<ArrayBuffer> {
  const normalizedSegments = new Set(segmentUrls.map((segmentUrl) => resolveUrl(segmentUrl, url)));
  const loadedSegments = new Set<string>();
  const sourceCache = new Map<string, Promise<ArrayBuffer>>();

  const source = new CustomPathedSource(url, async ({ path }) => {
    const resolvedUrl = resolveUrl(String(path), url);
    const bufferPromise = sourceCache.get(resolvedUrl) ?? fetchBuffer(resolvedUrl, headers, signal);
    sourceCache.set(resolvedUrl, bufferPromise);
    const buffer = await bufferPromise;

    if (normalizedSegments.has(resolvedUrl) && !loadedSegments.has(resolvedUrl)) {
      loadedSegments.add(resolvedUrl);
      onSegmentLoaded?.(loadedSegments.size);
    }

    return new BufferSource(buffer);
  });

  const input = new Input({ source, formats: HLS_FORMATS });
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });

  try {
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      showWarnings: false,
    });
    if (!conversion.isValid) {
      throw new Error('HLS cannot be transmuxed to MP4');
    }
    await conversion.execute();

    if (!target.buffer) {
      throw new Error('Mediabunny did not produce an MP4 buffer');
    }

    return target.buffer;
  } finally {
    input.dispose();
  }
}

export async function transmuxHlsToMp4Stream({
  url,
  headers,
  segmentUrls = [],
  onSegmentLoaded,
  signal,
}: TransmuxHlsToMp4StreamOptions): Promise<ReadableStream<Uint8Array>> {
  const normalizedSegments = new Set(segmentUrls.map((segmentUrl) => resolveUrl(segmentUrl, url)));
  const loadedSegments = new Set<string>();
  const sourceCache = new Map<string, Promise<ArrayBuffer>>();

  const source = new CustomPathedSource(url, async ({ path }) => {
    const resolvedUrl = resolveUrl(String(path), url);
    const bufferPromise = sourceCache.get(resolvedUrl) ?? fetchBuffer(resolvedUrl, headers, signal);
    sourceCache.set(resolvedUrl, bufferPromise);
    const buffer = await bufferPromise;

    if (normalizedSegments.has(resolvedUrl) && !loadedSegments.has(resolvedUrl)) {
      loadedSegments.add(resolvedUrl);
      onSegmentLoaded?.(loadedSegments.size);
    }

    return new BufferSource(buffer);
  });

  const input = new Input({ source, formats: HLS_FORMATS });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let settled = false;

      const settleClose = () => {
        if (settled) return;
        settled = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const settleError = (err: unknown) => {
        if (settled) return;
        settled = true;
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
      };

      const onAbort = () => {
        const err = new Error('Download aborted');
        err.name = 'AbortError';
        settleError(err);
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          input.dispose();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          controller.enqueue(chunk);
        },
      });

      const target = new AppendOnlyStreamTarget(writable);
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
        target,
      });

      void (async () => {
        try {
          const conversion = await Conversion.init({
            input,
            output,
            tracks: 'primary',
            showWarnings: false,
          });
          if (!conversion.isValid) {
            throw new Error('HLS cannot be transmuxed to MP4');
          }
          await conversion.execute();
          settleClose();
        } catch (err) {
          settleError(err);
        } finally {
          input.dispose();
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
        }
      })();
    },
    cancel() {
      input.dispose();
    },
  });
}

async function fetchBuffer(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return await response.arrayBuffer();
}

function resolveUrl(path: string, baseUrl: string): string {
  try {
    return new URL(path, baseUrl).href;
  } catch {
    return path;
  }
}
