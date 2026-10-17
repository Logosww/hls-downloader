import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transcodeFile } from '../packages/adapters/src/node/transcode';
it('cancels and reaps a non-cooperative encoder before returning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'encoder-cancel-')),
    previous = process.env.PATH;
  const receipt = join(dir, 'pid');
  let pid: number | undefined;
  try {
    await writeFile(
      join(dir, 'ffmpeg'),
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(receipt)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
      { mode: 0o755 },
    );
    process.env.PATH = dir + ':' + previous;
    const controller = new AbortController();
    const running = transcodeFile('unused', 'unused', [], controller.signal).catch((e) => e);
    for (let i = 0; i < 100; i++) {
      try {
        pid = Number(await readFile(receipt, 'utf8'));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    expect(await running).toMatchObject({ code: 'ABORTED' });
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    process.env.PATH = previous;
    if (pid)
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
