import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './util.js';

export const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  woff2: 'font/woff2',
};

export function mimeFor(name) {
  const ext = path.extname(String(name)).toLowerCase().replace(/^\./, '');
  return MIME[ext] || 'application/octet-stream';
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

export async function readJsonBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new AppError('payload_too_large', '提交的内容过大', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new AppError('bad_json', '请求内容格式不正确', 400);
  }
}

/**
 * Stream a file with HTTP Range support (needed for video seeking on phones).
 */
export async function sendFile(req, res, absPath, opts = {}) {
  const { download = false, contentType = null, cacheSeconds = 0, maxBytes = null } = opts;
  let stat;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    throw new AppError('file_missing', '文件已不存在或无法读取', 404);
  }
  if (!stat.isFile()) throw new AppError('not_a_file', '目标不是文件', 400);
  const size = stat.size;
  const type = contentType || mimeFor(absPath);
  const base = path.basename(absPath);
  const disposition = download
    ? `attachment; filename*=UTF-8''${encodeURIComponent(base)}`
    : 'inline';
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheSeconds > 0 ? `private, max-age=${cacheSeconds}` : 'no-store',
    'Content-Disposition': disposition,
    'Last-Modified': stat.mtime.toUTCString(),
  };

  const rangeHeader = req.headers.range;
  if (rangeHeader && maxBytes === null) {
    const parsed = parseRange(rangeHeader, size);
    if (parsed) {
      const { start, end } = parsed;
      const length = end - start + 1;
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': length,
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(absPath, { start, end });
      stream.pipe(res);
      await new Promise((resolve) => {
        stream.on('close', resolve);
        stream.on('error', () => {
          res.destroy();
          resolve();
        });
        res.on('close', resolve);
      });
      return;
    }
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
    res.end();
    return;
  }

  const length = maxBytes === null ? size : Math.min(size, maxBytes);
  res.writeHead(200, { ...headers, 'Content-Length': length });
  if (req.method === 'HEAD') return res.end();
  const stream = maxBytes === null ? fs.createReadStream(absPath) : fs.createReadStream(absPath, { start: 0, end: length - 1 });
  stream.pipe(res);
  await new Promise((resolve) => {
    stream.on('close', resolve);
    stream.on('error', () => {
      res.destroy();
      resolve();
    });
    res.on('close', resolve);
  });
}

export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
  if (!m) return null;
  let [, startStr, endStr] = m;
  if (startStr === '' && endStr === '') return null;
  if (startStr === '') {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }
  const start = Number(startStr);
  let end = endStr === '' ? size - 1 : Number(endStr);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const regexSrc = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        if (seg === '*') {
          keys.push('wildcard');
          return '(.*)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, regex: new RegExp(`^${regexSrc}/?$`), keys, handler, opts });
  }

  get(p, h, o) {
    this.add('GET', p, h, o);
  }

  post(p, h, o) {
    this.add('POST', p, h, o);
  }

  delete(p, h, o) {
    this.add('DELETE', p, h, o);
  }

  match(method, pathname) {
    let methodMismatch = false;
    for (const r of this.routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      if (r.method !== method) {
        methodMismatch = true;
        continue;
      }
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = safeDecode(m[i + 1]);
      });
      return { route: r, params };
    }
    return methodMismatch ? { methodMismatch: true } : null;
  }
}

function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export class SseHub {
  constructor() {
    this.clients = new Set();
  }

  register(res, meta) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const client = { res, meta };
    res.localreviewStream = true;
    res.write(`retry: 2000\n\n`);
    this.publish(meta.channel, 'hello', { ok: true, at: new Date().toISOString() });
    this.clients.add(client);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping);
      }
    }, 25_000);
    const cleanup = () => {
      clearInterval(ping);
      this.clients.delete(client);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    return cleanup;
  }

  publish(channel, event, data) {
    const payload = `data: ${JSON.stringify({ kind: event, at: new Date().toISOString(), data: data ?? {} })}\n\n`;
    for (const client of this.clients) {
      if (client.meta.channel !== channel && client.meta.channel !== '*') continue;
      try {
        client.res.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  count(channel) {
    let n = 0;
    for (const c of this.clients) if (c.meta.channel === channel) n += 1;
    return n;
  }

  closeAll() {
    for (const c of this.clients) {
      try {
        c.res.end();
      } catch {}
    }
    this.clients.clear();
  }
}
