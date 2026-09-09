import fs from 'node:fs';
import { AppError, nowIso, previewSupport } from '../lib/util.js';
import { sendFile } from '../lib/http.js';
import { readTextSample, safeJoin } from '../lib/fsx.js';
import { signLink, verifyLink, deviceFromRequest } from '../lib/security.js';
import * as store from '../lib/store.js';

const LINK_TTL_MS = 6 * 60 * 60 * 1000;

export function register(router, app) {
  /* --------------------------------------------------------------- pairing */

  router.post('/api/pair/redeem', (ctx) => {
    const { deviceId, token, role, canReceive, approved, hostName } = store.redeemPairingCode(app, {
      code: ctx.body.code,
      name: ctx.body.name,
      platform: ctx.body.platform,
      address: ctx.ip,
      port: ctx.body.port || 0,
      userAgent: ctx.req.headers['user-agent'],
      appVersion: ctx.body.appVersion,
    });
    return { deviceId, token, role, canReceive, approved, hostName, serverTime: nowIso() };
  });

  /* ------------------------------------------------------------ device core */

  router.post('/api/me/handshake', (ctx) => {
    const device = requireDevice(app, ctx);
    return { ok: true, device: publicDevice(device), host: { name: app.cfg.hostName, appName: app.appName }, serverTime: nowIso() };
  });

  router.post('/api/me/heartbeat', (ctx) => {
    const device = requireDevice(app, ctx, { requireApproved: false });
    const fresh = store.touchDevice(app, device.id, { address: ctx.ip });
    return { ok: true, device: publicDevice(fresh), serverTime: nowIso() };
  });

  router.post('/api/me/name', (ctx) => {
    const device = requireDevice(app, ctx, { requireApproved: false });
    const name = String(ctx.body.name || '').trim().slice(0, 40);
    if (!name) throw new AppError('name_required', '设备名称不能为空', 400);
    app.db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, device.id);
    app.events.publish('creator', 'device.renamed', { deviceId: device.id, name });
    return { device: publicDevice(store.getDevice(app, device.id)) };
  });

  router.get('/api/me/profile', (ctx) => {
    const device = requireDevice(app, ctx, { requireApproved: false });
    return { device: publicDevice(device), host: { name: app.cfg.hostName }, baseUrl: app.baseUrl };
  });

  /* -------------------------------------------------------------- reviewer */

  router.get('/api/me/tasks', (ctx) => {
    const device = requireDevice(app, ctx, { capability: 'review' });
    const rows = app.db
      .prepare(
        `SELECT v.*, p.name AS project_name, p.brand AS project_brand, p.project_date AS project_date, a.assigned_at,
           (SELECT COUNT(*) FROM version_files f WHERE f.version_id = v.id) AS file_count,
           (SELECT COUNT(*) FROM comments c WHERE c.version_id = v.id) AS comment_count,
           (SELECT COUNT(*) FROM comments c WHERE c.version_id = v.id AND c.device_id = ?) AS my_comment_count,
           (SELECT r.decision FROM reviews r WHERE r.version_id = v.id AND r.device_id = ?) AS my_decision,
           (SELECT COUNT(*) FROM reviews r2 WHERE r2.version_id = v.id) AS decision_count
         FROM assignments a
         JOIN versions v ON v.id = a.version_id
         JOIN projects p ON p.id = v.project_id
         WHERE a.device_id = ?
         ORDER BY a.assigned_at DESC`,
      )
      .all(device.id, device.id, device.id);
    return {
      tasks: rows.map((r) => ({
        ...r,
        mine: {
          decision: r.my_decision || null,
          commentCount: r.my_comment_count,
        },
        statusLabel: statusLabel(r.status),
        open: r.status === 'reviewing' && !r.my_decision,
      })),
    };
  });

  router.get('/api/me/versions/:id', (ctx) => {
    const device = requireDevice(app, ctx, { capability: 'review' });
    const versionId = ctx.params.id;
    const assignment = app.db.prepare('SELECT * FROM assignments WHERE version_id = ? AND device_id = ?').get(versionId, device.id);
    if (!assignment) throw new AppError('not_assigned', '这个审核任务不属于当前设备', 403);
    app.db.prepare('UPDATE assignments SET seen_at = COALESCE(seen_at, ?) WHERE version_id = ? AND device_id = ?').run(nowIso(), versionId, device.id);
    const detail = store.versionSummary(app, versionId);
    return {
      version: {
        id: detail.id,
        code: detail.code,
        note: detail.note,
        status: detail.status,
        statusLabel: statusLabel(detail.status),
        submittedAt: detail.submitted_at,
        decidedAt: detail.decided_at,
        previousVersionId: detail.previous_version_id,
        projectName: detail.project_name,
      },
      project: app.db.prepare('SELECT id, name, brand, project_date FROM projects WHERE id = ?').get(detail.project_id),
      files: detail.files.map((f) => fileWithLinks(app, device, detail, f)),
      comments: detail.comments.map((c) => ({
        ...c,
        mine: c.device_id === device.id,
        fileLabel: detail.files.find((f) => f.id === c.file_id)?.rel_path || '整体意见',
      })),
      reviews: detail.reviews.map((r) => ({ ...r, mine: r.device_id === device.id })),
      reviewers: detail.assignments.map((a) => ({ name: a.device_name, decided: detail.reviews.some((r) => r.device_id === a.device_id), decision: detail.reviews.find((r) => r.device_id === a.device_id)?.decision || null })),
      myDecision: detail.reviews.find((r) => r.device_id === device.id) || null,
      locked: detail.status !== 'reviewing',
    };
  });

  router.get('/api/me/media/:versionId/:fileId', async (ctx) => {
    const { version, file, device } = authorizedMedia(app, ctx);
    await sendFile(ctx.req, ctx.res, safeJoin(version.snapshot_dir, file.snapshot_rel), {
      download: ctx.query.get('download') === '1',
      cacheSeconds: 0,
    });
  });

  router.get('/api/me/text/:versionId/:fileId', (ctx) => {
    const { version, file } = authorizedMedia(app, ctx);
    return readTextSample(safeJoin(version.snapshot_dir, file.snapshot_rel));
  });

  router.post('/api/me/comments', (ctx) => {
    const device = requireDevice(app, ctx, { capability: 'review' });
    const comment = store.addComment(app, {
      versionId: ctx.body.versionId,
      deviceId: device.id,
      fileId: ctx.body.fileId || null,
      body: ctx.body.body,
      timecode: ctx.body.timecode,
    });
    const assignment = app.db.prepare('SELECT device_id FROM assignments WHERE version_id = ?').all(comment.version_id);
    for (const a of assignment) app.events.publish(`device:${a.device_id}`, 'comment:created', { versionId: comment.version_id, fileId: comment.file_id });
    return { comment };
  });

  router.post('/api/me/decision', (ctx) => {
    const device = requireDevice(app, ctx, { capability: 'review' });
    const result = store.saveReview(app, {
      versionId: ctx.body.versionId,
      deviceId: device.id,
      decision: ctx.body.decision,
      note: ctx.body.note,
    });
    const peers = app.db.prepare('SELECT device_id FROM assignments WHERE version_id = ?').all(ctx.body.versionId);
    for (const p of peers) app.events.publish(`device:${p.device_id}`, 'decision:updated', { versionId: ctx.body.versionId, status: result.versionStatus });
    return result;
  });

  /* -------------------------------------------------------------- receiver */

  router.get('/api/me/inbox', (ctx) => {
    const device = requireDevice(app, ctx, { capability: 'receive' });
    const rows = app.db
      .prepare(
        `SELECT dl.id FROM deliveries dl WHERE dl.device_id = ? AND dl.status IN ('queued','transferring','verifying') ORDER BY dl.created_at DESC`,
      )
      .all(device.id);
    const offers = rows.map((r) => store.deliveryPayloadForDevice(app, r.id)).filter(Boolean);
    return {
      offers,
      host: { name: app.cfg.hostName, url: app.baseUrl },
      device: publicDevice(store.touchDevice(app, device.id, { address: ctx.ip })),
      serverTime: nowIso(),
    };
  });

  router.post('/api/me/deliveries/:id/accept', (ctx) => {
    const device = requireDevice(app, ctx, { capability: 'receive' });
    const dl = store.acceptDelivery(app, {
      deliveryId: ctx.params.id,
      deviceId: device.id,
      targetDir: ctx.body.targetDir,
      freeBytes: ctx.body.freeBytes,
    });
    const payload = store.deliveryPayloadForDevice(app, ctx.params.id);
    return {
      delivery: dl,
      ...payload,
      files: payload.files.map((f) => ({
        ...f,
        url: transferUrl(app, device, ctx.params.id, f.fileId),
      })),
    };
  });

  router.post('/api/me/deliveries/:id/progress', (ctx) => {
    const device = requireDevice(app, ctx, { capability: 'receive' });
    const dl = store.updateDeliveryProgress(app, {
      deliveryId: ctx.params.id,
      deviceId: device.id,
      transferredBytes: ctx.body.transferredBytes,
      okCount: ctx.body.okCount,
      fileId: ctx.body.fileId,
    });
    return { status: dl.status, updated_at: dl.updated_at };
  });

  router.post('/api/me/deliveries/:id/report', (ctx) => {
    const device = requireDevice(app, ctx, { capability: 'receive' });
    const dl = store.finishDelivery(app, {
      deliveryId: ctx.params.id,
      deviceId: device.id,
      items: ctx.body.items || [],
      failed: !!ctx.body.failed,
      errorMessage: ctx.body.errorMessage,
      errorCode: ctx.body.errorCode,
    });
    return { status: dl.status, error: dl.error_message };
  });

  router.post('/api/me/deliveries/:id/retry', (ctx) => {
    const device = requireDevice(app, ctx, { capability: 'receive' });
    const dl = app.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(ctx.params.id);
    if (!dl) throw new AppError('delivery_missing', '交付任务不存在', 404);
    if (dl.device_id !== device.id) throw new AppError('delivery_forbidden', '该交付任务不属于当前设备', 403);
    if (dl.status === 'succeeded') throw new AppError('already_done', '这次交付已经完成', 409);
    if (dl.status === 'transferring') throw new AppError('already_running', '交付正在进行中', 409);
    store.setDeliveryStatus(app, ctx.params.id, 'queued', { retryByDevice: true });
    return { ok: true, status: 'queued' };
  });

  router.get('/api/me/transfer/:deliveryId/:fileId', async (ctx) => {
    const device = requireDevice(app, ctx, { capability: 'receive' });
    const dl = app.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(ctx.params.deliveryId);
    if (!dl) throw new AppError('delivery_missing', '交付任务不存在', 404);
    if (dl.device_id !== device.id) throw new AppError('delivery_forbidden', '该交付任务不属于当前设备', 403);
    if (dl.status === 'cancelled') throw new AppError('delivery_cancelled', '创作者已取消这次交付', 409);
    const version = app.db.prepare('SELECT * FROM versions WHERE id = ?').get(dl.version_id);
    const file = app.db.prepare('SELECT * FROM version_files WHERE id = ? AND version_id = ?').get(ctx.params.fileId, dl.version_id);
    if (!version || !file) throw new AppError('file_missing', '文件不存在', 404);
    const abs = safeJoin(version.snapshot_dir, file.snapshot_rel);
    if (!fs.existsSync(abs)) throw new AppError('snapshot_missing', '批准版本的文件在工作区中丢失，无法交付', 500);
    await sendFile(ctx.req, ctx.res, abs, { download: true, cacheSeconds: 0 });
  });

  /* ------------------------------------------------------------------- sse */

  router.get('/api/me/events', (ctx) => {
    const device = requireDevice(app, ctx, { requireApproved: false });
    app.events.register(ctx.res, { channel: `device:${device.id}` });
  });
}

