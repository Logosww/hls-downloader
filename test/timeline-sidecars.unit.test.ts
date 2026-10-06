import { describe, it, expect } from 'vitest';
import {
  exportChapters,
  mapTimelineWebVtt,
  type HlsTimelineReport,
  type HlsTimelineMapping,
} from '../packages/shared/src/index';
const t = (ticks: number | string, timescale = 1) => ({ ticks: String(ticks), timescale });
const range = (start: number, end: number) => ({ start: t(start), end: t(end) });
const mapping = (
  epoch: string,
  source: number,
  start: number,
  end: number,
  output: string,
  outputStart = 0,
): HlsTimelineMapping => ({
  inputId: 'primary',
  trackId: 1,
  epoch,
  sourceOrigin: t(source),
  sourceDecodeStart: t(source),
  configurationId: [],
  presentation: range(start, end),
  outputStart: t(outputStart),
  outputIndex: output,
  wrapAnchor: t(source),
  programDateTime: null,
});
const report = (maps: HlsTimelineMapping[]): HlsTimelineReport => ({
  schemaVersion: 1,
  requested: range(0, 10),
  actual: range(0, 10),
  preroll: null,
  postroll: null,
  outputs: [...new Set(maps.map((m) => m.outputIndex))].map((index) => ({
    index,
    actualRange: range(0, 10),
    reason: 'Initial',
    tracks: [{ codec: 'Avc', timescale: 90000, duration: '900000', sampleCount: '100' }],
    bytesWritten: '1000',
    mappings: maps.filter((m) => m.outputIndex === index),
  })),
  gaps: [],
  dependencies: [],
  randomAccessPoints: [],
  indexedResources: '2',
  resourceReads: '6',
  sourceBytes: '3000',
  peakPlannedSamples: '10',
  peakPlannedResources: '2',
});
const part = (text: string, epoch = '0', programDateTime: string | null = null) => ({
  text,
  epoch,
  programDateTime,
  duration: t(5),
});
describe('timeline sidecars', () => {
  it('clips chapters and rebases separate files', () => {
    const outputs = exportChapters({
      timelineReport: report([mapping('0', 100, 0, 5, '0'), mapping('1', 0, 5, 10, '1')]),
      chapters: [{ range: range(3, 8), title: 'A < B', id: 'chapter' }],
    });
    expect(outputs.map((o) => o.filename)).toEqual(['chapters.001.vtt', 'chapters.002.vtt']);
    expect(outputs[0]!.text).toContain('00:00:03.000 --> 00:00:05.000');
    expect(outputs[1]!.text).toContain('00:00:00.000 --> 00:00:03.000');
    expect(outputs[0]!.text).toContain('A &lt; B');
  });
  it('collapses common gaps for chapters and WebVTT equally', () => {
    const r = report([mapping('0', 100, 0, 4, '0'), mapping('0', 106, 6, 10, '0', 4)]);
    const chapters = exportChapters({
      timelineReport: r,
      chapters: [{ range: range(7, 8), title: 'chapter' }],
    });
    const vtt = mapTimelineWebVtt(
      [
        part(
          'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:9000000\n\ncue\n00:00:07.000 --> 00:00:08.000 align:start\nhello',
        ),
      ],
      r,
    );
    expect(chapters[0]!.text).toContain('00:00:05.000 --> 00:00:06.000');
    expect(vtt[0]!.text).toContain('00:00:05.000 --> 00:00:06.000 align:start');
  });
  it('handles a 33-bit source wrap', () => {
    const m = mapping('0', 0, 0, 4, '0');
    m.sourceOrigin = t(((1n << 33n) - 90000n).toString(), 90000);
    m.wrapAnchor = m.sourceOrigin;
    const outputs = mapTimelineWebVtt(
      [
        part(
          'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n00:00:00.000 --> 00:00:01.000\nwrap',
        ),
      ],
      report([m]),
    );
    expect(outputs[0]!.text).toContain('00:00:01.000 --> 00:00:02.000');
  });
  it('rejects ambiguous resets and accepts independent PDT evidence', () => {
    const a = mapping('0', 0, 0, 5, '0'),
      b = mapping('1', 0, 5, 10, '1');
    const r = report([a, b]);
    const text =
      'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n00:00:01.000 --> 00:00:02.000\nreset';
    expect(() => mapTimelineWebVtt([part(text, '900')], r)).toThrow(/ambiguous/);
    a.programDateTime = '2026-10-06T00:00:00Z';
    b.programDateTime = '2026-10-06T00:00:05Z';
    const outputs = mapTimelineWebVtt([part(text, '900', '2026-10-06T00:00:05Z')], r);
    expect(outputs[0]!.text).toBe('WEBVTT\n');
    expect(outputs[1]!.text).toContain('00:00:01.000 --> 00:00:02.000');
  });
  it('preserves cue identifiers, payload and settings across output boundaries', () => {
    const out = mapTimelineWebVtt(
      [part('WEBVTT\n\nidentifier\n00:00:03.000 --> 00:00:08.000 line:10%\n<v Alice>Hello</v>')],
      report([mapping('0', 0, 0, 5, '0'), mapping('0', 5, 5, 10, '1')]),
    );
    expect(out[0]!.text).toContain(
      'identifier\n00:00:03.000 --> 00:00:05.000 line:10%\n<v Alice>Hello</v>',
    );
    expect(out[1]!.text).toContain('00:00:00.000 --> 00:00:03.000');
  });
  it('uses the selected audio when the report has no primary video or audio', () => {
    const m = mapping('0', 0, 0, 5, '0');
    m.inputId = 'audio';
    const r = report([m]);
    r.outputs[0]!.tracks[0]!.codec = 'Aac';
    expect(
      exportChapters({ timelineReport: r, chapters: [{ range: range(1, 2), title: 'audio' }] })[0]!
        .text,
    ).toContain('00:00:01.000 --> 00:00:02.000');
  });
  it('preserves ticks above JS integer precision until serialization', () => {
    const m = mapping('0', 0, 0, 1, '0');
    m.presentation = { start: t('9007199254740993', 1000), end: t('9007199254741993', 1000) };
    const out = exportChapters({
      timelineReport: report([m]),
      chapters: [
        {
          title: 'precise',
          range: { start: t('9007199254740994', 1000), end: t('9007199254740995', 1000) },
        },
      ],
    });
    expect(out[0]!.text).toContain('00:00:00.001 --> 00:00:00.002');
  });
  it('rejects invalid chapters and report versions', () => {
    expect(() =>
      exportChapters({
        timelineReport: report([mapping('0', 0, 0, 10, '0')]),
        chapters: [{ title: 'bad', range: range(3, 2) }],
      }),
    ).toThrow();
    expect(() =>
      exportChapters({ timelineReport: { schemaVersion: 2 } as any, chapters: [] }),
    ).toThrow();
  });
});
