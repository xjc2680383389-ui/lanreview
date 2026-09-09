import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AppError, APP_NAME, APP_VERSION, formatBytes, mkdirp, nowIso, sanitizeSegment, writeFileAtomic } from '../server/lib/util.js';
import { Router, SseHub, mimeFor, readJsonBody, sendJson } from '../server/lib/http.js';
import { clientAddress, findFreePort, isLoopback, openBrowser, pickFolderNative, primaryLanAddress, revealInFileManager } from '../server/lib/net.js';
import { diskFreeBytes, listChildren } from '../server/lib/fsx.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB = path.join(ROOT, 'web');
const STATE_DIR = process.env.LANREVIEW_RECEIVER_DIR || path.join(ROOT, '.lanreview-receiver');
const STATE_FILE = path.join(STATE_DIR, 'receiver.json');
const LOG_FILE = path.join(STATE_DIR, 'deliveries.json');
const DEFAULT_PORT = Number(process.env.LANREVIEW_AGENT_PORT || 8790);
const POLL_MS = 2500;
const HEARTBEAT_MS = 8000;

const state = {
  startedAt: nowIso(),
  cfg: { hostUrl: '', deviceId: '', token: '', name: '', receiveRoot: '', platform: '' },
  log: {},
  host: null, // { ok, at, error }
  device: null, // public device info from host
  offers: [],
  busy: new Set(),
  events: new SseHub(),
  port: DEFAULT_PORT,
  lastError: null,
};

/* ------------------------------------------------------------------ storage */

