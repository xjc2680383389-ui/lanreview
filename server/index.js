import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, SseHub, mimeFor, readJsonBody, sendJson } from './lib/http.js';
import { AppError, APP_LABEL, APP_NAME, APP_VERSION, mkdirp, nowIso, writeFileAtomic } from './lib/util.js';
import {
  DATA_DIR, DEFAULT_PORT, fsAccessible, isSafeWorkspace, loadConfig, saveConfig, workspaceMetaPath,
} from './lib/config.js';
import { closeWorkspaceDb, ensureWorkspaceDirs, openWorkspaceDb } from './lib/db.js';
import { clientAddress, findFreePort, isLoopback, lanAddresses, openBrowser, primaryLanAddress } from './lib/net.js';
import { creatorBootstrapPayload, isCreatorRequest } from './lib/security.js';
import * as store from './lib/store.js';
import { register as registerCreator } from './routes/creator.js';
import { register as registerDevice } from './routes/device.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB = path.join(ROOT, 'web');

/** Endpoints that must answer before a workspace exists. */
const DB_FREE = new Set([
  '/api/health',
  '/api/info',
  '/api/system',
  '/api/workspace',
  '/api/workspace/pick',
  '/api/workspace/browse',
  '/api/workspace/set',
  '/api/workspace/reveal',
  '/api/events',
  '/api/qr',
]);

const PUBLIC_API = ['/api/me/', '/api/pair/'];

const app = {
  appName: APP_NAME,
  appLabel: APP_LABEL,
  appVersion: APP_VERSION,
  root: ROOT,
  webRoot: WEB,
  cfg: null,
  db: null,
  workspace: null,
  port: DEFAULT_PORT,
  baseUrl: '',
  startedAt: nowIso(),
  events: new SseHub(),
  recentFailures: [],
  onlineDeviceIds: new Set(),
  lastSelfTest: null,
  router: new Router(),
  setWorkspace,
};

registerCreator(app.router, app);
registerDevice(app.router, app);
app.router.get('/api/info', () => ({
  app: { name: APP_NAME, label: APP_LABEL, version: APP_VERSION },
  host: { name: app.cfg?.hostName, platform: process.platform },
  time: nowIso(),
}));

/* ------------------------------------------------------------------ workspace */

async function setWorkspace(target, { create = true, announce = true } = {}) {
  const abs = path.resolve(String(target || ''));
  if (!isSafeWorkspace(abs)) {
    throw new AppError('bad_workspace', '请选择一个具体的文件夹作为工作区（不能是磁盘根目录或用户主目录本身）', 400);
  }
  const exists = fs.existsSync(abs);
  if (exists && !fs.statSync(abs).isDirectory()) throw new AppError('not_a_folder', '所选位置是一个文件，请选择文件夹', 400);
  if (!exists && !create) throw new AppError('folder_missing', '该文件夹不存在', 404);
  if (!exists) {
    try {
      await mkdirp(abs);
    } catch (err) {
      throw new AppError('cannot_create', `无法创建该文件夹：${err.message}`, 500);
    }
  }
  if (!fsAccessible(abs)) throw new AppError('not_writable', '这个文件夹没有写入权限，请换一个位置', 403);
  await ensureWorkspaceDirs(abs);

  const metaFile = workspaceMetaPath(abs);
  let meta = null;
  if (fs.existsSync(metaFile)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch {
      meta = null;
    }
  } else {
    meta = { app: APP_NAME, version: APP_VERSION, createdAt: nowIso(), hostName: app.cfg.hostName };
    await writeFileAtomic(metaFile, JSON.stringify(meta, null, 2));
  }

  const previous = app.workspace;
  if (previous && path.resolve(previous) !== abs) closeWorkspaceDb(previous);
  app.db = openWorkspaceDb(abs);
  app.workspace = abs;
  const recent = [abs, ...(app.cfg.recentWorkspaces || []).filter((p) => path.resolve(p) !== abs)].slice(0, 8);
  await saveConfig({ workspace: abs, recentWorkspaces: recent });
  if (announce) store.logActivity(app, 'workspace.opened', `打开工作区 ${abs}`);
  const count = (sql) => app.db.prepare(sql).get().n;
  return {
    workspace: abs,
    existingWorkspace: !!meta,
    meta,
    projectCount: count('SELECT COUNT(*) AS n FROM projects'),
    versionCount: count('SELECT COUNT(*) AS n FROM versions'),
    deviceCount: count('SELECT COUNT(*) AS n FROM devices'),
  };
}

/* ----------------------------------------------------------------- dispatch */

function normalize(pathname) {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw */
  }
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

