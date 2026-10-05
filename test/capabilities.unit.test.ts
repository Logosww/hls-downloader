import { describe, expect, it } from 'vitest';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { getInternalAdapter } from '@hls-downloader/shared';

const evidence = {
  BrowserAdapter: {
    aes128: 'keyed.integration: independent decode, offset timelines, all output modes',
    writableOutput: 'writable-output.integration: real WASM, backpressure and ffprobe',
    alternateAudio: 'renditions.integration: both containers and all three outputs',
    subtitleExport: 'renditions.integration: prepared timeline and WebVTT export',
    download: 'hls-http.integration: BYTERANGE download',
    stream: 'hls-http.integration: EXT-X-MAP stream',
    configurableRetry: 'hls-http.integration: transient segment retry',
    byteRange: 'hls-http.integration: real Range requests',
    transcodePresets: 'library-api.e2e: transcode option forwarding',
  },
} as const;

describe('capability evidence', () => {
  it('maps every enabled BrowserAdapter capability to an automated test', () => {
    const capabilities = getInternalAdapter(BrowserAdapter).capabilities;
    const mapped = evidence.BrowserAdapter;
    for (const key of [
      'aes128',
      'download',
      'stream',
      'configurableRetry',
      'byteRange',
      'writableOutput',
      'alternateAudio',
      'subtitleExport',
    ] as const) {
      if (capabilities[key] === true) expect(mapped[key]).toBeTruthy();
    }
    for (const preset of capabilities.transcodePresets) {
      expect(mapped.transcodePresets, preset).toBeTruthy();
    }
    expect(capabilities.aes128).toBe(true);
    expect(capabilities.decryption).toEqual({
      methods: ['AES-128'],
      containers: ['ts', 'fmp4'],
      codecs: ['avc', 'hevc', 'aac-lc'],
      finite: true,
      externalAudio: true,
      resume: false,
    });
    expect(Object.isFrozen(capabilities.decryption)).toBe(true);
    expect(Object.isFrozen(capabilities.decryption!.methods)).toBe(true);
    expect(capabilities.liveRecording).toBe(false);
  });
});
