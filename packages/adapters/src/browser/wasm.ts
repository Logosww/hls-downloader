import init, {
  transmux_preloaded_to_fmp4_stream,
  transmux_demand_to_fmp4,
  transmux_preloaded_to_mp4_report,
} from './generated/hls_transmux_browser_wasm.js';

export type HlsWasmResources = {
  playlistUrl: string;
  texts: Record<string, string>;
  bytes: Record<string, Uint8Array>;
  ranges: Array<{
    url: string;
    offset: number;
    length: number;
    bytes: Uint8Array;
  }>;
};

export type HlsWasmReport = {
  buffer?: Uint8Array;
  segmentCount: number;
  bytesWritten: number;
};

let initPromise: Promise<void> | undefined;

export async function ensureWasm(): Promise<void> {
  initPromise ??= (async () => {
    const wasmUrl = new URL('./hls_transmux_browser_wasm_bg.wasm', import.meta.url);
    await init(wasmUrl);
  })();
  await initPromise;
}

export async function transmuxPreloadedToMp4(
  resources: HlsWasmResources,
): Promise<HlsWasmReport & { buffer: Uint8Array }> {
  await ensureWasm();
  const report = (await transmux_preloaded_to_mp4_report(resources)) as HlsWasmReport;
  if (!report.buffer) throw new Error('hls-transmux did not produce an MP4 buffer');
  return report as HlsWasmReport & { buffer: Uint8Array };
}

export async function transmuxPreloadedToFmp4Stream(
  resources: HlsWasmResources,
  onChunk: (chunk: Uint8Array) => void,
): Promise<HlsWasmReport> {
  await ensureWasm();
  return (await transmux_preloaded_to_fmp4_stream(resources, onChunk)) as HlsWasmReport;
}

export async function transmuxDemandToFmp4(
  url: string,
  playlist: string,
  read: (url: string, offset?: number, length?: number) => Promise<Uint8Array>,
  write: (bytes: Uint8Array) => Promise<void>,
): Promise<HlsWasmReport> {
  await ensureWasm();
  return (await transmux_demand_to_fmp4(url, playlist, read, write)) as HlsWasmReport;
}
