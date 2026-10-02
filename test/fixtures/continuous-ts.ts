/** Repeat a TS fixture with shifted PES timestamps instead of resetting its clock. */
export function shiftTsTimestamps(input: Uint8Array, seconds: number): Uint8Array {
  const bytes = Uint8Array.from(input);
  const shift = seconds * 90_000;
  for (let packet = 0; packet + 188 <= bytes.length; packet += 188) {
    if (bytes[packet] !== 0x47 || !(bytes[packet + 1]! & 0x40)) continue;
    const control = (bytes[packet + 3]! >> 4) & 3;
    if (!(control & 1)) continue;
    const pes = packet + 4 + (control & 2 ? 1 + bytes[packet + 4]! : 0);
    if (pes + 14 > packet + 188 || bytes[pes] !== 0 || bytes[pes + 1] !== 0 || bytes[pes + 2] !== 1)
      continue;
    const flags = bytes[pes + 7]! >> 6;
    for (const offset of flags === 3 ? [9, 14] : flags === 2 ? [9] : []) {
      const p = pes + offset;
      if (p + 5 > packet + 188) throw new Error('Fixture PES timestamp crosses a TS packet');
      const timestamp =
        (bytes[p]! & 14) * 2 ** 29 +
        bytes[p + 1]! * 2 ** 22 +
        (bytes[p + 2]! & 254) * 2 ** 14 +
        bytes[p + 3]! * 128 +
        (bytes[p + 4]! >> 1);
      const value = (timestamp + shift) % 2 ** 33;
      bytes[p] = (bytes[p]! & 0xf1) | (Math.floor(value / 2 ** 29) & 14);
      bytes[p + 1] = Math.floor(value / 2 ** 22) & 255;
      bytes[p + 2] = (Math.floor(value / 2 ** 14) & 254) | 1;
      bytes[p + 3] = Math.floor(value / 128) & 255;
      bytes[p + 4] = ((value & 127) << 1) | 1;
    }
  }
  return bytes;
}
