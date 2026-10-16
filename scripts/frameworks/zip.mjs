// A minimal ZIP reader (enough for .xlsx): central directory + stored or deflated entries.
// Written here so the tooling needs no extra dependency.
import { inflateRawSync } from 'node:zlib';

/** Returns a Map of entry name to a function that yields the entry's bytes. */
export function readZip(buffer) {
  const minEnd = Math.max(0, buffer.length - 65_557);
  let end = -1;
  for (let i = buffer.length - 22; i >= minEnd; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not a ZIP file (no end-of-central-directory record).');
  const entryCount = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('Corrupt ZIP central directory.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, () => {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50)
        throw new Error(`Corrupt ZIP entry ${name}.`);
      const dataStart =
        localOffset +
        30 +
        buffer.readUInt16LE(localOffset + 26) +
        buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