function isPublicApi(pathname) {
  return pathname === '/api/info' || pathname === '/api/health' || PUBLIC_API.some((prefix) => pathname.startsWith(prefix));
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${app.port}`}`);
  const pathname = normalize(url.pathname);
  const method = req.method.toUpperCase();
  const ip = clientAddress(req);
  const loopback = isLoopback(ip);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  try {
    if (method === 'GET' || method === 'HEAD') {
      if (pathname === '/' || pathname === '/index.html' || pathname === '/console') return servePage(res, 'creator/index.html', req);
      if (pathname === '/r' || pathname === '/reviewer' || pathname === '/pair' || pathname === '/p') {
        return servePage(res, 'reviewer/index.html', req);
      }
      if (pathname === '/get-receiver') return servePage(res, 'receiver/landing.html', req, { isPublic: true });
      if (pathname === '/favicon.ico') {
        const svg = readWebFile('shared/favicon.svg');
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
        return res.end(svg || Buffer.alloc(0));
      }
      const asset = /^\/(shared|creator|reviewer|receiver)\/([\w.-]+\.(?:js|css|svg|png|jpg|woff2|html))$/.exec(pathname);
      if (asset) {
        const abs = path.join(WEB, asset[1], asset[2]);
        if (!abs.startsWith(WEB) || !fs.existsSync(abs)) return notFound(res, pathname);
        return sendStatic(res, abs);
      }
    }

    const matched = app.router.match(method, pathname);
    if (!matched || matched.methodMismatch) {
      if (!pathname.startsWith('/api/')) return notFound(res, pathname);
      sendJson(res, matched ? 405 : 404, { error: { code: 'no_route', message: '这个操作暂时不可用' } });
      return undefined;
    }

    if (pathname.startsWith('/api/') && !isPublicApi(pathname) && !isCreatorRequest(app, req)) {
      throw new AppError('creator_required', '这是创作者电脑上的操作。请在创作者电脑打开页面，或输入创作者口令。', 403, {
        needsCreatorToken: true,
      });
    }
    if (pathname.startsWith('/api/') && !DB_FREE.has(pathname) && !app.db) {
      throw new AppError('workspace_missing', '请先在创作者页面选择工作区', 409, { needsWorkspace: true });
    }

    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') body = await readJsonBody(req);

    const ctx = {
      req,
      res,
      app,
      method,
      pathname,
      query: url.searchParams,
      params: matched.params,
      body,
      ip,
      loopback,
    };
    const out = await matched.route.handler(ctx);
    if (res.headersSent) {
      if (!res.writableEnded && !res.localreviewStream) res.end();
      return undefined;
    }
    sendJson(res, out === undefined ? 204 : 200, out === undefined ? {} : out);
    return undefined;
  } catch (err) {
    const status = err instanceof AppError ? err.status : 500;
    const payload = {
      error: { code: err.code || 'internal_error', message: err.message || '服务器出现错误', detail: err.detail || null },
    };
    if (status >= 500) console.error(`[${nowIso()}] ${method} ${pathname} 失败：`, err);
    if (status >= 400 && err.code !== 'device_pending') {
      app.recentFailures.push({ ts: nowIso(), method, path: pathname, status, code: payload.error.code, message: payload.error.message, ip });
      if (app.recentFailures.length > 80) app.recentFailures.shift();
    }
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return undefined;
    }
    sendJson(res, status, payload);
    return undefined;
  }
}

function notFound(res, pathname) {
  sendJson(res, 404, { error: { code: 'not_found', message: `没有找到 ${pathname}` } });
  return undefined;
}