async function load() {
  await mkdirp(STATE_DIR);
  try {
    state.cfg = { ...state.cfg, ...JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')) };
  } catch {
    /* first run */
  }
  try {
    state.log = JSON.parse(await fsp.readFile(LOG_FILE, 'utf8')) || {};
  } catch {
    state.log = {};
  }
  if (!state.cfg.name) {
    state.cfg.name = sanitizeSegment(os.hostname() || '笔记本', '接收设备');
    state.cfg.platform = `node ${process.platform}`;
    await persist();
  }
}

async function persist() {
  await writeFileAtomic(STATE_FILE, JSON.stringify(state.cfg, null, 2));
}

async function persistLog() {
  await writeFileAtomic(LOG_FILE, JSON.stringify(state.log, null, 2));
}

function hostBase() {
  const url = String(state.cfg.hostUrl || '').trim();
  if (!url) throw new AppError('no_host', '还没有连接创作者电脑', 409);
  return url.replace(/\/$/, '');
}

async function hostCall(method, apiPath, body, { allowPending = false } = {}) {
  const url = hostBase() + apiPath;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-LR-Device-Token': state.cfg.token || '',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  state.host = { ok: res.status < 500, at: nowIso(), status: res.status, url: hostBase() };
  if (res.status === 401 || res.status === 403) {
    const code = data?.error?.code;
    if (code === 'device_revoked') {
      state.device = { ...(state.device || {}), status: 'revoked', approved: false };
      state.events.publish('local', 'device.revoked', { message: '创作者已取消本设备的授权' });
    }
    if (code === 'device_pending' && !allowPending) {
      state.device = { ...(state.device || {}), status: 'pending', approved: false };
    }
  }
  if (res.status >= 400) {
    const err = new Error(data?.error?.message || `创作者电脑返回 ${res.status}`);
    err.status = res.status;
    err.code = data?.error?.code;
    err.detail = data?.error?.detail;
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------- transferring */

function deliveryTargetDir(offer) {
  const root = state.cfg.receiveRoot;
  if (!root) throw new AppError('no_receive_root', '请先选择接收文件夹', 409);
  const project = sanitizeSegment(offer.project?.name || '未命名项目', '未命名项目');
  const version = sanitizeSegment(offer.version?.code || '版本', '版本');
  return path.join(root, `${project} ${offer.project?.date || ''}`.trim(), version);
}

async function sha256OfFile(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function downloadFile(url, target, { resumeFrom = 0 } = {}) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const part = `${target}.part`;
  let start = 0;
  if (resumeFrom > 0 && fs.existsSync(part)) {
    const st = await fsp.stat(part);
    if (st.size === resumeFrom) start = resumeFrom;
    else await fsp.rm(part, { force: true });
  } else if (fs.existsSync(part)) {
    await fsp.rm(part, { force: true });
  }
  const headers = { 'X-LR-Device-Token': state.cfg.token };
  if (start > 0) headers.Range = `bytes=${start}-`;
  const res = await fetch(hostBase() + url, { headers });
  if (res.status === 416) {
    await fsp.rm(part, { force: true });
    return downloadFile(url, target, { resumeFrom: 0 });
  }
  if (!res.ok && res.status !== 206) {
    const body = await res.text().catch(() => '');
    let message = `创作者电脑返回 ${res.status}`;
    try {
      message = JSON.parse(body)?.error?.message || message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const append = res.status === 206 && start > 0;
  if (!append && start !== 0) start = 0;
  const handle = await fsp.open(part, append ? 'a' : 'w');
  const hash = createHash('sha256');
  let written = 0;
  try {
    if (append) {
      const existing = fs.createReadStream(part, { start: 0, end: start - 1 });
      await new Promise((resolve, reject) => {
        existing.on('data', (c) => hash.update(c));
        existing.on('end', resolve);
        existing.on('error', reject);
      });
      written = start;
    }
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      await handle.write(buf);
      hash.update(buf);
      written += buf.length;
      state.lastBytes = written;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), bytes: written, resumed: append };
}

function entryFor(offer) {
  const id = offer.deliveryId;
  const existing = state.log[id];
  if (existing) return existing;
  state.log[id] = {
    deliveryId: id,
    project: offer.project,
    version: { id: offer.version?.id, code: offer.version?.code, approvedAt: offer.version?.approvedAt },
    hostUrl: hostBase(),
    targetDir: deliveryTargetDir(offer),
    totalBytes: offer.totalBytes,
    fileCount: offer.files?.length || 0,
    status: 'offered',
    items: {},
    startedAt: null,
    finishedAt: null,
    error: null,
    history: [],
  };
  return state.log[id];
}

async function reportProgress(entry, { fileId = null } = {}) {
  const transferredBytes = Object.values(entry.items).reduce((sum, i) => sum + (i.bytes || 0), 0);
  const okCount = Object.values(entry.items).filter((i) => i.sha256Ok).length;
  try {
    await hostCall('POST', `/api/me/deliveries/${entry.deliveryId}/progress`, { transferredBytes, okCount, fileId });
  } catch (err) {
    entry.error = { code: err.code || 'progress_failed', message: `进度回报失败：${err.message}` };
    state.events.publish('local', 'delivery.error', { deliveryId: entry.deliveryId, message: entry.error.message });
  }
  state.events.publish('local', 'delivery.progress', {
    deliveryId: entry.deliveryId,
    transferredBytes,
    totalBytes: entry.totalBytes,
    okCount,
    fileCount: entry.fileCount,
    fileId,
  });
}

async function runDelivery(offer) {
  const entry = entryFor(offer);
  if (state.busy.has(entry.deliveryId)) return;
  state.busy.add(entry.deliveryId);
  try {
    const free = await diskFreeBytes(state.cfg.receiveRoot);
    entry.targetDir = deliveryTargetDir(offer);
    await fsp.mkdir(entry.targetDir, { recursive: true });
    if (free.supported && free.free < (offer.totalBytes || 0) + 64 * 1024 * 1024) {
      entry.status = 'failed';
      entry.error = {
        code: 'receiver_no_space',
        message: `接收电脑空间不足：需要 ${formatBytes((offer.totalBytes || 0) + 64 * 1024 * 1024)}，剩余 ${formatBytes(free.free)}`,
      };
      entry.finishedAt = nowIso();
      await hostCall('POST', `/api/me/deliveries/${entry.deliveryId}/report`, {
        items: [],
        failed: true,
        errorCode: 'receiver_no_space',
        errorMessage: entry.error.message,
      }).catch(() => {});
      state.events.publish('local', 'delivery.failed', { deliveryId: entry.deliveryId, message: entry.error.message });
      await persistLog();
      return;
    }

    const accepted = await hostCall('POST', `/api/me/deliveries/${entry.deliveryId}/accept`, {
      targetDir: entry.targetDir,
      freeBytes: free.free,
    });
    entry.status = 'transferring';
    entry.startedAt = entry.startedAt || nowIso();
    entry.hostFiles = accepted.files || [];
    entry.targetDir = accepted.targetDir || entry.targetDir;
    entry.history.push({ at: nowIso(), event: 'accepted', attempt: (entry.history.length || 0) + 1 });
    state.events.publish('local', 'delivery.started', { deliveryId: entry.deliveryId, targetDir: entry.targetDir });
    await persistLog();
    await reportProgress(entry);

    let mismatch = null;
    for (const file of accepted.files || []) {
      const prev = entry.items[file.fileId];
      if (prev?.sha256Ok && prev.sha256 === file.sha256 && fs.existsSync(path.join(entry.targetDir, prev.relPath || ''))) {
        continue; // already verified in a previous attempt
      }
      const rel = safeRelPath(file);
      const target = path.join(entry.targetDir, rel);
      const expectedSize = file.size;
      const existingSize = fs.existsSync(`${target}.part`) ? (await fsp.stat(`${target}.part`)).size : 0;
      const resumeFrom = existingSize > 0 && existingSize < expectedSize ? existingSize : 0;
      try {
        const result = await downloadFile(file.url || `/api/me/transfer/${entry.deliveryId}/${file.fileId}`, target, { resumeFrom });
        const shaOk = result.sha256 === file.sha256;
        await fsp.rename(`${target}.part`, target);
        entry.items[file.fileId] = {
          fileId: file.fileId,
          name: file.name,
          relPath: rel,
          path: target,
          size: result.bytes,
          expectedSize,
          sha256: result.sha256,
          sha256Ok: shaOk,
          resumed: result.resumed,
          at: nowIso(),
        };
        if (!shaOk) {
          mismatch = file.name;
          await fsp.rm(target, { force: true });
          delete entry.items[file.fileId];
          break;
        }
      } catch (err) {
        entry.status = 'failed';
        entry.error = { code: err.code || 'transfer_failed', message: `传输「${file.name}」失败：${err.message}` };
        entry.finishedAt = nowIso();
        entry.history.push({ at: nowIso(), event: 'error', message: err.message });
        await hostCall('POST', `/api/me/deliveries/${entry.deliveryId}/report`, {
          items: completedItems(entry),
          failed: true,
          errorCode: entry.error.code,
          errorMessage: entry.error.message,
        }).catch(() => {});
        state.events.publish('local', 'delivery.failed', { deliveryId: entry.deliveryId, message: entry.error.message });
        await persistLog();
        await reportProgress(entry);
        return;
      }
      await reportProgress(entry, { fileId: file.fileId });
      await persistLog();
    }

    entry.status = 'verifying';
    state.events.publish('local', 'delivery.verifying', { deliveryId: entry.deliveryId });
    const items = completedItems(entry);
    const final = await hostCall('POST', `/api/me/deliveries/${entry.deliveryId}/report`, {
      items,
      failed: !!mismatch,
      errorCode: mismatch ? 'hash_mismatch' : undefined,
      errorMessage: mismatch ? `文件校验不一致：${mismatch}` : undefined,
    });
    entry.status = final.status === 'succeeded' ? 'succeeded' : 'failed';
    entry.finishedAt = nowIso();
    entry.error = entry.status === 'succeeded' ? null : { code: 'verify_failed', message: final.error || '创作者端校验未通过' };
    entry.history.push({ at: nowIso(), event: entry.status });
    await persistLog();
    state.events.publish('local', entry.status === 'succeeded' ? 'delivery.succeeded' : 'delivery.failed', {
      deliveryId: entry.deliveryId,
      targetDir: entry.targetDir,
      message: entry.status === 'succeeded' ? `已接收 ${items.length} 个文件` : entry.error.message,
    });
  } catch (err) {
    entry.status = entry.status === 'succeeded' ? 'succeeded' : 'failed';
    entry.error = { code: err.code || 'error', message: err.message };
    if (err.code === 'not_approved' || err.code === 'delivery_forbidden') {
      entry.status = 'blocked';
    }
    state.events.publish('local', 'delivery.error', { deliveryId: entry.deliveryId, message: err.message });
    await persistLog();
  } finally {
    state.busy.delete(entry.deliveryId);
  }
}

function completedItems(entry) {
  return Object.values(entry.items)
    .filter((i) => i.sha256Ok)
    .map((i) => ({ fileId: i.fileId, sha256: i.sha256, size: i.size, path: i.path, relPath: i.relPath }));
}

function safeRelPath(file) {
  const rel = String(file.relPath || file.name || '').replace(/[\\]/g, '/');
  const cleaned = rel.split('/').filter((p) => p && p !== '.' && !p.startsWith('__MACOSX'));
  const safe = cleaned.map((p) => sanitizeSegment(p, '文件')).filter(Boolean);
  if (!safe.length) safe.push(`文件-${file.fileId.slice(-6)}`);
  return safe.join('/');
}

/* ------------------------------------------------------------------- worker */

let heartbeatAt = 0;

async function poll() {
  if (!state.cfg.hostUrl || !state.cfg.token) return;
  try {
    const inbox = await hostCall('GET', '/api/me/inbox', undefined, { allowPending: true });
    state.device = inbox.device;
    state.offers = inbox.offers || [];
    const active = (inbox.offers || []).filter((o) => o.status !== 'cancelled');
    for (const offer of active) {
      const entry = entryFor(offer);
      if (entry.status === 'succeeded') {
        // 本地已完成但创作者端仍在等待：重发结果，避免两端状态不一致
        await hostCall('POST', `/api/me/deliveries/${offer.deliveryId}/report`, {
          items: completedItems(entry),
          failed: false,
        }).catch(() => {});
        continue;
      }
      runDelivery(offer);
    }
    state.lastError = null;
  } catch (err) {
    state.lastError = { at: nowIso(), message: err.message, code: err.code };
    if (err.code === 'device_pending') state.device = { ...(state.device || {}), approved: false, status: 'pending' };
  }
  if (Date.now() - heartbeatAt > HEARTBEAT_MS) {
    heartbeatAt = Date.now();
    hostCall('POST', '/api/me/heartbeat', {}).then((res) => {
      state.device = res.device;
    }).catch(() => {});
  }
}

/* -------------------------------------------------------------------- http */

const router = new Router();

async function publicState() {
  const deliveries = Object.values(state.log)
    .sort((a, b) => String(b.startedAt || b.finishedAt || '').localeCompare(String(a.startedAt || a.finishedAt || '')))
    .map((entry) => ({
      deliveryId: entry.deliveryId,
      project: entry.project,
      version: entry.version,
      status: entry.status,
      targetDir: entry.targetDir,
      totalBytes: entry.totalBytes,
      receivedBytes: Object.values(entry.items).reduce((s, i) => s + (i.size || i.bytes || 0), 0),
      fileCount: entry.fileCount,
      okCount: Object.values(entry.items).filter((i) => i.sha256Ok).length,
      items: Object.values(entry.items).map((i) => ({ ...i })),
      error: entry.error,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      hostUrl: entry.hostUrl,
    }));
  return {
    app: { name: APP_NAME, version: APP_VERSION, role: 'receiver' },
    paired: !!(state.cfg.hostUrl && state.cfg.token),
    hostUrl: state.cfg.hostUrl,
    host: state.host,
    device: state.device,
    name: state.cfg.name,
    receiveRoot: state.cfg.receiveRoot || '',
    receiveRootExists: !!state.cfg.receiveRoot && fs.existsSync(state.cfg.receiveRoot),
    receiveRootFree: state.cfg.receiveRoot ? (await diskFreeBytes(state.cfg.receiveRoot)).free ?? null : null,
    deliveries,
    offers: state.offers,
    busy: [...state.busy],
    lastError: state.lastError,
    localUrl: `http://127.0.0.1:${state.port}`,
    lanUrl: `http://${primaryLanAddress() || '127.0.0.1'}:${state.port}`,
    startedAt: state.startedAt,
    platform: process.platform,
  };
}

router.get('/api/state', async () => publicState());

router.post('/api/rename', async (ctx) => {
  const name = sanitizeSegment(ctx.body.name, '').slice(0, 40);
  if (!name) throw new AppError('name_required', '名称不能为空', 400);
  state.cfg.name = name;
  await persist();
  if (state.cfg.token) {
    await hostCall('POST', '/api/me/name', { name }).catch(() => {});
  }
  state.events.publish('local', 'device.renamed', { name });
  return { ok: true, name };
});

router.post('/api/pair', async (ctx) => {
  const hostUrl = String(ctx.body.hostUrl || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(hostUrl)) throw new AppError('bad_host', '请填写创作者电脑显示的局域网地址，例如 http://192.168.1.20:8780', 400);
  const code = String(ctx.body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new AppError('bad_code', '配对码是 6 位字母数字', 400);
  state.cfg.hostUrl = hostUrl;
  let health;
  try {
    health = await fetch(`${hostUrl}/api/health`, { method: 'GET' }).then((r) => r.json());
  } catch (err) {
    state.cfg.hostUrl = '';
    throw new AppError('host_unreachable', `连不上创作者电脑（${hostUrl}）。请确认两台电脑在同一个局域网，并且创作者程序正在运行。`, 502, {
      hint: err.message,
    });
  }
  const redeem = await fetch(`${hostUrl}/api/pair/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      name: sanitizeSegment(ctx.body.name || state.cfg.name || os.hostname(), '笔记本'),
      platform: `${process.platform} / node ${process.version}`,
      appVersion: APP_VERSION,
    }),
  }).then(async (r) => {
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      throw new AppError(data?.error?.code || 'pair_failed', data?.error?.message || `配对失败（${r.status}）`, r.status >= 400 && r.status < 500 ? r.status : 502, data?.error?.detail);
    }
    return data;
  });
  state.cfg.deviceId = redeem.deviceId;
  state.cfg.token = redeem.token;
  state.cfg.name = sanitizeSegment(ctx.body.name || state.cfg.name, '笔记本');
  await persist();
  state.events.publish('local', 'device.paired', { deviceId: redeem.deviceId });
  poll().catch(() => {});
  return { ok: true, hostName: redeem.hostName, approved: redeem.approved, health };
});

router.post('/api/unpair', async () => {
  state.cfg.token = '';
  state.cfg.deviceId = '';
  state.cfg.hostUrl = '';
  await persist();
  state.device = null;
  return { ok: true };
});

router.post('/api/receive-root/pick', async () => {
  const res = await pickFolderNative(state.cfg.receiveRoot || path.join(os.homedir(), 'Downloads'));
  if (!res.ok) return { ok: false, cancelled: !!res.cancelled, reason: res.reason || '未选择文件夹' };
  await setReceiveRoot(res.path);
  return { ok: true, path: res.path };
});

async function setReceiveRoot(target) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) await fsp.mkdir(abs, { recursive: true });
  const stat = await fsp.stat(abs);
  if (!stat.isDirectory()) throw new AppError('not_a_folder', '请选择一个文件夹', 400);
  fs.accessSync(abs, fs.constants.W_OK);
  state.cfg.receiveRoot = abs;
  await persist();
  state.events.publish('local', 'receiveRoot.changed', { path: abs });
}

router.post('/api/receive-root/set', (ctx) => setReceiveRoot(String(ctx.body.path || '')).then(() => ({ ok: true, path: state.cfg.receiveRoot })));

router.get('/api/browse', async (ctx) => {
  const dir = ctx.query.get('dir') || state.cfg.receiveRoot || os.homedir();
  const result = await listChildren(dir);
  result.free = await diskFreeBytes(dir);
  return result;
});

router.get('/api/deliveries', async () => ({ deliveries: (await publicState()).deliveries }));

router.post('/api/deliveries/:id/retry', async (ctx) => {
  const entry = state.log[ctx.params.id];
  if (!entry) throw new AppError('delivery_missing', '本地没有这条交付记录', 404);
  try {
    await hostCall('POST', `/api/me/deliveries/${ctx.params.id}/retry`, {});
  } catch (err) {
    if (err.code !== 'already_running') throw err;
  }
  entry.status = 'retrying';
  entry.error = null;
  await persistLog();
  poll().catch(() => {});
  return { ok: true };
});

router.post('/api/reveal', (ctx) => {
  const target = String(ctx.body.path || state.cfg.receiveRoot || '');
  if (!target || !fs.existsSync(target)) throw new AppError('path_missing', '该位置当前不存在', 404);
  return { ok: revealInFileManager(target), path: target };
});

router.post('/api/selftest', async () => {
  const started = Date.now();
  if (!state.cfg.hostUrl) return { ok: false, message: '尚未连接创作者电脑' };
  try {
    const res = await fetch(`${state.cfg.hostUrl}/api/health`, { method: 'GET' });
    const data = await res.json();
    return { ok: !!data.ok, ms: Date.now() - started, status: res.status, host: state.cfg.hostUrl, at: nowIso() };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err.message, host: state.cfg.hostUrl, at: nowIso() };
  }
});

router.get('/api/events', (ctx) => {
  state.events.register(ctx.res, { channel: 'local' });
});

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/(.+)\/$/, '$1') || '/';
  const method = req.method.toUpperCase();
  try {
    if (pathname.startsWith('/api/') && method !== 'GET' && !isLoopback(clientAddress(req))) {
      sendJson(res, 403, { error: { code: 'local_only', message: '这些操作只能在这台电脑自己打开的页面上进行' } });
      return undefined;
    }
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const abs = path.join(WEB, 'receiver', 'index.html');
      const html = fs.readFileSync(abs, 'utf8').replace(
        '<!--BOOTSTRAP-->',
        `<script>window.__LR_BOOTSTRAP__=${JSON.stringify({
          app: { name: APP_NAME, label: '接收端', version: APP_VERSION },
          port: state.port,
          hostUrl: state.cfg.hostUrl,
          receiveRoot: state.cfg.receiveRoot,
          name: state.cfg.name,
        }).replace(/</g, '\\u003c')};</script>`,
      );
      const data = Buffer.from(html, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
      return res.end(data);
    }
    const asset = /^\/(shared|receiver)\/([\w.-]+\.(?:js|css|svg|png|ico))$/.exec(pathname);
    if (asset && method === 'GET') {
      const abs = path.join(WEB, asset[1], asset[2]);
      if (!abs.startsWith(WEB) || !fs.existsSync(abs)) {
        sendJson(res, 404, { error: { code: 'asset_missing', message: '页面资源缺失' } });
        return undefined;
      }
      const data = fs.readFileSync(abs);
      res.writeHead(200, { 'Content-Type': mimeFor(abs), 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
      return res.end(data);
    }
    const matched = router.match(method, pathname);
    if (!matched) {
      sendJson(res, 404, { error: { code: 'no_route', message: '接口不存在' } });
      return undefined;
    }
    const body = method === 'POST' || method === 'PUT' ? await readJsonBody(req) : {};
    const ctx = { req, res, params: matched.params, query: url.searchParams, body, method };
    const out = await matched.route.handler(ctx);
    if (res.headersSent) return undefined;
    sendJson(res, out === undefined ? 204 : 200, out === undefined ? {} : out);
    return undefined;
  } catch (err) {
    const status = err instanceof AppError ? err.status : 500;
    if (status >= 500) console.error('接收端错误：', err);
    if (!res.headersSent) sendJson(res, status, { error: { code: err.code || 'internal_error', message: err.message, detail: err.detail || null } });
    else res.end();
    return undefined;
  }
}

export async function startAgent({ port = DEFAULT_PORT, open = true } = {}) {
  await load();
  const chosen = await findFreePort(port, 12);
  state.port = chosen;
  const server = http.createServer(handle);
  server.keepAliveTimeout = 65_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(chosen, '0.0.0.0', resolve);
  });
  const localUrl = `http://127.0.0.1:${chosen}`;
  console.log(`
  ${APP_NAME} 接收端 v${APP_VERSION}
  本机打开    ${localUrl}
  设备名称    ${state.cfg.name}
  接收文件夹  ${state.cfg.receiveRoot || '尚未选择'}
  已连接      ${state.cfg.hostUrl || '尚未连接创作者电脑'}
`);
  if (open) openBrowser(localUrl);
  state.pollTimer = setInterval(() => poll().catch(() => {}), POLL_MS);
  poll().catch(() => {});
  const shutdown = () => {
    clearInterval(state.pollTimer);
    state.events.closeAll();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { server, port: chosen, localUrl, state };
}

const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  startAgent({ open: !process.argv.includes('--no-open') }).catch((err) => {
    console.error('接收端启动失败：', err);
    process.exit(1);
  });
}
