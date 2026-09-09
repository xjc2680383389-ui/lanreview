import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, APP_LABEL, APP_NAME, APP_VERSION, formatBytes, nowIso } from '../lib/util.js';
import { diskFreeBytes, homeDirs, listChildren, readTextSample, safeJoin } from '../lib/fsx.js';
import { sendFile } from '../lib/http.js';
import { creatorCookie } from '../lib/security.js';
import { lanAddresses, pickFolderNative, primaryLanAddress, revealInFileManager } from '../lib/net.js';
import { workspaceMetaPath } from '../lib/config.js';
import * as store from '../lib/store.js';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function register(router, app) {
  /* ---------------------------------------------------------------- system */

  router.get('/api/system', async (ctx) => {
    return {
      app: { name: APP_NAME, label: APP_LABEL, version: APP_VERSION },
      host: {
        name: app.cfg.hostName,
        platform: process.platform,
        node: process.version,
        port: app.port,
        lanIps: lanAddresses(),
        primaryIp: primaryLanAddress(),
        startedAt: app.startedAt,
        baseUrl: app.baseUrl,
      },
      creator: { loopback: ctx.loopback, needsToken: !ctx.loopback },
      workspace: app.workspace
        ? { path: app.workspace, exists: fs.existsSync(app.workspace), free: await diskFreeBytes(app.workspace) }
        : null,
      stats: app.db ? store.projectStats(app) : null,
      receiverKit: receiverKitInfo(),
    };
  });

  router.get('/api/health', () => ({ ok: true, at: nowIso(), app: APP_NAME, version: APP_VERSION }));

  /* -------------------------------------------------------------- workspace */

  router.get('/api/workspace', () => {
    if (!app.workspace) return { workspace: null, recent: app.cfg.recentWorkspaces || [], needsSetup: true };
    const exists = fs.existsSync(app.workspace);
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(workspaceMetaPath(app.workspace), 'utf8'));
    } catch {
      meta = null;
    }
    return {
      workspace: { path: app.workspace, exists, meta },
      recent: app.cfg.recentWorkspaces || [],
      shortcuts: homeDirs(),
      stats: store.projectStats(app),
      needsSetup: false,
    };
  });

  router.post('/api/workspace/pick', async () => {
    const res = await pickFolderNative(app.workspace || os.homedir());
    if (!res.ok) return { ok: false, cancelled: !!res.cancelled, reason: res.reason || '未选择文件夹', fallbackAvailable: true };
    return { ok: true, path: res.path };
  });

  router.get('/api/workspace/browse', async (ctx) => {
    const dir = ctx.query.get('dir') || os.homedir();
    const result = await listChildren(dir);
    result.shortcuts = homeDirs();
    result.free = await diskFreeBytes(dir);
    return result;
  });

  router.post('/api/workspace/set', async (ctx) => {
    const target = String(ctx.body.path || '').trim();
    if (!target) throw new AppError('path_required', '请选择一个文件夹作为工作区', 400);
    const info = await app.setWorkspace(target, { create: ctx.body.create !== false });
    ctx.res.setHeader('Set-Cookie', creatorCookie(app.cfg));
    return { ok: true, ...info };
  });

  router.post('/api/workspace/reveal', (ctx) => {
    const target = String(ctx.body.path || app.workspace);
    if (!fs.existsSync(target)) throw new AppError('path_missing', '该位置当前不存在', 404);
    const ok = revealInFileManager(target);
    if (!ok) throw new AppError('reveal_failed', '无法打开系统文件管理器，请手动前往该位置', 500);
    return { ok: true, path: target };
  });

  /* ---------------------------------------------------------------- projects */

  router.get('/api/projects', async () => ({ projects: await store.listProjects(app) }));

  router.post('/api/projects/preview', (ctx) => {
    const folder = store.previewProjectFolder(app, ctx.body || {});
    return {
      folder,
      workspace: app.workspace,
      exists: fs.existsSync(folder),
      hasFiles: fs.existsSync(folder) ? fs.readdirSync(folder).length > 0 : false,
      registered: !!findProjectByFolder(app, folder),
    };
  });

  router.post('/api/projects', async (ctx) => {
    const project = await store.createProject(app, ctx.body || {});
    return { project };
  });

  router.post('/api/projects/import', async (ctx) => {
    const result = await store.importExistingProject(app, ctx.body.path);
    return { project: result.project, reused: result.reused };
  });

  router.get('/api/projects/:id', async (ctx) => {
    const project = store.getProject(app, ctx.params.id);
    return {
      project,
      folderExists: fs.existsSync(project.folder_path),
      versions: store.listProjectVersionCards(app, project.id),
      draft: await store.getDraft(app, project.id),
    };
  });

  router.post('/api/projects/:id/update', async (ctx) => ({ project: await store.updateProject(app, ctx.params.id, ctx.body || {}) }));

  /* ------------------------------------------------------------------ draft */

  router.get('/api/projects/:id/draft', (ctx) => store.getDraft(app, ctx.params.id));

  router.post('/api/projects/:id/draft/add', (ctx) => store.addDraft(app, ctx.params.id, ctx.body || {}));

  router.post('/api/projects/:id/draft/remove', (ctx) =>
    store.removeDraft(app, ctx.params.id, { sourcePath: ctx.body.sourcePath, clearAll: !!ctx.body.clearAll }),
  );

  router.post('/api/projects/:id/draft/pick', async (ctx) => {
    const res = await pickFolderNative(ctx.body.startDir || app.workspace || projectFolder(app, ctx.params.id));
    if (!res.ok) return { ok: false, cancelled: true, reason: res.reason || '未选择文件夹' };
    const draft = await store.addDraft(app, ctx.params.id, { paths: [res.path] });
    return { ok: true, ...draft };
  });

  /* --------------------------------------------------------------- versions */

  router.post('/api/projects/:id/submit', (ctx) => store.submitVersion(app, ctx.params.id, ctx.body || {}));

  router.get('/api/versions/:id', (ctx) => store.getVersionDetail(app, ctx.params.id));

  router.post('/api/versions/:id/reassign', (ctx) =>
    store.reassignReviewers(app, ctx.params.id, Array.isArray(ctx.body.deviceIds) ? ctx.body.deviceIds : []),
  );

  router.post('/api/versions/:id/verify', (ctx) =>
    store.verifyVersionIntegrity(app, ctx.params.id, { touchSources: ctx.body.touchSources !== false }),
  );

  router.post('/api/comments/:id/resolve', (ctx) =>
    store.setCommentResolved(app, { commentId: ctx.params.id, resolved: ctx.body.resolved !== false }),
  );

  /* ---------------------------------------------------------- creator media */

  router.get('/api/creator/media/:versionId/:fileId', async (ctx) => {
    const { version, file } = lookupSnapshotFile(app, ctx.params.versionId, ctx.params.fileId);
    const abs = safeJoin(version.snapshot_dir, file.snapshot_rel);
    await sendFile(ctx.req, ctx.res, abs, { download: ctx.query.get('download') === '1' });
  });

  router.get('/api/creator/text/:versionId/:fileId', async (ctx) => {
    const { version, file } = lookupSnapshotFile(app, ctx.params.versionId, ctx.params.fileId);
    return await readTextSample(safeJoin(version.snapshot_dir, file.snapshot_rel));
  });

  /* ---------------------------------------------------------------- devices */

  router.get('/api/devices', () => {
    const devices = store.listDevices(app);
    return {
      devices,
      pending: devices.filter((d) => d.status === 'pending'),
      approved: devices.filter((d) => d.status === 'approved'),
      pairing: listActivePairings(app),
      baseUrl: app.baseUrl,
      primaryIp: primaryLanAddress(),
    };
  });

  router.post('/api/devices/pairing', (ctx) => {
    const role = ctx.body.role === 'receiver' ? 'receiver' : 'reviewer';
    const created = store.createPairingCode(app, {
      role,
      canReceive: !!ctx.body.canReceive || role === 'receiver',
      label: ctx.body.label || '',
    });
    const hash = role === 'receiver' ? '#receiver' : '#reviewer';
    const url = `${app.baseUrl}/pair${hash}&code=${created.code}`;
    return { ...created, url, qrPath: `/api/qr?text=${encodeURIComponent(url)}` };
  });

  router.post('/api/devices/pairing/cancel', (ctx) => {
    const code = String(ctx.body.code || '').toUpperCase();
    const res = app.db.prepare('DELETE FROM pairing_codes WHERE code = ?').run(code);
    return { ok: res.changes > 0 };
  });

  router.get('/api/devices/diagnostics', (ctx) => ({
    port: app.port,
    bind: '0.0.0.0',
    primaryIp: primaryLanAddress(),
    ips: lanAddresses(),
    localUrl: `http://127.0.0.1:${app.port}`,
    lanUrl: app.baseUrl,
    loopback: ctx.loopback,
    selfTest: app.lastSelfTest || null,
    recentFailures: app.recentFailures.slice(-25).reverse(),
    sseClients: app.events.count('creator'),
    platform: process.platform,
    onlineDevices: store.listDevices(app).filter((d) => d.online).length,
    pendingDevices: store.listDevices(app).filter((d) => d.status === 'pending').length,
  }));

  router.post('/api/devices/:id/approve', (ctx) => ({ device: store.approveDevice(app, ctx.params.id, ctx.body || {}) }));
  router.post('/api/devices/:id/revoke', (ctx) => ({ device: store.revokeDevice(app, ctx.params.id) }));
  router.post('/api/devices/:id/forget', (ctx) => store.forgetDevice(app, ctx.params.id));
  router.post('/api/devices/:id/update', (ctx) => {
    app.db
      .prepare(
        `UPDATE devices SET name = COALESCE(NULLIF(?, ''), name),
         receive_root = COALESCE(NULLIF(?, ''), receive_root),
         can_receive = CASE WHEN ? = -1 THEN can_receive ELSE ? END
         WHERE id = ?`,
      )
      .run(
        String(ctx.body.name || ''),
        String(ctx.body.receiveRoot || ''),
        ctx.body.canReceive === undefined ? -1 : ctx.body.canReceive ? 1 : 0,
        ctx.body.canReceive === undefined ? 0 : ctx.body.canReceive ? 1 : 0,
        ctx.params.id,
      );
    return { ok: true, device: store.getDevice(app, ctx.params.id) };
  });

  /* ------------------------------------------------------------- deliveries */

  router.post('/api/versions/:id/deliver', (ctx) =>
    store.createDelivery(app, {
      versionId: ctx.params.id,
      deviceId: ctx.body.deviceId,
      targetDirHint: ctx.body.targetDir,
    }),
  );

  router.get('/api/deliveries', (ctx) => ({
    deliveries: store.listDeliveries(app, {
      projectId: ctx.query.get('projectId') || undefined,
      deviceId: ctx.query.get('deviceId') || undefined,
    }),
  }));

  router.get('/api/deliveries/:id', (ctx) => {
    const dl = store.getDelivery(app, ctx.params.id);
    if (!dl) throw new AppError('delivery_missing', '交付记录不存在', 404);
    return { delivery: dl };
  });

  router.post('/api/deliveries/:id/cancel', (ctx) => ({ delivery: store.cancelDelivery(app, ctx.params.id) }));

  router.post('/api/deliveries/:id/retry', (ctx) => {
    const dl = store.getDelivery(app, ctx.params.id);
    if (!dl) throw new AppError('delivery_missing', '交付记录不存在', 404);
    if (dl.status === 'succeeded') throw new AppError('already_done', '这次交付已经完成，无需重试', 409);
    const device = store.getDevice(app, dl.device_id);
    if (!device || device.status !== 'approved') throw new AppError('device_unapproved', '接收设备尚未授权，请先重新连接并授权', 403);
    store.setDeliveryStatus(app, dl.id, 'queued', { retry: true });
    app.events.publish(`device:${dl.device_id}`, 'delivery.offer', { deliveryId: dl.id });
    return { ok: true, delivery: store.getDelivery(app, dl.id) };
  });

  /* -------------------------------------------------------------------- ui */

  router.get('/api/activity', (ctx) => ({ activity: store.listActivity(app, Number(ctx.query.get('limit') || 60)) }));

  router.get('/api/fs/children', (ctx) => listChildren(ctx.query.get('dir') || os.homedir()));

  router.post('/api/fs/reveal', (ctx) => {
    const target = String(ctx.body.path || '');
    if (!target || !fs.existsSync(target)) throw new AppError('path_missing', '该位置当前不存在', 404);
    return { ok: revealInFileManager(target) };
  });

  router.get('/api/qr', async (ctx) => {
    const text = String(ctx.query.get('text') || '');
    if (!text || text.length > 400) throw new AppError('bad_qr', '二维码内容不合法', 400);
    const { encodeQr, qrToPng } = await import('../lib/qr.js');
    const qr = encodeQr(text);
    if (!qr) throw new AppError('qr_overflow', '内容过长，无法生成二维码', 500);
    const png = qrToPng(qr, { scale: 7, quiet: 3 });
    ctx.res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' });
    ctx.res.end(png);
  });

  router.get('/api/events', (ctx) => {
    app.events.register(ctx.res, { channel: 'creator' });
  });

  /* --------------------------------------------------------- receiver kit */

  router.get('/api/receiver-kit', () => receiverKitInfo());

  router.post('/api/receiver-kit/build', async () => {
    const { buildReceiverKit } = await import('../../packaging/build-receiver-kit.js');
    const info = await buildReceiverKit({ repoRoot: REPO_ROOT });
    return { ok: true, ...info, downloadUrl: '/download/receiver-kit.zip' };
  });

  router.get('/download/receiver-kit.zip', async (ctx) => {
    const info = receiverKitInfo();
    if (!info.available) throw new AppError('kit_missing', '接收端安装包尚未生成，请点击「生成接收端安装包」', 409);
    await sendFile(ctx.req, ctx.res, info.file, { download: true, cacheSeconds: 30 });
  });
}

