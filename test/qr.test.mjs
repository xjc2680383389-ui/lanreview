import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { encodeQr, qrToPng, qrToRgba } from '../server/lib/qr.js';

const require = createRequire(import.meta.url);
let jsQR = null;
let PNG = null;
try {
  jsQR = require('jsqr');
  PNG = require('pngjs').PNG;
} catch {
  console.log('  (跳过：未安装开发依赖 jsqr/pngjs，请运行 npm install)');
  process.exit(0);
}

const samples = [
  'http://192.168.1.20:8780/pair#code=ABC234',
  'http://10.20.30.40:8780/pair#code=KQ7X2M&h=%E5%88%9B%E4%BD%9C%E8%80%85%E7%94%B5%E8%84%91',
  'http://172.20.10.5:8799/r#d=device_0123456789abcdef&t=0123456789abcdef0123456789abcdef',
  'x'.repeat(120),
];

let failures = 0;
for (const text of samples) {
  const qr = encodeQr(text);
  if (!qr) {
    console.log(`  ! 内容过长无法编码 (${text.length} 字节)`);
    failures += 1;
    continue;
  }
  const png = qrToPng(qr, { scale: 6 });
  const decodedPng = PNG.sync.read(png);
  const viaPng = jsQR(new Uint8ClampedArray(decodedPng.data), decodedPng.width, decodedPng.height);
  const viaRgba = qrToRgba(qr, { scale: 4 });
  const viaRaw = jsQR(viaRgba.data, viaRgba.width, viaRgba.height);
  const okPng = viaPng?.data === text;
  const okRaw = viaRaw?.data === text;
  console.log(`  v${qr.version}/${qr.level}/mask${qr.mask} ${qr.size}x${qr.size} len=${text.length} PNG解码=${okPng ? 'OK' : 'FAIL'} 位图解码=${okRaw ? 'OK' : 'FAIL'}`);
  if (!okPng || !okRaw) failures += 1;
  assert.ok(png.subarray(1, 4).toString('ascii') === 'PNG', 'PNG 签名应有效');
  assert.ok(zlib !== null);
}

if (failures) {
  console.error(`QR 自检失败：${failures} 个样本未能被第三方解码器识别`);
  process.exit(1);
}
console.log('  QR 自检通过（含 PNG 字节与第三方解码器 round-trip）');
