import { expect, it } from 'vitest';
import { nativeTargets, validateMatrix } from './m5/matrix';
import { shiftFragment, videoSeconds } from './m5/video-source';
import { realtimeWindow } from './m5/realtime';
function matrix() {
  return nativeTargets.map((target) => ({
    target,
    commit: 'a'.repeat(40),
    binary: { sha256: 'b'.repeat(64) },
    gate: 'platform',
    status: 'passed',
    dirty: false,
    linkage: { static: true },
    qualification: 'static platform package acceptance',
    steps: [
      'linkage',
      'install-native',
      'native-runtime',
      'install-missing',
      'missing-contract',
      'consumer-types',
      'unsupported-target',
    ].map((name) => ({ name, status: 'passed', exitCode: 0 })),
  }));
}
it('requires matching immutable commits and all six distinct static hosts', () => {
  expect(() => validateMatrix(matrix())).not.toThrow();
  expect(() => validateMatrix(matrix().slice(1))).toThrow();
  const mismatched = matrix();
  mismatched[1]!.commit = 'c'.repeat(40);
  expect(() => validateMatrix(mismatched)).toThrow();
  const duplicate = matrix();
  duplicate[1]!.target = duplicate[0]!.target;
  expect(() => validateMatrix(duplicate)).toThrow();
});
it('cannot promote smoke, incomplete, dirty or dynamically linked evidence', () => {
  for (const patch of [
    { qualification: 'dynamic local smoke only' },
    { status: 'running' },
    { dirty: true },
    { linkage: { static: false } },
    { steps: [] },
    { binary: { sha256: '' } },
  ]) {
    const summaries: any[] = matrix();
    Object.assign(summaries[0], patch);
    expect(() => validateMatrix(summaries)).toThrow();
  }
});
it('shifts only fragment decode time without retaining old sequence timestamps', () => {
  const bytes = Buffer.alloc(36);
  bytes.writeUInt32BE(36, 0);
  bytes.write('moof', 4);
  bytes.writeUInt32BE(28, 8);
  bytes.write('traf', 12);
  bytes.writeUInt32BE(20, 16);
  bytes.write('tfdt', 20);
  bytes[24] = 1;
  const shifted = shiftFragment(bytes, 20000, 90000);
  expect(shifted.readBigUInt64BE(28)).toBe(BigInt(20000 * videoSeconds * 90000));
  expect(bytes.readBigUInt64BE(28)).toBe(0n);
  expect(shifted.subarray(0, 28)).toEqual(bytes.subarray(0, 28));
});
it('video clock uses media duration rather than AAC soak timing', () => {
  expect(realtimeWindow(5119, 15000, 'live', 4, videoSeconds).end).toBe(4);
  expect(realtimeWindow(5120, 15000, 'live', 4, videoSeconds).end).toBe(6);
  expect(realtimeWindow(15360, 15000, 'live', 4, videoSeconds)).toMatchObject({
    end: 10,
    count: 10,
    endList: true,
  });
});
