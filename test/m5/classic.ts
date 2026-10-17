import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evidence, hash, root } from './harness.ts';
import { startSource, segmentSeconds } from './source.ts';
const { values } = parseArgs({
  options: { segments: { type: 'string', default: '256,512,1024' }, out: { type: 'string' } },
});
const counts = values.segments!.split(',').map(Number);
if (
  counts.length < 3 ||
  counts.some(
    (n, i) =>
      !Number.isSafeInteger(n) || n < 32 || n > 65536 || n % 16 || (i > 0 && n <= counts[i - 1]!),
  )
)
  throw Error('Use at least three increasing multiples of 16, each 32..65536');
const e = evidence('classic', values.out);
e.summary.qualification =
  'index scaling measurement; operational limits still require documentation review';
e.summary.sha256 = Object.fromEntries(
  ['test/m5/native.ts', 'test/m5/record.ts', 'test/m5/source.ts', 'test/m5/classic.ts'].map((f) => [
    f,
    hash(join(root, f)),
  ]),
);
e.summary.measurements = [];
await e.finish(async () => {
  for (const count of counts) {
    const source = await startSource(count);
    try {
      await e.run(
        `classic-${count}`,
        process.execPath,
        [
          '--expose-gc',
          join(import.meta.dirname, 'native.ts'),
          source.origin,
          String(count),
          'mp4',
        ],
        { timeoutMs: Math.max(180_000, count * 1000) },
      );
      const result = JSON.parse(
        readFileSync(join(e.directory, `${e.summary.steps.length}-classic-${count}.log`), 'utf8'),
      );
      const indexSamples = result.result.report.outputs.reduce(
        (sum: number, o: any) => sum + Number(o.classicIndexSamples),
        0,
      );
      const mediaSeconds = count * segmentSeconds;
      if (
        indexSamples !== count * 17 ||
        Math.abs(Number(result.fileEvidence.probe.format.duration) - mediaSeconds) > 0.1
      )
        throw Error('Index sample count or independently probed duration differs from fixture');
      e.summary.measurements.push({
        count,
        mediaSeconds,
        indexSamples,
        indexSamplesPerSecond: indexSamples / mediaSeconds,
        bytes: result.fileEvidence.bytes,
        peakRss: Math.max(...result.samples.map((s: any) => s.rss)),
        finalHeap: result.samples.at(-1).heapUsed,
        cleanup: result.cleanup,
      });
      e.save();
    } finally {
      await source.close();
    }
  }
});