/* ------------------------------------------------------------------ helpers */

function requireDevice(app, ctx, opts = {}) {
  return deviceFromRequest(app, ctx.req, opts);
}

function statusLabel(status) {
  return (
    {
      reviewing: '审核中',
      approved: '已通过，待交付',
      changes_requested: '需要修改',
      delivered: '已交付',
    }[status] || status
  );
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    role: device.role,
    status: device.status,
    approved: device.status === 'approved',
    canReceive: !!device.can_receive,
    receiveRoot: device.receive_root || '',
    pairedAt: device.paired_at,
    lastSeenAt: device.last_seen_at,
    online: store.deviceIsOnline(device),
  };
}

function fileWithLinks(app, device, version, f) {
  const support = previewSupport(f.display_name);
  const preview = f.size > 512 * 1024 * 1024 ? 'none' : f.preview || support.preview;
  return {
    id: f.id,
    relPath: f.rel_path,
    name: f.display_name,
    size: f.size,
    kind: f.kind,
    ext: f.ext,
    sha256: f.sha256,
    preview,
    previewNote: f.preview_note || support.reason || '',
    mediaUrl: preview === 'none' ? null : mediaUrl(app, device, version.id, f.id),
    textUrl: f.kind === 'text' || ['csv', 'tsv'].includes(f.ext) ? textUrl(app, device, version.id, f.id) : null,
    downloadUrl: mediaUrl(app, device, version.id, f.id, { download: true }),
  };
}

