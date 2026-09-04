import type {
  HlsDownloaderAdapter,
  HlsDownloaderAdapterInternal,
  HlsDownloaderEvent,
  HlsDownloaderEventPayload,
  ParseHlsResult,
  Playlist,
  VariantSelector,
} from './types';

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
  readonly operationId?: string;
  emit?<E extends HlsDownloaderEvent>(
    event: E,
    payload?: Omit<HlsDownloaderEventPayload<E>, 'operationId'>,
  ): void;
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

export function emitAdapterEvent<E extends HlsDownloaderEvent>(
  internal: HlsDownloaderAdapterInternal,
  options: Record<string, unknown>,
  event: E,
  payload?: Omit<HlsDownloaderEventPayload<E>, 'operationId'>,
): void {
  const context = readContext(options);
  if (!context || context.internal !== internal) return;
  context.emit?.(event, payload);
}

const AUDIO_CODEC_RE = /^(mp4a|ac-3|ec-3|opus|fLaC|alac|dts)[.a-zA-Z0-9-]*$/i;

/**
 * 判断 codecs 列表是否仅含音频（无视频 codec）。
 * 无 codecs 信息时返回 false，交由 resolution 等其它维度判断。
 */
export function isAudioOnlyCodecs(codecs?: string): boolean {
  if (!codecs) return false;
  const parts = codecs
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((c) => AUDIO_CODEC_RE.test(c));
}

function codecMatches(codecs: string | undefined, prefix: string): boolean {
  if (!codecs) return false;
  const lower = prefix.toLowerCase();
  return codecs
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .some((c) => c.startsWith(lower));
}

/**
 * 默认 variant 选择策略。选择流程：
 * 1. 按 `options` 过滤：纯音频（除非 includeAudioOnly）、maxResolution、maxBandwidth；
 *    过滤后为空则回退到过滤前列表（避免极端 manifest 无可选）。
 * 2. 优先级排序：preferredCodec 命中 > preferredAudio 命中 > resolution 像素数 > bandwidth。
 * 3. 无 options 时退化为“最高分辨率 → 最高带宽”（兼容旧行为）。
 */
export const selectBestVariant: VariantSelector = (playlists, options): Playlist | undefined => {
  if (!playlists.length) return undefined;

  const candidates = playlists.filter((p) => {
    if (!options?.includeAudioOnly && p.isAudioOnly) return false;
    if (options?.maxResolution && p.resolution) {
      if (
        p.resolution.width * p.resolution.height >
        options.maxResolution.width * options.maxResolution.height
      ) {
        return false;
      }
    }
    if (options?.maxBandwidth !== undefined && p.bandwidth > options.maxBandwidth) {
      return false;
    }
    return true;
  });
  const pool = candidates.length > 0 ? candidates : playlists;

  const hasPref =
    !!options?.preferredCodec ||
    !!options?.preferredAudio ||
    !!options?.maxResolution ||
    options?.maxBandwidth !== undefined;
  if (!hasPref) {
    // 无偏好：最高分辨率 → 最高带宽（兼容旧行为）
    return pool.reduce((best, cur) => {
      const bestPixels = best.resolution ? best.resolution.width * best.resolution.height : 0;
      const curPixels = cur.resolution ? cur.resolution.width * cur.resolution.height : 0;
      if (curPixels !== bestPixels) return curPixels > bestPixels ? cur : best;
      return cur.bandwidth > best.bandwidth ? cur : best;
    });
  }

  // 打分排序：preferredCodec(4) > preferredAudio(2) > resolution(1, 降序) > bandwidth(降序)
  const scored = pool.map((p) => {
    let score = 0;
    if (options?.preferredCodec && codecMatches(p.codecs, options.preferredCodec)) score += 4;
    if (options?.preferredAudio && codecMatches(p.codecs, options.preferredAudio)) score += 2;
    return { p, score };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aPixels = a.p.resolution ? a.p.resolution.width * a.p.resolution.height : 0;
    const bPixels = b.p.resolution ? b.p.resolution.width * b.p.resolution.height : 0;
    if (bPixels !== aPixels) return bPixels - aPixels;
    return b.p.bandwidth - a.p.bandwidth;
  });
  return scored[0]?.p;
};

/** m3u8-parser 解析出的 manifest 最小结构（仅声明 mapManifest 用到的字段）。 */
type ManifestAttributes = {
  CODECS?: string;
  RESOLUTION?: { width: number; height: number };
  BANDWIDTH?: number;
  'FRAME-RATE'?: string | number;
  NAME?: string;
};
type ManifestPlaylist = { attributes?: ManifestAttributes; uri: string };
type ManifestSegment = { uri: string; [key: string]: any };
type M3u8Manifest = {
  playlists?: ManifestPlaylist[];
  segments?: ManifestSegment[];
};

/**
 * 把 m3u8-parser 解析出的 manifest 映射为 `ParseHlsResult`（纯函数，无副作用）。
 * - master：映射 variants 为 `Playlist[]`（含相对 URI 解析、`isAudioOnly` 判定、`name` 推导）。
 * - media：映射 segments，保留 m3u8-parser 原始字段（key/map/byterange 等），仅解析 URI。
 * - 空 playlist 且空 segment 时抛 `'No playlists or segments found'`。
 *
 * 从 browser adapter 的 `parseHls` 中抽出，使其可在 node/vitest 中被单元测试。
 */
export function mapManifest(manifest: M3u8Manifest, base: string): ParseHlsResult {
  if (manifest.playlists?.length) {
    const groups = manifest.playlists
      .filter((g) => g && g.attributes)
      .map((g) => {
        const codecs: string | undefined = g.attributes.CODECS;
        const resolution = g.attributes.RESOLUTION
          ? {
              width: g.attributes.RESOLUTION.width as number,
              height: g.attributes.RESOLUTION.height as number,
            }
          : undefined;
        const frameRateRaw = g.attributes['FRAME-RATE'];
        const frameRate =
          frameRateRaw != null && !Number.isNaN(Number(frameRateRaw))
            ? Number(frameRateRaw)
            : undefined;
        const isAudioOnly = !g.attributes.RESOLUTION && isAudioOnlyCodecs(codecs);
        return {
          name: g.attributes.NAME
            ? g.attributes.NAME
            : g.attributes.RESOLUTION
              ? `${g.attributes.RESOLUTION.width}x${g.attributes.RESOLUTION.height}`
              : `MAYBE_AUDIO:${g.attributes.BANDWIDTH}`,
          bandwidth: g.attributes.BANDWIDTH,
          uri: g.uri.startsWith('http') ? g.uri : base.replace('{{URL}}', g.uri),
          resolution,
          codecs,
          frameRate,
          isAudioOnly,
        } as Playlist;
      });

    if (groups.length > 0) {
      return {
        type: 'playlist',
        data: groups,
      };
    }
  }

  if (manifest.segments?.length) {
    const resolveUri = (uri: string) =>
      uri.startsWith('http') ? uri : base.replace('{{URL}}', uri);

    const segments = manifest.segments.map((s) => {
      const mapped: Record<string, unknown> = { ...s, uri: resolveUri(s.uri) };
      if (s.map && typeof s.map === 'object' && 'uri' in s.map) {
        mapped.map = { ...s.map, uri: resolveUri((s.map as { uri: string }).uri) };
      }
      return mapped;
    });

    return {
      type: 'segment',
      data: segments as ManifestSegment[],
    };
  }

  throw new Error('No playlists or segments found');
}
