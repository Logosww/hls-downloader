import { HlsDownloader } from '../packages/core/src';
import { BrowserAdapter } from '../packages/adapters/src/browser';
import { NodeAdapter } from '../packages/adapters/src/node';
import {
  HlsDownloaderEvent,
  HlsDownloaderErrorCode,
  type HlsKeyResolver,
  type HlsDecryptionOptions,
  type HlsMediaPlaylist,
} from '../packages/shared/src';
const keyResolver: HlsKeyResolver = async (request) => {
  const sequence: bigint = BigInt(request.originalSequence);
  const signal: AbortSignal = request.signal;
  void sequence;
  void signal;
  return { key: new Uint8Array(16), expiresInMs: 1000, version: 'revision' };
};
const decryption: HlsDecryptionOptions = {
  keyResolver,
  keyFormats: [{ format: 'identity', versions: [1] }],
  encryptedRanges: 'complete-resources',
  limits: { resources: 2 },
};
for (const adapter of [BrowserAdapter, NodeAdapter]) {
  const d = new HlsDownloader({
    adapter,
    onEvent(event, payload) {
      if (event === HlsDownloaderEvent.DECRYPTION_PROGRESS) {
        const bytes: string | undefined = payload.decryption?.bytesWritten;
        void bytes;
      }
    },
  });
  void d.download({ url: 'https://example.test/a.m3u8', decryption });
  void d.downloadToStream({ url: 'https://example.test/a.m3u8', decryption }, () => {});
  void d.downloadToWritable(
    { url: 'https://example.test/a.m3u8', decryption },
    new WritableStream<Uint8Array>(),
  );
  const playlist: Promise<HlsMediaPlaylist> = d.parseMediaPlaylist(
    '#EXTM3U',
    'https://example.test/a.m3u8',
  );
  const resume: false | undefined = d.capabilities.decryption?.resume;
  void playlist;
  void resume;
}
const code: 'KEY_EXPIRED' = HlsDownloaderErrorCode.KEY_EXPIRED;
void code;
// @ts-expect-error the resolver must return binary key bytes
const invalid: HlsKeyResolver = async () => ({ key: 'secret' });
// @ts-expect-error range attestation is explicit, not a boolean
const invalidRange: HlsDecryptionOptions = { encryptedRanges: true };
void invalid;
void invalidRange;
