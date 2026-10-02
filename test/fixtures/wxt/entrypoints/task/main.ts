import { HlsDownloader } from '@logosw/hls-downloader/core';
import {
  BrowserAdapter,
  type HlsDownloaderBrowserRequestOptions,
} from '@logosw/hls-downloader/adapters/browser';
import { browser } from 'wxt/browser';

async function run(origin: string) {
  const seen: string[] = [];
  let preparations = 0;
  const request: HlsDownloaderBrowserRequestOptions = {
    credentials: 'include',
    async fetch(url, init) {
      if (new URL(url).origin !== origin) throw new Error('Unexpected media origin');
      // An actual extension rule, installed before transmission, supplies the restricted header.
      await browser.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [1],
        addRules: [
          {
            id: 1,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [{ header: 'Referer', operation: 'set', value: origin + '/watch' }],
            },
            condition: {
              urlFilter: '|' + origin + '/',
              resourceTypes: ['xmlhttprequest'],
              initiatorDomains: [browser.runtime.id],
            },
          },
        ],
      });
      preparations++;
      init.signal?.throwIfAborted();
      const headers = new Headers(init.headers);
      headers.set('Authorization', 'Bearer fixture-only');
      seen.push(url);
      return fetch(url, { ...init, headers });
    },
  };
  const d = new HlsDownloader({
    adapter: BrowserAdapter,
    options: { browserRequest: request, download: { maxRetry: 2, concurrency: 2 } },
  });
  const root = await navigator.storage.getDirectory();
  const results = [];
  try {
    for (const kind of ['ts', 'fmp4', 'byterange']) {
      const name = `acceptance-${kind}.mp4`;
      const handle = await root.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      const result = await d.downloadToWritable(
        { url: origin + '/' + kind + '/media.m3u8' },
        writable,
      );
      const file = await handle.getFile();
      if (file.size === 0 || result.totalSegments !== 2) throw new Error('Empty/incomplete output');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (new TextDecoder().decode(bytes.subarray(4, 8)) !== 'ftyp')
        throw new Error('Invalid MP4 signature');
      results.push({ kind, size: file.size, segments: result.totalSegments });
      await root.removeEntry(name);
    }
    const transcoded = await d.download({
      url: origin + '/fmp4/media.m3u8',
      transcode: { preset: 'h264' },
    });
    try {
      const bytes = await (await fetch(transcoded.blobURL)).arrayBuffer();
      if (bytes.byteLength === 0) throw new Error('Empty transcode');
      results.push({
        kind: 'transcode-h264',
        size: bytes.byteLength,
        segments: transcoded.totalSegments,
      });
    } finally {
      URL.revokeObjectURL(transcoded.blobURL);
    }
    const poster = await d.getPosterUrl({ url: origin + '/fmp4/media.m3u8' });
    if (!poster?.startsWith('data:image/jpeg')) throw new Error('Poster decode failed');
    return {
      results,
      preparations,
      mediaRequests: seen.length,
      poster: true,
      userAgent: navigator.userAgent,
    };
  } finally {
    await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] });
  }
}
(window as any).runAcceptance = run;
document.querySelector('#run')!.addEventListener('click', async () => {
  const result = document.querySelector('#result')!;
  try {
    result.textContent = JSON.stringify(
      await run((document.querySelector('#origin') as HTMLInputElement).value),
      null,
      2,
    );
  } catch (error) {
    result.textContent = String(error);
  }
});
