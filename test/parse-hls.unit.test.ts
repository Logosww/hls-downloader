import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Parser } from 'm3u8-parser';
import { describe, expect, it } from 'vitest';

import { mapManifest, type ParseHlsResult } from '@hls-downloader/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, 'fixtures/m3u8');
// 与 browser/node adapter 一致的 base 模板：相对 URI 用此拼接为绝对。
const BASE = 'https://example.com/path/{{URL}}';

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf8');
}

/** 用 m3u8-parser 解析 fixture 文本，再走共享 mapManifest 映射，返回最终 ParseHlsResult。 */
function mapFixture(name: string): ParseHlsResult {
  const parser = new Parser();
  parser.push(loadFixture(name));
  parser.end();
  return mapManifest(parser.manifest as any, BASE);
}

type Case = {
  file: string;
  type: 'playlist' | 'segment' | 'error';
  expectCount?: number;
};

const CASES: Case[] = [
  // master 类（来自 m3u8-rs sample-playlists）
  { file: 'master.m3u8', type: 'playlist', expectCount: 5 },
  { file: 'masterplaylist.m3u8', type: 'playlist', expectCount: 3 },
  { file: 'masterplaylist2.m3u8', type: 'playlist' },
  { file: 'master-with-multiple-codecs.m3u8', type: 'playlist', expectCount: 5 },
  { file: 'master-with-alternatives.m3u8', type: 'playlist', expectCount: 4 },
  { file: 'master-with-alternatives-2.m3u8', type: 'playlist' },
  { file: 'master-with-i-frame-stream-inf.m3u8', type: 'playlist' },
  { file: 'master-with-stream-inf-name.m3u8', type: 'playlist' },
  { file: 'master-with-offset.m3u8', type: 'playlist' },
  { file: 'master-not-ending-in-newline.m3u8', type: 'playlist', expectCount: 3 },
  { file: 'master-not-ending-in-newline-1.m3u8', type: 'playlist' },
  { file: 'master-playlist-with-blankline.m3u8', type: 'playlist' },
  // media 类（来自 m3u8-rs sample-playlists）
  { file: 'mediaplaylist.m3u8', type: 'segment', expectCount: 15 },
  { file: 'mediaplaylist-byterange.m3u8', type: 'segment' },
  { file: 'media-playlist-with-byterange.m3u8', type: 'segment', expectCount: 3 },
  { file: 'media-playlist-with-discontinuity.m3u8', type: 'segment', expectCount: 4 },
  { file: 'media-playlist-with-cues.m3u8', type: 'segment' },
  { file: 'media-playlist-with-cues-1.m3u8', type: 'segment' },
  { file: 'media-playlist-with-scte35.m3u8', type: 'segment' },
  { file: 'media-playlist-with-scte35-1.m3u8', type: 'segment' },
  { file: 'media-playlist-zero-decimal.m3u8', type: 'segment' },
  { file: 'media-not-ending-in-newline.m3u8', type: 'segment' },
  // 空 playlist + 空 segment → 抛错
  { file: 'media-playlist-without-segments.m3u8', type: 'error' },
  // 手写补齐 fixture（RFC 8216）
  { file: 'fmp4-map.m3u8', type: 'segment', expectCount: 3 },
  { file: 'sample-aes.m3u8', type: 'segment', expectCount: 2 },
  { file: 'master-subtitles.m3u8', type: 'playlist', expectCount: 2 },
];

describe('mapManifest — fixture 数据驱动', () => {
  it.each(CASES)('$file → $type', ({ file, type, expectCount }) => {
    if (type === 'error') {
      expect(() => mapFixture(file)).toThrow('No playlists or segments found');
      return;
    }

    const result = mapFixture(file);
    expect(result.type).toBe(type);
    const data = result.data!;
    expect(data.length).toBeGreaterThan(0);
    if (expectCount !== undefined) {
      expect(data.length).toBe(expectCount);
    }

    if (type === 'playlist') {
      for (const p of data) {
        expect(typeof p.bandwidth).toBe('number');
        // 相对 URI 必须被解析为绝对；绝对 URI 保持不变
        expect(p.uri.startsWith('http')).toBe(true);
      }
    } else {
      for (const s of data) {
        expect(s.uri.startsWith('http')).toBe(true);
        expect(typeof s.duration).toBe('number');
      }
    }
  });
});

