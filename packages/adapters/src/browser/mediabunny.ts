import {
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
};

export async function transmuxHlsToMp4Buffer({
  url,
  headers,
  segmentUrls = [],
  onSegmentLoaded,
}: TransmuxHlsToMp4BufferOptions): Promise<ArrayBuffer> {
  const normalizedSegments = new Set(segmentUrls.map((segmentUrl) => resolveUrl(segmentUrl, url)));
  const loadedSegments = new Set<string>();
  const sourceCache = new Map<string, Promise<ArrayBuffer>>();

  const source = new CustomPathedSource(url, async ({ path }) => {
    const resolvedUrl = resolveUrl(String(path), url);
    const bufferPromise = sourceCache.get(resolvedUrl) ?? fetchBuffer(resolvedUrl, headers);
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

async function fetchBuffer(url: string, headers?: Record<string, string>): Promise<ArrayBuffer> {
  const response = await fetch(url, { headers });
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
