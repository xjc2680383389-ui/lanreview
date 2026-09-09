import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

/** Minimal ZIP writer (deflate) — avoids shipping a dependency just to package the receiver kit. */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return ~c >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dtime = ((year - 1980) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: dtime };
}

export function createZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());

  for (const entry of entries) {
    const name = Buffer.from(entry.name.split(path.sep).join('/'), 'utf8');
    const uncompressed = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const deflated = zlib.deflateRawSync(uncompressed, { level: 9 });
    const useDeflate = deflated.length < uncompressed.length;
    const data = useDeflate ? deflated : uncompressed;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(uncompressed);
    const mode = entry.mode || 0o644;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    chunks.push(local, data);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(uncompressed.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(0, 30); // extra length
    head.writeUInt16LE(0, 32); // comment length
    head.writeUInt16LE(0, 34); // disk start
    head.writeUInt16LE(0, 36); // internal attributes
    head.writeUInt32LE((mode & 0xffff) << 16, 38); // external attributes (unix mode)
    head.writeUInt32LE(offset, 42);
    const centralEntry = Buffer.concat([head, name]);
    central.push(centralEntry);
    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

export function walkFiles(root, { filter } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (filter && !filter(abs)) continue;
      out.push({ name: path.relative(root, abs), abs });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