function readWebFile(rel) {
  const abs = path.join(WEB, rel);
  if (!abs.startsWith(WEB)) return null;
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

function sendStatic(res, absPath) {
  const data = fs.readFileSync(absPath);
  res.writeHead(200, { 'Content-Type': mimeFor(absPath), 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
  res.end(data);
  return undefined;
}

function servePage(res, rel, req, { isPublic = false } = {}) {
  const abs = path.join(WEB, rel);
  if (!fs.existsSync(abs)) return notFound(res, rel);
  const html = fs.readFileSync(abs, 'utf8');
  const bootstrap = isPublic
    ? {
        public: true,
        app: { name: app.appName, label: app.appLabel, version: app.appVersion },
        hostName: app.cfg?.hostName,
        baseUrl: app.baseUrl,
        port: app.port,
        lanIps: lanAddresses(),
      }
    : {
        ...creatorBootstrapPayload(app, req),
        baseUrl: app.baseUrl,
        port: app.port,
        lanIps: lanAddresses(),
        workspace: app.workspace,
      };
  const injected = html.replace(
    '<!--BOOTSTRAP-->',
    `<script>window.__LR_BOOTSTRAP__=${JSON.stringify(bootstrap).replace(/</g, '\\u003c')};</script>`,
  );
  const data = Buffer.from(injected, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
  return undefined;
}

/* --------------------------------------------------------------------- boot */

async function start({ open = true, port: portOverride = null } = {}) {
  app.cfg = await loadConfig();
  if (portOverride) app.cfg = await saveConfig({ port: portOverride });
  const port = await findFreePort(app.cfg.port || DEFAULT_PORT);
  app.port = port;
  if (port !== app.cfg.port) app.cfg = await saveConfig({ port });

  if (app.cfg.workspace && fs.existsSync(app.cfg.workspace)) {
    try {
      await setWorkspace(app.cfg.workspace, { create: false, announce: false });
    } catch (err) {
      console.warn(`无法打开上次的工作区 ${app.cfg.workspace}：${err.message}`);
      app.db = null;
      app.workspace = null;
    }
  }

  const server = http.createServer(handle);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });

  app.baseUrl = `http://${primaryLanAddress() || '127.0.0.1'}:${port}`;
  const localUrl = `http://127.0.0.1:${port}`;

  runSelfTest(port).catch(() => {});
  app.selfTestTimer = setInterval(() => runSelfTest(port).catch(() => {}), 60_000);
  app.sweepTimer = setInterval(() => sweep(), 10_000);

  import('../packaging/build-receiver-kit.js')
    .then(({ ensureReceiverKit }) => ensureReceiverKit(ROOT))
    .catch((err) => console.warn('接收端安装包预生成失败：', err.message));

  console.log(`
  ${APP_NAME} v${APP_VERSION} · ${APP_LABEL}
  本机打开    ${localUrl}
  局域网地址  ${app.baseUrl}    （手机、笔记本用这个地址）
  网络接口    ${lanAddresses().map((a) => `${a.name} ${a.address}`).join('，') || '未检测到局域网地址'}
  数据位置    ${app.workspace ? path.join(app.workspace, '.lanreview') : '尚未选择工作区'}
`);
  if (open) openBrowser(localUrl);

  await writeFileAtomic(
    path.join(DATA_DIR, 'running.json'),
    JSON.stringify({ pid: process.pid, port, baseUrl: app.baseUrl, localUrl, startedAt: app.startedAt, workspace: app.workspace }, null, 2),
  );

  const shutdown = () => {
    clearInterval(app.sweepTimer);
    clearInterval(app.selfTestTimer);
    app.events.closeAll();
    server.close();
    if (app.workspace) closeWorkspaceDb(app.workspace);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, port, localUrl, baseUrl: app.baseUrl, app };
}

function sweep() {
  if (!app.db) return;
  try {
    store.sweepDevicePresence(app);
    const stalled = app.db
      .prepare(
        `SELECT * FROM deliveries WHERE status IN ('queued','transferring','verifying')
         AND (julianday('now') - julianday(updated_at)) * 86400 > ?`,
      )
      .all(store.DELIVERY_STALL_MS / 1000);
    for (const dl of stalled) {
      const device = store.getDevice(app, dl.device_id);
      const reason = !device || !store.deviceIsOnline(device)
        ? '接收设备超过 1 分钟没有响应，可能已离线或退出了接收端程序'
        : '接收端超过 1 分钟没有回报进度，传输可能已中断';
      app.db.prepare("UPDATE deliveries SET status = 'stalled', error_code = 'no_progress', error_message = ?, updated_at = ? WHERE id = ?").run(reason, nowIso(), dl.id);
      app.events.publish('creator', 'delivery.updated', { deliveryId: dl.id, status: 'stalled', message: reason });
      app.events.publish(`device:${dl.device_id}`, 'delivery.stalled', { deliveryId: dl.id, message: reason });
      store.logActivity(app, 'delivery.stalled', `${dl.version_code || ''} 交付中断：${reason}`, {
        projectId: dl.project_id,
        versionId: dl.version_id,
        deviceId: dl.device_id,
      });
    }
  } catch (err) {
    console.error('状态巡检失败：', err.message);
  }
}

async function runSelfTest(port) {
  const ips = lanAddresses();
  const target = ips[0]?.address || '127.0.0.1';
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const req = http.get({ host: target, port, path: '/api/health', timeout: 4000 }, (res) => {
      let text = '';
      res.on('data', (c) => {
        text += c;
      });
      res.on('end', () => {
        let ok = false;
        try {
          ok = JSON.parse(text).ok === true;
        } catch {
          ok = false;
        }
        resolve({ ok, status: res.statusCode, ms: Date.now() - started });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, error: err.message, ms: Date.now() - started }));
  });
  app.lastSelfTest = { ...result, ip: target, at: nowIso(), ips: ips.map((i) => i.address) };
  return app.lastSelfTest;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  start({ open: !process.argv.includes('--no-open') }).catch((err) => {
    console.error('启动失败：', err);
    process.exit(1);
  });
}

export { app, setWorkspace, start };
