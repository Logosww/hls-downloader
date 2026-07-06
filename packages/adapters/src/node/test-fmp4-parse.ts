// Parse fMP4 box structure to find anomalies
import { readFileSync } from 'node:fs';

const buf = readFileSync('/tmp/test-streaming.mp4');
console.log('file size:', buf.length);

interface Box {
  offset: number;
  size: number;
  type: string;
  data: Buffer;
}

function readBoxes(buf: Buffer, start: number, end: number, depth = 0): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (size < 8 || offset + size > end) break;
    boxes.push({
      offset,
      size,
      type,
      data: buf.subarray(offset + 8, offset + size),
    });
    offset += size;
  }
  return boxes;
}

let parseOffset = 0;
let fragmentIdx = 0;
const anomalies: string[] = [];

while (parseOffset + 8 < buf.length) {
  const size = buf.readUInt32BE(parseOffset);
  const type = buf.toString('ascii', parseOffset + 4, parseOffset + 8);
  if (size < 8 || parseOffset + size > buf.length) break;

  if (type === 'moof') {
    fragmentIdx++;
    const moofBoxes = readBoxes(buf, parseOffset + 8, parseOffset + size);
    const mfhd = moofBoxes.find((b) => b.type === 'mfhd');
    const traf = moofBoxes.find((b) => b.type === 'traf');
    if (mfhd && traf) {
      const sequence = mfhd.data.readUInt32BE(4); // skip version+flags
      const trafBoxes = readBoxes(buf, traf.offset + 8, traf.offset + traf.size);
      const tfhd = trafBoxes.find((b) => b.type === 'tfhd');
      const tfdt = trafBoxes.find((b) => b.type === 'tfdt');
      const trun = trafBoxes.find((b) => b.type === 'trun');

      let baseDecodeTime = -1;
      if (tfdt) {
        const version = tfdt.data[0];
        if (version === 1) {
          baseDecodeTime = Number(tfdt.data.readBigUInt64BE(4));
        } else {
          baseDecodeTime = tfdt.data.readUInt32BE(4);
        }
      }

      let sampleCount = -1;
      let dataOffset = -1;
      if (trun) {
        sampleCount = trun.data.readUInt32BE(4); // skip version+flags
        const flags = trun.data.readUInt32BE(0);
        // data-offset-present (0x000200)
        if (flags & 0x000200) {
          dataOffset = trun.data.readInt32BE(8);
        }
      }

      if (fragmentIdx <= 5 || fragmentIdx % 20 === 0 || fragmentIdx > 78) {
        console.log(
          `frag #${fragmentIdx}: seq=${sequence}, tfdt=${baseDecodeTime}, ` +
            `samples=${sampleCount}, dataOffset=${dataOffset}, moof@${parseOffset}`,
        );
      }

      // 检查 tfdt 是否单调递增
      if (fragmentIdx > 1) {
        // 简单检查：相邻 fragment 的 tfdt 应该递增
        // 这里只记录前几个，实际比较需要保存上一个
      }
    }
  }

  parseOffset += size;
}

console.log('total fragments:', fragmentIdx);
console.log('anomalies:', anomalies.length);

// 找 mfra box
let mfraOffset = -1;
parseOffset = 0;
while (parseOffset + 8 < buf.length) {
  const size = buf.readUInt32BE(parseOffset);
  const type = buf.toString('ascii', parseOffset + 4, parseOffset + 8);
  if (size < 8 || parseOffset + size > buf.length) break;
  if (type === 'mfra') {
    mfraOffset = parseOffset;
    console.log(`mfra box at offset ${parseOffset}, size ${size}`);
    break;
  }
  parseOffset += size;
}