function mediaParams(app, device, versionId, fileId, download) {
  const link = signLink(app, {
    scope: 'media',
    deviceId: device.id,
    ttlMs: LINK_TTL_MS,
    extra: `${versionId}|${fileId}${download ? '|d' : ''}`,
  });
  const qs = new URLSearchParams({ ...link, v: versionId, f: fileId });
  if (download) qs.set('download', '1');
  return qs.toString();
}

function mediaUrl(app, device, versionId, fileId, { download = false } = {}) {
  return `/api/me/media/${versionId}/${fileId}?${mediaParams(app, device, versionId, fileId, download)}`;
}

function textUrl(app, device, versionId, fileId) {
  return `/api/me/text/${versionId}/${fileId}?${mediaParams(app, device, versionId, fileId, false)}`;
}

function transferUrl(app, device, deliveryId, fileId) {
  return `/api/me/transfer/${deliveryId}/${fileId}`;
}

/**
 * Media access needs a signed link (browsers cannot send headers from <video>/<img>)
 * AND the device must still be assigned to this version.
 */
function authorizedMedia(app, ctx) {
  const versionId = ctx.params.versionId;
  const fileId = ctx.params.fileId;
  const deviceId = ctx.query.get('d');
  if (!deviceId) throw new AppError('device_unpaired', '缺少设备标识，请重新配对', 401);
  const device = app.db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) throw new AppError('device_unpaired', '设备信息无效', 401);
  if (device.status === 'revoked') throw new AppError('device_revoked', '创作者已取消该设备授权', 403);
  const extra = `${versionId}|${fileId}${ctx.query.get('download') === '1' ? '|d' : ''}`;
  if (!verifyLink(app, { scope: 'media', query: ctx.query, deviceId, extra })) {
    throw new AppError('link_invalid', '预览链接无效或已过期，请刷新任务页面', 403);
  }
  const version = app.db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId);
  if (!version) throw new AppError('version_missing', '版本不存在', 404);
  const file = app.db.prepare('SELECT * FROM version_files WHERE id = ? AND version_id = ?').get(fileId, versionId);
  if (!file) throw new AppError('file_missing', '文件不在这个版本中', 404);
  const assigned = app.db.prepare('SELECT device_id FROM assignments WHERE version_id = ? AND device_id = ?').get(versionId, deviceId);
  if (!assigned) throw new AppError('not_assigned', '当前设备没有被分配这个审核任务', 403);
  if (!['reviewer', 'both'].includes(device.role)) throw new AppError('device_wrong_role', '该设备不是审核设备', 403);
  return { version, file, device };
}