describe('mapManifest — 结构性断言', () => {
  it('master.m3u8: 无 RESOLUTION/CODECS 的 variant 名称为 MAYBE_AUDIO:<bw> 且非 audio-only', () => {
    const result = mapFixture('master.m3u8');
    expect(result.type).toBe('playlist');
    const first = result.data![0]!;
    expect(first.bandwidth).toBe(300000);
    expect(first.name).toBe('MAYBE_AUDIO:300000');
    expect(first.isAudioOnly).toBe(false);
    // 相对 URI 被解析为绝对
    expect(first.uri).toBe('https://example.com/path/chunklist-b300000.m3u8');
  });

  it('master-with-alternatives.m3u8: mp4a.40.5 且无 RESOLUTION 的 variant 为 audio-only', () => {
    const result = mapFixture('master-with-alternatives.m3u8');
    expect(result.type).toBe('playlist');
    const audioOnly = result.data!.find((p) => p.isAudioOnly);
    expect(audioOnly).toBeDefined();
    expect(audioOnly!.bandwidth).toBe(65000);
    expect(audioOnly!.codecs).toBe('mp4a.40.5');
    expect(audioOnly!.name).toBe('MAYBE_AUDIO:65000');
  });

  it('master-subtitles.m3u8: 带 RESOLUTION 的 variant 名称为 WxH', () => {
    const result = mapFixture('master-subtitles.m3u8');
    expect(result.type).toBe('playlist');
    const names = result.data!.map((p) => p.name);
    expect(names).toContain('640x360');
    expect(names).toContain('1280x720');
  });

  it('mediaplaylist.m3u8: AES-128 key.uri 为绝对 URL（保持不变），LIVE 无 ENDLIST 不影响解析', () => {
    const result = mapFixture('mediaplaylist.m3u8');
    expect(result.type).toBe('segment');
    const first = result.data![0]!;
    // m3u8-parser 把 EXT-X-KEY 挂到 segment 上，mapManifest 保留 ...s
    expect(first.key?.uri).toBe('https://secure.domain.com');
    // 相对 segment URI 被解析为绝对
    expect(first.uri).toBe(
      'https://example.com/path/20140311T113819-01-338559live.ts',
    );
  });

  it('fmp4-map.m3u8: EXT-X-MAP 的 init segment uri 被解析为绝对', () => {
    const result = mapFixture('fmp4-map.m3u8');
    expect(result.type).toBe('segment');
    const first = result.data![0]!;
    expect(first.map?.uri).toBe('https://example.com/path/init.mp4');
  });

  it('media-playlist-with-byterange.m3u8: byterange 信息被保留（spread）', () => {
    const result = mapFixture('media-playlist-with-byterange.m3u8');
    expect(result.type).toBe('segment');
    expect(result.data!.length).toBe(3);
    // 3 个 segment 共用同一 URI，byterange 字段区分
    expect(result.data![0]!.byterange).toBeDefined();
    expect(result.data![0]!.uri).toBe('https://example.com/path/video.ts');
  });

  it('绝对 URI 的 segment 保持不变', () => {
    // 构造一个含绝对 segment URI 的 manifest
    const manifest = {
      segments: [{ uri: 'https://cdn.other.test/seg.ts', duration: 4 }],
    };
    const result = mapManifest(manifest as any, BASE);
    expect(result.type).toBe('segment');
    expect(result.data![0]!.uri).toBe('https://cdn.other.test/seg.ts');
  });
});
