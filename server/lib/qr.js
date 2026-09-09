import zlib from 'node:zlib';

/**
 * Minimal, dependency-free QR Code encoder (byte mode, versions 1-6, ECC level L/M)
 * plus a tiny PNG writer. Pairing payloads are short URLs, so this covers the need
 * without shipping a third-party package.
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function polyMultiply(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] ^= gfMul(a[i], b[j]);
  return out;
}

function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) g = polyMultiply(g, [1, EXP[i]]);
  return g;
}

function rsEncode(data, ecLen) {
  const g = rsGenerator(ecLen);
  const buf = [...data, ...new Array(ecLen).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 0; j < g.length; j++) buf[i + j] ^= gfMul(g[j], coef);
  }
  return buf.slice(data.length);
}

// [ecCodewordsPerBlock, blockCount, dataCodewordsPerBlock]
const SPECS = {
  L: [null, [7, 1, 19], [10, 1, 34], [15, 1, 55], [20, 1, 80], [26, 1, 108], [18, 2, 68]],
  M: [null, [10, 1, 16], [16, 1, 28], [26, 1, 44], [18, 2, 32], [24, 2, 43], [16, 4, 27]],
};

const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];
const FORMAT_ECC_BITS = { L: 1, M: 0 };

class BitBuffer {
  constructor() {
    this.bits = [];
  }

  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length() {
    return this.bits.length;
  }
}

function buildCodewords(bytes, version, ecc) {
  const [ecPerBlock, blockCount, dataPerBlock] = SPECS[ecc][version];
  const totalData = ecPerBlock === null ? 0 : blockCount * dataPerBlock;
  const buffer = new BitBuffer();
  buffer.put(4, 4);
  buffer.put(bytes.length, 8);
  for (const b of bytes) buffer.put(b, 8);
  const capacityBits = totalData * 8;
  const terminator = Math.min(4, capacityBits - buffer.length);
  if (terminator > 0) buffer.put(0, terminator);
  while (buffer.length % 8 !== 0) buffer.bits.push(0);
  const data = [];
  for (let i = 0; i < buffer.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | buffer.bits[i + j];
    data.push(byte);
  }
  const padBytes = [0xec, 0x11];
  let p = 0;
  while (data.length < totalData) data.push(padBytes[p++ % 2]);

  const blocks = [];
  for (let i = 0; i < blockCount; i++) blocks.push(data.slice(i * dataPerBlock, (i + 1) * dataPerBlock));
  const ecBlocks = blocks.map((b) => rsEncode(b, ecPerBlock));
  const out = [];
  for (let i = 0; i < dataPerBlock; i++) for (const b of blocks) out.push(b[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function bchFormat(data5) {
  let remainder = data5 << 10;
  for (let i = 4; i >= 0; i--) {
    if ((remainder >> (i + 10)) & 1) remainder ^= 0x537 << i;
  }
  return ((data5 << 10) | remainder) ^ 0x5412;
}

function createMatrix(version) {
  const size = 17 + version * 4;
  const modules = Array.from({ length: size }, () => new Array(size).fill(0));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    reserved[r][c] = true;
  };

  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const dist = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        setFn(row + r, col + c, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  const positions = ALIGNMENT[version];
  for (const r of positions) {
    for (const c of positions) {
      const nearFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFn(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  setFn(size - 8, 8, true);

  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) setFn(8, i, false);
    if (!reserved[i][8]) setFn(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    setFn(8, size - 1 - i, false);
    setFn(size - 1 - i, 8, false);
  }
  return { modules, reserved, size };
}

function writeFormat(modules, size, mask, ecc) {
  const bits = bchFormat((FORMAT_ECC_BITS[ecc] << 3) | mask);
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    if (i < 6) modules[i][8] = bit;
    else if (i === 6) modules[7][8] = bit;
    else if (i === 7) modules[8][8] = bit;
    else if (i === 8) modules[8][7] = bit;
    else modules[8][14 - i] = bit;

    if (i < 8) modules[8][size - 1 - i] = bit;
    else modules[size - 15 + i][8] = bit;
  }
}

function placeData({ modules, reserved, size }, codewords, mask) {
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let index = 0;
  let upward = true;
  const maskFn = MASK_FNS[mask];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const row = upward ? size - 1 - vert : vert;
        if (reserved[row][col]) continue;
        let bit = index < bits.length ? bits[index] : 0;
        index += 1;
        if (maskFn(row, col)) bit ^= 1;
        modules[row][col] = bit;
      }
    }
    upward = !upward;
  }
}

function penalty({ modules, size }) {
  let score = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const runRight = modules[r].slice(c, c + 5);
      const runDown = modules.map((row) => row[c]).slice(r, r + 5);
      if (runRight.length === 5 && runRight.every((v) => v === runRight[0])) score += 3;
      if (runDown.length === 5 && runDown.every((v) => v === runDown[0])) score += 3;
      if (c + 7 <= size && modules[r].slice(c, c + 7).join('') === '1011101') score += 40;
      if (r + 7 <= size && modules.slice(r, r + 7).map((row) => row[c]).join('') === '1011101') score += 40;
    }
  }
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += modules[r][c];
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

function pickVersion(bytes, ecc) {
  for (let v = 1; v <= 6; v++) {
    const [ec, blocks, perBlock] = SPECS[ecc][v];
    if (!ec) continue;
    const capacity = blocks * perBlock - 2;
    if (bytes.length <= capacity) return v;
  }
  return null;
}

export function encodeQr(text, { ecc = 'M', forceLevel } = {}) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const levels = forceLevel ? [forceLevel] : [ecc, 'L'];
  for (const level of levels) {
    const version = pickVersion(bytes, level);
    if (!version) continue;
    const codewords = buildCodewords(bytes, version, level);
    const base = createMatrix(version);
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const modules = base.modules.map((row) => row.slice());
      const candidate = { modules, reserved: base.reserved, size: base.size };
      placeData(candidate, codewords, mask);
      writeFormat(modules, base.size, mask, level);
      const score = penalty(candidate);
      if (!best || score < best.score) best = { score, modules, size: base.size, mask, version, level };
    }
    return best;
  }
  return null;
}

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

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Render a QR matrix to a PNG buffer. */
export function qrToPng(qr, { scale = 8, quiet = 4 } = {}) {
  const { modules, size } = qr;
  const dim = (size + quiet * 2) * scale;
  const stride = dim * 3 + 1;
  const raw = Buffer.alloc(stride * dim);
  for (let y = 0; y < dim; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const dark = my >= 0 && my < size && mx >= 0 && mx < size ? modules[my][mx] === 1 : false;
      const v = dark ? 0 : 255;
      const idx = rowStart + 1 + x * 3;
      raw[idx] = v;
      raw[idx + 1] = v;
      raw[idx + 2] = v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Black/white RGBA bitmap, used by the test harness to feed a third-party decoder. */
export function qrToRgba(qr, { scale = 4, quiet = 4 } = {}) {
  const { modules, size } = qr;
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let y = 0; y < dim; y++) {
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const dark = my >= 0 && my < size && mx >= 0 && mx < size ? modules[my][mx] === 1 : false;
      const v = dark ? 0 : 255;
      const i = (y * dim + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: dim, height: dim };
}
