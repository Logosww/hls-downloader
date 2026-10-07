import { it, expect } from 'vitest';
import {
  parseEmbeddedWebVtt,
  unwrapWebVttTimestamp,
} from '../packages/adapters/src/multitrack-subtitles';
import { validateSelection } from '../packages/adapters/src/multitrack';
const context = { generation: '9007199254740993', epoch: '7' };
const cue = (settings = '', payload = 'hello') =>
  `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:90000\n\nid\n00:00.100 --> 00:01.200 ${settings}\n${payload}\n`;
it('retains exact source clocks, identifiers and settings', () => {
  const result = parseEmbeddedWebVtt(cue('align:start position:80% line:-1'), context);
  expect(result.cues[0]).toEqual({
    ...context,
    start: { ticks: '99000', timescale: 90000 },
    end: { ticks: '198000', timescale: 90000 },
    identifier: 'id',
    payload: 'hello',
    settings: 'align:start position:80% line:-1',
  });
});
it('unwraps 33-bit clocks and rejects ambiguous half wraps', () => {
  expect(unwrapWebVttTimestamp(50n, (1n << 33n) - 20n)).toBe((1n << 33n) + 50n);
  expect(() => unwrapWebVttTimestamp(1n << 32n, 0n)).toThrow();
});
for (const value of [
  'line:auto',
  'position:80%,auto',
  'align:start align:end',
  'size:+20%',
  'size:1e2%',
  'line:2147483648',
  'vertical:foo',
])
  it(`rejects unsupported settings ${value}`, () =>
    expect(() => parseEmbeddedWebVtt(cue(value), context)).toThrow());
it('rejects styled text, malformed intervals and STYLE blocks', () => {
  for (const text of [
    cue('', '<b>text</b>'),
    cue().replace('00:01.200', '00:00.000'),
    'WEBVTT\n\nSTYLE\n::cue { color:red }',
  ])
    expect(() => parseEmbeddedWebVtt(text, context)).toThrow();
});
it('rejects duplicate IDs, unknown bindings and missing embedded policy', () => {
  const options = {
    url: 'https://example.test/a',
    output: { type: 'blob', maxBytes: 10 },
    embeddedAudio: 'keep',
  } as const;
  validateSelection(options);
  expect(() =>
    validateSelection({
      ...options,
      audioTracks: [{ id: 'primary', selector: { language: 'en' } }],
    }),
  ).toThrow();
  expect(() =>
    validateSelection({
      ...options,
      subtitleTracks: [
        { id: 's', selector: { groupId: 's', name: 'en' }, timelineInputId: 'missing' },
      ],
    }),
  ).toThrow();
  expect(() => validateSelection({ ...options, embeddedAudio: undefined } as any)).toThrow();
});
