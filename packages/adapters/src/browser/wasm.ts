import init, {
  BrowserRecording,
  parse_media_playlist_browser,
  query_capability_browser,
} from './generated/hls_transmux_browser_wasm.js';
import { HlsDownloaderError, HlsDownloaderErrorCode as Code } from '@hls-downloader/shared';
let initPromise: Promise<void> | undefined;
export function ensureWasm(): Promise<void> {
  return (initPromise ??= (async () => {
    const wasm = await init({
      module_or_path: new URL('./hls_transmux_browser_wasm_bg.wasm', import.meta.url),
    });
    if (typeof wasm.browserrecording_new !== 'function')
      throw new HlsDownloaderError(Code.BRIDGE_VERSION_MISMATCH, 'Incompatible Engine WASM bridge');
  })());
}
export const ensureRecordingWasm = ensureWasm;
export { BrowserRecording, parse_media_playlist_browser, query_capability_browser };
