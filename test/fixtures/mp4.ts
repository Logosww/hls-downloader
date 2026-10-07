/** Only container wall clocks vary between Native and WASM; preserve every media byte. */
export function canonicalMp4(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes),
    view = new DataView(out.buffer);
  const visit = (start: number, end: number) => {
    for (let i = start; i + 8 <= end;) {
      const size = view.getUint32(i),
        kind = new TextDecoder().decode(out.subarray(i + 4, i + 8));
      if (size < 8 || i + size > end) throw Error('Invalid MP4');
      if (['moov', 'trak', 'mdia'].includes(kind)) visit(i + 8, i + size);
      if (['mvhd', 'tkhd', 'mdhd'].includes(kind))
        out.fill(0, i + 12, i + (out[i + 8] === 1 ? 28 : 20));
      i += size;
    }
  };
  visit(0, out.length);
  return out;
}
