import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const HLS_URL =
  'https://is02.dlserv3.com/vod/_definst_/bprost/sample/STT-5380B_sample.mp4/playlist.m3u8';

function getVideoCodec(filePath: string): string {
  const output = execSync(
    `ffprobe -v quiet -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "${filePath}"`,
    { encoding: 'utf-8' },
  ).trim();
  return output;
}

function getAudioCodec(filePath: string): string {
  const output = execSync(
    `ffprobe -v quiet -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "${filePath}"`,
    { encoding: 'utf-8' },
  ).trim();
  return output;
}

function getFormat(filePath: string): string {
  const output = execSync(
    `ffprobe -v quiet -show_entries format=format_name -of csv=p=0 "${filePath}"`,
    { encoding: 'utf-8' },
  ).trim();
  return output;
}

describe('Node Adapter Transcode 端到端测试', () => {
  let downloader: any;
  const downloadedFiles: string[] = [];

  beforeAll(async () => {
    const { NodeAdapter } = await import('../packages/adapters/src/node/index.ts');
    const { HlsDownloader } = await import('../packages/core/src/index.ts');

    downloader = new HlsDownloader({
      adapter: NodeAdapter,
    });
    await downloader.init();
  });

  afterAll(() => {
    for (const file of downloadedFiles) {
      try {
        const dir = join(file, '..');
        execSync(`rm -rf "${dir}"`, { stdio: 'ignore' });
      } catch {}
    }
  });

  it('默认下载（无 transcode）保持原始编码', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'default',
    });

    expect(result.filePath).toBeTruthy();
    expect(result.filePath.endsWith('default.mp4')).toBe(true);
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const videoCodec = getVideoCodec(result.filePath);
    const audioCodec = getAudioCodec(result.filePath);
    const format = getFormat(result.filePath);

    expect(['h264', 'hevc']).toContain(videoCodec);
    expect(audioCodec).toBe('aac');
    expect(format).toContain('mp4');
  });

  it('h264 preset 输出 H.264/AAC/MP4', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'h264',
      transcode: { preset: 'h264' },
    });

    expect(result.filePath).toBeTruthy();
    expect(result.filePath.endsWith('h264.mp4')).toBe(true);
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const videoCodec = getVideoCodec(result.filePath);
    const audioCodec = getAudioCodec(result.filePath);
    const format = getFormat(result.filePath);

    expect(videoCodec).toBe('h264');
    expect(audioCodec).toBe('aac');
    expect(format).toContain('mp4');
  });

  it('hevc preset 输出 H.265/AAC/MP4', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'hevc',
      transcode: { preset: 'hevc' },
    });

    expect(result.filePath).toBeTruthy();
    expect(result.filePath.endsWith('vp9.webm')).toBe(true);
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const videoCodec = getVideoCodec(result.filePath);
    const audioCodec = getAudioCodec(result.filePath);
    const format = getFormat(result.filePath);

    expect(videoCodec).toBe('hevc');
    expect(audioCodec).toBe('aac');
    expect(format).toContain('mp4');
  });

  it('vp9 preset 输出 VP9/Opus/WebM', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'vp9',
      transcode: { preset: 'vp9' },
    });

    expect(result.filePath).toBeTruthy();
    expect(result.filePath.endsWith('custom-acodec.webm')).toBe(true);
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const videoCodec = getVideoCodec(result.filePath);
    const audioCodec = getAudioCodec(result.filePath);
    const format = getFormat(result.filePath);

    expect(videoCodec).toBe('vp9');
    expect(audioCodec).toBe('opus');
    expect(format).toContain('webm');
  });

  it('videoCodec: copy 保持原始视频编码', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'copy',
      transcode: { videoCodec: 'copy', audioCodec: 'copy' },
    });

    expect(result.filePath).toBeTruthy();
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const videoCodec = getVideoCodec(result.filePath);
    const audioCodec = getAudioCodec(result.filePath);

    expect(['h264', 'hevc']).toContain(videoCodec);
    expect(audioCodec).toBe('aac');
  });

  it('下载结果包含 totalSegments', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'segments',
    });

    expect(result.totalSegments).toBeGreaterThan(0);
    expect(typeof result.totalSegments).toBe('number');
    downloadedFiles.push(result.filePath);
  });

  it('全局 transcode 选项生效', async () => {
    downloader.setOptions({
      transcode: { preset: 'h264' },
    });

    const result = await downloader.download({
      url: HLS_URL,
      filename: 'global-transcode',
    });

    expect(result.filePath).toBeTruthy();
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const videoCodec = getVideoCodec(result.filePath);
    expect(videoCodec).toBe('h264');

    downloader.setOptions({});
  });

  it('调用级 transcode 覆盖全局 transcode', async () => {
    downloader.setOptions({
      transcode: { preset: 'h264' },
    });

    const result = await downloader.download({
      url: HLS_URL,
      filename: 'override',
      transcode: { preset: 'hevc' },
    });

    expect(result.filePath).toBeTruthy();
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const videoCodec = getVideoCodec(result.filePath);
    expect(videoCodec).toBe('hevc');

    downloader.setOptions({});
  });

  it('自定义 videoCodec: libx265 输出 H.265', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'custom-vcodec',
      transcode: { videoCodec: 'libx265' },
    });

    expect(result.filePath).toBeTruthy();
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const videoCodec = getVideoCodec(result.filePath);
    expect(videoCodec).toBe('hevc');
  });

  it('自定义 audioCodec: libopus 输出 Opus', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'custom-acodec',
      transcode: { videoCodec: 'libvpx-vp9', audioCodec: 'libopus', format: 'webm' },
    });

    expect(result.filePath).toBeTruthy();
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const audioCodec = getAudioCodec(result.filePath);
    const format = getFormat(result.filePath);

    expect(audioCodec).toBe('opus');
    expect(format).toContain('webm');
  });

  it('crf 选项影响编码质量', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'crf',
      transcode: { preset: 'h264', crf: 28 },
    });

    expect(result.filePath).toBeTruthy();
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const videoCodec = getVideoCodec(result.filePath);
    expect(videoCodec).toBe('h264');
  });

  it('videoBitrate 选项限制视频比特率', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'vbitrate',
      transcode: { preset: 'h264', videoBitrate: '1000k' },
    });

    expect(result.filePath).toBeTruthy();
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const videoCodec = getVideoCodec(result.filePath);
    expect(videoCodec).toBe('h264');
  });

  it('audioBitrate 选项限制音频比特率', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'abitrate',
      transcode: { preset: 'h264', audioBitrate: '128k' },
    });

    expect(result.filePath).toBeTruthy();
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const audioCodec = getAudioCodec(result.filePath);
    expect(audioCodec).toBe('aac');
  });

  it('speed 选项影响编码速度', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'speed',
      transcode: { preset: 'h264', speed: 'ultrafast' },
    });

    expect(result.filePath).toBeTruthy();
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const videoCodec = getVideoCodec(result.filePath);
    expect(videoCodec).toBe('h264');
  });

  it('组合选项: preset + crf + speed', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'combined',
      transcode: { preset: 'h264', crf: 23, speed: 'fast' },
    });

    expect(result.filePath).toBeTruthy();
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const videoCodec = getVideoCodec(result.filePath);
    const audioCodec = getAudioCodec(result.filePath);
    const format = getFormat(result.filePath);

    expect(videoCodec).toBe('h264');
    expect(audioCodec).toBe('aac');
    expect(format).toContain('mp4');
  });

  it('无 preset 的自定义组合', async () => {
    const result = await downloader.download({
      url: HLS_URL,
      filename: 'no-preset',
      transcode: {
        videoCodec: 'libx264',
        audioCodec: 'aac',
        format: 'mp4',
        crf: 26,
        videoBitrate: '2000k',
        audioBitrate: '192k',
      },
    });

    expect(result.filePath).toBeTruthy();
    expect(existsSync(result.filePath)).toBe(true);
    downloadedFiles.push(result.filePath);

    const videoCodec = getVideoCodec(result.filePath);
    const audioCodec = getAudioCodec(result.filePath);
    const format = getFormat(result.filePath);

    expect(videoCodec).toBe('h264');
    expect(audioCodec).toBe('aac');
    expect(format).toContain('mp4');
  });
});

describe('HLS URL 解析测试', () => {
  let downloader: any;

  beforeAll(async () => {
    const { NodeAdapter } = await import('../packages/adapters/src/node/index.ts');
    const { HlsDownloader } = await import('../packages/core/src/index.ts');

    downloader = new HlsDownloader({
      adapter: NodeAdapter,
    });
    await downloader.init();
  });

  it('示例 URL 可被 parseHls 解析', async () => {
    const result = await downloader.parseHls({ url: HLS_URL });
    expect(result).toBeDefined();
    expect(result.type).toBeDefined();

    if (result.type === 'segment') {
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data[0].uri).toBeTruthy();
    } else if (result.type === 'playlist') {
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data[0].uri).toBeTruthy();
    }
  });
});
