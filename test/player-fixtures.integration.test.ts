import { it, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HlsDownloader } from '../packages/core/src/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { startFixtureServer, sendBytes, sendText } from './fixtures/http-server';
import { multiTrackRoutes, multiTrackSelection } from './fixtures/multitrack';
import { timelineCases, timelineRoutes, timelineOptions } from './fixtures/timeline';

it.runIf(process.env.HLS_PLAYER_FIXTURES === '1')(
  'builds actual SDK output for independent players',
  async () => {
    const root = resolve(import.meta.dirname, '../test-results/players');
    mkdirSync(root, { recursive: true });
    const audio = join(root, 'source-ja');
    mkdirSync(audio, { recursive: true });
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1760:sample_rate=48000',
      '-t',
      '2',
      '-c:a',
      'aac',
      '-f',
      'hls',
      '-hls_segment_type',
      'fmp4',
      '-hls_time',
      '1',
      '-hls_list_size',
      '0',
      join(audio, 'media.m3u8'),
    ]);
    const engine = readFileSync(
      resolve(import.meta.dirname, '../packages/adapters/src/node/crates/core/Cargo.toml'),
      'utf8',
    ).match(/hls-engine = \{ version = "=([^"]+)"/)?.[1];
    expect(engine).toBeTruthy();
    const entries: any[] = [];
    for (const format of ['mp4', 'fmp4'] as const) {
      for (const profile of ['avc', 'wvtt-plain', 'wvtt-settings'] as const) {
        const routes = multiTrackRoutes('', {
          subtitle:
            profile === 'wvtt-plain'
              ? 'WEBVTT\n\nen-first\n00:00.100 --> 00:01.600\nHello player\n'
              : undefined,
        });
        for (const file of readdirSync(audio))
          routes['/ja/' + file] = (_, res) =>
            file.endsWith('.m3u8')
              ? sendText(res, readFileSync(join(audio, file), 'utf8'))
              : sendBytes(res, readFileSync(join(audio, file)));
        const server = await startFixtureServer(routes);
        const name = `${profile}-${format}`,
          path = join(root, name + '.mp4');
        rmSync(path, { force: true });
        try {
          const result = await new HlsDownloader({ adapter: NodeAdapter }).downloadMultiTrack({
            url: server.origin + '/master.m3u8',
            embeddedAudio: 'exclude',
            audioTracks: multiTrackSelection.audioTracks,
            subtitleTracks: profile === 'avc' ? [] : multiTrackSelection.subtitleTracks,
            output: { type: 'file', format, path },
            playbackTarget: 'container',
          });
          expect(result.report.tracks.filter((t) => t.kind === 'audio')).toHaveLength(2);
          entries.push({ name, file: name + '.mp4', format, profile, report: result.report });
        } finally {
          await server.close();
        }
      }
      for (const profile of ['negative-cts', 'sample-fmp4_hevc_cbcs']) {
        const c = timelineCases.find((c) => c.name === profile),
          server = await startFixtureServer(timelineRoutes(c));
        const name = `${profile}-${format}`,
          path = join(root, name + '.mp4');
        rmSync(path, { force: true });
        try {
          const result = await new HlsDownloader({ adapter: NodeAdapter }).downloadMultiTrack({
            url: server.origin + '/master.m3u8',
            ...timelineOptions(c),
            embeddedAudio: 'keep',
            output: { type: 'file', format, path },
          });
          entries.push({ name, file: name + '.mp4', format, profile, report: result.report });
        } finally {
          await server.close();
        }
      }
    }
    for (const e of entries) {
      const p = join(root, e.file);
      e.probe = JSON.parse(
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', p],
          { encoding: 'utf8' },
        ),
      );
    }
    writeFileSync(
      join(root, 'manifest.json'),
      JSON.stringify({ engine, createdAt: new Date().toISOString(), entries }, null, 2),
    );
    writeFileSync(
      join(root, 'external.vtt'),
      'WEBVTT\n\nexternal\n00:00.100 --> 00:01.600\nHello sidecar\n',
    );
  },
);
