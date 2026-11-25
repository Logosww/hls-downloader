import type { ParseHlsResult } from './types';

const DEFAULT_TTL = 5 * 60 * 1000; // 5 min
const DEFAULT_MAX_ENTRIES = 64;

type Entry<T> = { result: T; expiresAt: number };

export class ResultCache<T> {
  private readonly store = new Map<string, Entry<T>>();
  private readonly ttl: number;
  private readonly maxEntries: number;

  constructor(options?: { ttl?: number; maxEntries?: number }) {
    this.ttl = options?.ttl ?? DEFAULT_TTL;
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // LRU: 命中后移到末尾
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.result;
  }

  set(key: string, result: T): void {
    this.store.delete(key);
    this.store.set(key, { result, expiresAt: Date.now() + this.ttl });
    this.evict();
  }

  clear(): void {
    this.store.clear();
  }

  private evict(): void {
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}

export class ParseHlsCache extends ResultCache<ParseHlsResult> {
  override set(key: string, result: ParseHlsResult): void {
    if (result.type !== 'error') super.set(key, result);
  }
}

/** 轻量 djb2 哈希，避免把 header 明文落入 key。 */
function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * 构造 parseHls 缓存 key：URL + headers 稳定哈希。
 * headers 为空时退化为 URL 本身，行为与旧实现一致。
 */
export function buildParseHlsCacheKey(
  url: string,
  headers?: Record<string, string> | null,
): string {
  if (!headers) return url;
  const keys = Object.keys(headers);
  if (keys.length === 0) return url;
  const sorted = keys
    .sort()
    .map((k) => `${k.toLowerCase()}:${String(headers[k])}`)
    .join('&');
  return `${url}|h:${hashString(sorted)}`;
}
