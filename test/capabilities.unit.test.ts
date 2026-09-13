import { describe, expect, it } from 'vitest';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { getInternalAdapter } from '@hls-downloader/shared';

const evidence = {
  BrowserAdapter: {
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
    for (const key of ['download', 'stream', 'configurableRetry', 'byteRange'] as const) {
      if (capabilities[key] === true) expect(mapped[key]).toBeTruthy();
    }
    for (const preset of capabilities.transcodePresets) {
      expect(mapped.transcodePresets, preset).toBeTruthy();
    }
    expect(capabilities.aes128).toBe(false);
    expect(capabilities.liveRecording).toBe(false);
  });
});
