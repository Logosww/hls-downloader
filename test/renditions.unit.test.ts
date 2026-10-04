import { mergeWebVtt } from '../packages/adapters/src/subtitles';
import { describe, expect, it } from 'vitest';
import { type Rendition } from '@hls-downloader/shared';
import { selectAudio, parseManifest } from '../packages/adapters/src/renditions';
const track = (name: string, extra: Partial<Rendition> = {}): Rendition => ({
  type: 'audio',
  groupId: 'a',
  name,
  default: false,
  autoselect: false,
  forced: false,
  ...extra,
});
describe('rendition selection', () => {
  it('restricts selection to the variant group and ranks defaults then autoselect', () => {
    const tracks = [
      track('other', { groupId: 'b', default: true }),
      track('first'),
      track('auto', { autoselect: true }),
      track('default', { default: true }),
    ];
    expect(selectAudio(tracks, 'a')?.name).toBe('default');
    expect(selectAudio(tracks.slice(0, 3), 'a')?.name).toBe('auto');
    expect(selectAudio(tracks.slice(0, 2), 'a')?.name).toBe('first');
    expect(() => selectAudio(tracks, 'a', { groupId: 'b', name: 'other' })).toThrowError(
      expect.objectContaining({ code: 'RENDITION_NOT_FOUND' }),
    );
  });
  it('matches languages exactly ignoring case and preserves URI-less audio', () => {
    const tracks = [
      track('English', { language: 'en-US' }),
      track('English 2', { language: 'en-us', default: true }),
    ];
    expect(selectAudio(tracks, 'a', { language: 'EN-us' })?.name).toBe('English 2');
    expect(() => selectAudio(tracks, 'a', { language: 'en' })).toThrow();
    expect(selectAudio(tracks, 'a')?.uri).toBeUndefined();
  });
  it('resolves root-relative and parent-relative rendition URIs', () => {
    const parsed = parseManifest(
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="../a.m3u8?token=1"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nv.m3u8\n',
      'https://example.test/sub/master.m3u8',
    );
    expect(parsed.type === 'playlist' && parsed.renditions?.[0]?.uri).toBe(
      'https://example.test/a.m3u8?token=1',
    );
  });
});
const timeline = {
  origin: { ticks: '900000', timescale: 90000 },
  tracks: [{ wrapAnchor: '900000' }],
};
const part = (body: string, map = 'LOCAL:00:00:00.000,MPEGTS:900000') => ({
  text: `WEBVTT\nX-TIMESTAMP-MAP=${map}\n\n${body}\n`,
  duration: 1,
});
describe('WebVTT output timeline', () => {
  it('deduplicates boundary cues and preserves IDs, settings, markup and regions', () => {
    const cue = 'id\n00:00:00.500 --> 00:00:01.500 align:start\n<b>Hi</b>';
    const text = mergeWebVtt([part(cue), part(cue)], timeline);
    expect(text.match(/<b>Hi<\/b>/g)).toHaveLength(1);
    expect(text).toContain('id\n00:00:00.500 --> 00:00:01.500 align:start');
  });
  it('supports empty segments and initialization headers', () => {
    expect(mergeWebVtt([{ text: 'WEBVTT\n\n', duration: 1 }], timeline)).toBe('WEBVTT\n');
    const text = mergeWebVtt(
      [
        {
          text: '00:00:00.500 --> 00:00:01.000\nHi',
          header: 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000',
          duration: 1,
        },
      ],
      timeline,
    );
    expect(text).toContain('00:00:00.500 --> 00:00:01.000');
  });
  it('clips cues crossing zero and removes cues wholly before zero', () => {
    const t = mergeWebVtt(
      [
        part(
          '00:00:00.000 --> 00:00:00.500\nold\n\n00:00:00.500 --> 00:00:02.000\nnew',
          'LOCAL:00:00:01.000,MPEGTS:900000',
        ),
      ],
      timeline,
    );
    expect(t).not.toContain('old');
    expect(t).toContain('00:00:00.000 --> 00:00:01.000\nnew');
  });
  it('unwraps MPEGTS around the prepared anchor without Number precision loss', () => {
    const ticks = (1n << 63n) + 90000n;
    const text = mergeWebVtt(
      [part('00:00:00.000 --> 00:00:01.000\nwrapped', 'LOCAL:00:00:00.000,MPEGTS:90000')],
      {
        origin: { ticks: ticks.toString(), timescale: 90000 },
        tracks: [{ wrapAnchor: ticks.toString() }],
      },
    );
    expect(text).toContain('00:00:00.000 --> 00:00:01.000');
  });
  it('uses zero mapping when omitted and rejects malformed cues/maps', () => {
    expect(
      mergeWebVtt([{ text: 'WEBVTT\n\n00:00:10.500 --> 00:00:11.000\nHi', duration: 1 }], timeline),
    ).toContain('00:00:00.500 --> 00:00:01.000');
    expect(() => mergeWebVtt([part('broken')], timeline)).toThrowError(
      expect.objectContaining({ code: 'SUBTITLE_INVALID' }),
    );
    expect(() => mergeWebVtt([part('00:00:01.000 --> 00:00:00.000\nHi')], timeline)).toThrow();
  });
});
