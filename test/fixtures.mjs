import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

/** Deterministic sample assets so the test suite needs no external tooling. */

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function makePng(width = 240, height = 160, color = [37, 99, 235]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const stride = width * 3 + 1;
    const start = y * stride;
    raw[start] = 0;
    for (let x = 0; x < width; x++) {
      const t = y / height;
      const i = start + 1 + x * 3;
      raw[i] = Math.round(color[0] * (1 - t) + 240 * t);
      raw[i + 1] = Math.round(color[1] * (1 - t) + 120 * t);
      raw[i + 2] = Math.round(color[2] * (1 - t) + 60 * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateRawSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function makeWav(seconds = 1.2, freq = 440, rate = 8000) {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(12);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0);
  dataHeader.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, fmt, dataHeader, data]);
}

/**
 * Minimal but structurally valid MP4: ftyp + moov (with mvhd) + mdat.
 * Browsers will not play it (no real video track), so tests use it to verify
 * range requests / download / size handling rather than playback.
 */
export function makeMp4(paddingBytes = 200_000) {
  const ftyp = chunk('ftyp', Buffer.from('isom\x00\x00\x02\x00isomiso2avc1mp41', 'latin1'));
  const mvhd = Buffer.alloc(108);
  mvhd.writeUInt32BE(108, 0);
  mvhd.write('mvhd', 4);
  mvhd.writeUInt32BE(1, 8);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(5000, 16); // 5s at 1000 timescale
  const moovBox = Buffer.concat([uint32(8 + mvhd.length), Buffer.from('moov', 'ascii'), mvhd]);
  const mdat = Buffer.concat([uint32(8 + paddingBytes), Buffer.from('mdat', 'ascii'), Buffer.alloc(paddingBytes, 7)]);
  return Buffer.concat([ftyp, moovBox, mdat]);
}

function uint32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/** A real (tiny) single-page PDF so reviewers can preview a PDF in the browser. */
export function makePdf(title = 'Review Copy') {
  const contentText = `BT /F1 24 Tf 72 760 Td (${title}) Tj ET\nBT /F1 12 Tf 72 720 Td (LAN Review sample document) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(contentText)} >>\nstream\n${contentText}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export function writeSampleProject(root, { changed = false } = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, '素材', '图片'), { recursive: true });
  fs.mkdirSync(path.join(root, '交付说明'), { recursive: true });
  fs.writeFileSync(path.join(root, '素材', '图片', '主视觉.png'), makePng(240, 160, [37, 99, 235]));
  fs.writeFileSync(path.join(root, '素材', '图片', '备选封面.png'), makePng(200, 200, [220, 38, 38]));
  fs.writeFileSync(path.join(root, '素材', '视频小样.mp4'), makeMp4(changed ? 240_000 : 200_000));
  fs.writeFileSync(path.join(root, '素材', '背景音乐.wav'), makeWav(1.2, changed ? 520 : 440));
  fs.writeFileSync(path.join(root, '交付说明', '文案终稿.pdf'), makePdf(changed ? 'Review Copy v2' : 'Review Copy v1'));
  fs.writeFileSync(
    path.join(root, '交付说明', '排期表.csv'),
    '日期,事项,负责人\n2026-09-10,初稿提审,林\n2026-09-12,定稿交付,陈\n',
  );
  fs.writeFileSync(
    path.join(root, '交付说明', '修改说明.md'),
    `# 修改说明\n\n这是用于测试的文案文件。\n\n- 版本：${changed ? 'V02 已改' : 'V01 初稿'}\n- 联系人：品牌方\n`,
  );
  fs.writeFileSync(path.join(root, '交付说明', '工程文件.psd'), Buffer.from('PHOTOSHOP-DUMMY-FOR-NON-PREVIEW-TEST'.repeat(40)));
  return root;
}

export function sampleFileList(root) {
  return [
    path.join(root, '素材', '图片', '主视觉.png'),
    path.join(root, '素材', '视频小样.mp4'),
    path.join(root, '交付说明', '文案终稿.pdf'),
    path.join(root, '交付说明', '排期表.csv'),
    path.join(root, '交付说明', '修改说明.md'),
    path.join(root, '素材', '背景音乐.wav'),
    path.join(root, '交付说明', '工程文件.psd'),
  ];
}
