import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const APP_NAME = 'LAN Review';
export const APP_LABEL = '局域网提审、审核与交付工具';
export const APP_VERSION = '1.0.0';

export function nowIso() {
  return new Date().toISOString();
}

export function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function newId(prefix) {
  return `${prefix}_${randomHex(8)}`;
}

export function pairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

export function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (c) => h.update(c));
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

export function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Filesystem-safe single path segment (keeps CJK, drops separators and reserved chars). */
export function sanitizeSegment(input, fallback = '未命名') {
  let s = String(input ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  s = s.replace(/^\.+/, '').replace(/\s+/g, ' ').trim();
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || fallback;
}

export function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

export async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

export async function mkdirp(p) {
  await fsp.mkdir(p, { recursive: true });
}

export async function writeFileAtomic(p, data) {
  await mkdirp(path.dirname(p));
  const tmp = `${p}.${randomHex(4)}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, p);
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export function formatTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class AppError extends Error {
  constructor(code, message, status = 400, detail = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const KIND_BY_EXT = new Map();
const add = (kind, exts) => exts.forEach((e) => KIND_BY_EXT.set(e, kind));
add('image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'heic', 'heif', 'avif', 'ico']);
add('video', ['mp4', 'm4v', 'mov', 'webm', 'avi', 'mkv', 'mts']);
add('audio', ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'aiff', 'opus']);
add('pdf', ['pdf']);
add('sheet', ['xlsx', 'xls', 'csv', 'tsv', 'numbers']);
add('slides', ['ppt', 'pptx', 'key']);
add('document', ['doc', 'docx', 'pages', 'rtf', 'odt']);
add('text', ['txt', 'md', 'markdown', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'html', 'css', 'js', 'ts', 'log', 'xml', 'ini']);
add('archive', ['zip', 'rar', '7z', 'tar', 'gz']);
add('font', ['ttf', 'otf', 'woff', 'woff2']);

/** Files the browser can render natively (no plugin). */
const NATIVE_PREVIEW = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'pdf', 'mp4', 'm4v', 'webm', 'mov', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus']);

export function extOf(name) {
  const e = path.extname(String(name)).toLowerCase().replace(/^\./, '');
  return e;
}

export function fileKind(name) {
  return KIND_BY_EXT.get(extOf(name)) || 'other';
}

export function kindLabel(kind) {
  return {
    image: '图片',
    video: '视频',
    audio: '音频',
    pdf: 'PDF',
    sheet: '表格',
    slides: '演示文稿',
    document: '文档',
    text: '文本',
    archive: '压缩包',
    font: '字体',
    other: '其他文件',
  }[kind] || '其他文件';
}

export function previewSupport(name) {
  const ext = extOf(name);
  const kind = fileKind(name);
  if (kind === 'text') return { preview: 'inline', reason: null };
  if (NATIVE_PREVIEW.has(ext)) {
    if (kind === 'video' && ['mov', 'avi', 'mkv', 'mts'].includes(ext)) {
      return { preview: 'maybe', reason: '部分浏览器不能直接播放该封装格式，可尝试播放或下载后查看' };
    }
    if (ext === 'svg') return { preview: 'inline', reason: null };
    return { preview: 'inline', reason: null };
  }
  if (['heic', 'heif', 'tif', 'tiff', 'avi', 'mkv', 'mts'].includes(ext)) {
    return { preview: 'none', reason: '浏览器通常不支持该格式，可下载后查看' };
  }
  return { preview: 'none', reason: '该类型无法在浏览器中直接预览，可下载或在本机打开' };
}

export function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; i < 10000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}