/* ------------------------------------------------------------------ helpers */

export function receiverKitInfo() {
  const file = path.join(REPO_ROOT, 'dist', 'lanreview-receiver-kit.zip');
  try {
    const stat = fs.statSync(file);
    return { available: true, file, size: stat.size, sizeLabel: formatBytes(stat.size), buildAt: stat.mtime.toISOString() };
  } catch {
    return { available: false, file, sizeLabel: null, buildAt: null };
  }
}

function findProjectByFolder(app, folder) {
  return app.db.prepare('SELECT * FROM projects WHERE folder_path = ?').get(path.resolve(folder));
}

function projectFolder(app, projectId) {
  try {
    return store.getProject(app, projectId).folder_path;
  } catch {
    return app.workspace;
  }
}

function lookupSnapshotFile(app, versionId, fileId) {
  const version = app.db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId);
  if (!version) throw new AppError('version_missing', '版本不存在', 404);
  const file = app.db.prepare('SELECT * FROM version_files WHERE id = ? AND version_id = ?').get(fileId, versionId);
  if (!file) throw new AppError('file_missing', '该文件不在这个版本里', 404);
  return { version, file };
}

function listActivePairings(app) {
  return app.db
    .prepare('SELECT * FROM pairing_codes WHERE consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC')
    .all(nowIso())
    .map((r) => ({ ...r, online: true }));
}
