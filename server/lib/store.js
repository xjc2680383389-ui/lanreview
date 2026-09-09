import fsp from 'node:fs/promises';
import path from 'node:path';
import { all, get, run } from './db.js';
import { diskFreeBytes, walkFiles, safeJoin } from './fsx.js';
import {
  AppError, fileKind, formatBytes, hmac, kindLabel, newId, nowIso, pairingCode, previewSupport,
  sanitizeSegment, sha256File, statOrNull, toPosix, uniqueName,
} from './util.js';
import { workspaceSnapshotRoot } from './config.js';

export const ONLINE_WINDOW_MS = 25_000;
export const DELIVERY_STALL_MS = 60_000;

/* ------------------------------------------------------------------ helpers */

export function logActivity(app, kind, message, { projectId = null, versionId = null, deviceId = null, detail = '' } = {}) {
  run(
    app.db,
    'INSERT INTO activity (ts, kind, project_id, version_id, device_id, message, detail) VALUES (?,?,?,?,?,?,?)',
    nowIso(), kind, projectId, versionId, deviceId, message, typeof detail === 'string' ? detail : JSON.stringify(detail),
  );
  app.events.publish('creator', kind, { message, projectId, versionId, deviceId });
}

const log = logActivity;

export function requireWorkspace(app) {
  if (!app.workspace) throw new AppError('workspace_missing', '请先选择工作区', 409);
  return app.workspace;
}

function rowToProject(row) {
  if (!row) return null;
  return { ...row, archived: !!row.archived };
}

/* ---------------------------------------------------------------- projects */

export function previewProjectFolder(app, { date, brand, name }) {
  const ws = requireWorkspace(app);
  const seg = [sanitizeSegment(date, ''), sanitizeSegment(brand, ''), sanitizeSegment(name, '')]
    .filter(Boolean)
    .join('_');
  return path.join(ws, seg || '未命名项目');
}

export async function createProject(app, { date, brand, name, folder: customFolder, forceNewName }) {
  const ws = requireWorkspace(app);
  if (!name || !String(name).trim()) throw new AppError('name_required', '请填写项目名称', 400);
  const wanted = customFolder
    ? path.resolve(customFolder)
    : previewProjectFolder(app, { date, brand, name });
  try {
    safeJoin(ws, wanted);
  } catch {
    throw new AppError('outside_workspace', '项目必须保存在工作区内，请重新选择保存位置', 400);
  }

  const existing = get(app.db, 'SELECT * FROM projects WHERE folder_path = ?', wanted);
  const stat = await statOrNull(wanted);
  if (existing) {
    if (!forceNewName) {
      const err = new AppError('project_exists', '这个位置已经有项目记录了', 409);
      err.detail = { project: rowToProject(existing), folderPath: wanted, reason: 'registered' };
      throw err;
    }
  } else if (stat && stat.isDirectory()) {
    const children = await fsp.readdir(wanted);
    if (children.length > 0 && !forceNewName) {
      const err = new AppError('project_exists', '同名项目文件夹已存在并且里面有文件', 409);
      err.detail = {
        folderPath: wanted,
        reason: 'occupied',
        existingFiles: children.length,
        canReuse: true,
        canRename: true,
      };
      throw err;
    }
  } else if (stat && !stat.isDirectory()) {
    throw new AppError('path_is_file', '目标位置已经有一个同名文件，无法创建项目文件夹', 409);
  }

  let finalPath = wanted;
  if (forceNewName && (existing || (stat && stat.isDirectory()))) {
    finalPath = path.join(ws, uniqueName(path.basename(wanted), new Set([path.basename(wanted), ...listProjectFolders(app)])));
    let guard = 0;
    while ((await statOrNull(finalPath)) && guard++ < 50) {
      finalPath = path.join(ws, uniqueName(path.basename(wanted), new Set([path.basename(finalPath), ...listProjectFolders(app)])));
    }
  }

  await fsp.mkdir(finalPath, { recursive: true });
  const project = {
    id: newId('prj'),
    name: sanitizeSegment(name),
    brand: sanitizeSegment(brand, ''),
    project_date: sanitizeSegment(date, ''),
    folder_path: finalPath,
    created_at: nowIso(),
    updated_at: nowIso(),
    archived: 0,
  };
  run(
    app.db,
    'INSERT INTO projects (id, name, brand, project_date, folder_path, created_at, updated_at, archived) VALUES (?,?,?,?,?,?,?,0)',
    project.id, project.name, project.brand, project.project_date, project.folder_path, project.created_at, project.updated_at,
  );
  await fsp.mkdir(path.join(finalPath, '素材'), { recursive: true }).catch(() => {});
  log(app, 'project.created', `创建项目 ${project.name}`, { projectId: project.id, detail: { folder: finalPath } });
  return rowToProject(project);
}

export async function importExistingProject(app, folderPath) {
  const ws = requireWorkspace(app);
  const abs = path.resolve(folderPath || '');
  try {
    safeJoin(ws, abs);
  } catch {
    throw new AppError('outside_workspace', '只能选择工作区内的项目文件夹', 400);
  }
  const stat = await statOrNull(abs);
  if (!stat || !stat.isDirectory()) throw new AppError('folder_missing', '该文件夹不存在', 404);
  const hit = get(app.db, 'SELECT * FROM projects WHERE folder_path = ?', abs);
  if (hit) return { project: rowToProject(hit), reused: true };
  const base = path.basename(abs);
  const parts = base.split(/[_\s]+/);
  const project = {
    id: newId('prj'),
    name: sanitizeSegment(parts.slice(-2).join(' ') || base),
    brand: sanitizeSegment(parts.length > 2 ? parts[1] : ''),
    project_date: /^\d{4}-?\d{2}-?\d{2}$/.test(parts[0] || '') ? parts[0] : '',
    folder_path: abs,
    created_at: nowIso(),
    updated_at: nowIso(),
    archived: 0,
  };
  run(
    app.db,
    'INSERT INTO projects (id, name, brand, project_date, folder_path, created_at, updated_at, archived) VALUES (?,?,?,?,?,?,?,0)',
    project.id, project.name, project.brand, project.project_date, project.folder_path, project.created_at, project.updated_at,
  );
  log(app, 'project.imported', `导入已有项目 ${project.name}`, { projectId: project.id });
  return { project: rowToProject(project), reused: false };
}

function listProjectFolders(app) {
  return all(app.db, 'SELECT folder_path FROM projects').map((r) => path.basename(r.folder_path));
}

export async function updateProject(app, projectId, patch) {
  const project = get(app.db, 'SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) throw new AppError('project_missing', '项目不存在', 404);
  const name = patch.name !== undefined ? sanitizeSegment(patch.name) : project.name;
  const brand = patch.brand !== undefined ? sanitizeSegment(patch.brand, '') : project.brand;
  const date = patch.date !== undefined ? sanitizeSegment(patch.date, '') : project.project_date;
  run(
    app.db,
    'UPDATE projects SET name = ?, brand = ?, project_date = ?, updated_at = ? WHERE id = ?',
    name, brand, date, nowIso(), projectId,
  );
  log(app, 'project.updated', `更新项目信息 ${name}`, { projectId });
  return rowToProject(get(app.db, 'SELECT * FROM projects WHERE id = ?', projectId));
}

export async function listProjects(app) {
  const rows = all(app.db, 'SELECT * FROM projects ORDER BY updated_at DESC');
  const out = [];
  for (const row of rows) {
    const stat = await statOrNull(row.folder_path);
    const versions = all(app.db, 'SELECT id, code, status, submitted_at FROM versions WHERE project_id = ? ORDER BY submitted_at DESC', row.id);
    const latest = versions[0] || null;
    const openComments = latest
      ? get(app.db, 'SELECT COUNT(*) AS n FROM comments WHERE version_id = ? AND resolved_at IS NULL', latest.id).n
      : 0;
    const deliveries = get(app.db, 'SELECT COUNT(*) AS n FROM deliveries WHERE project_id = ?', row.id).n;
    out.push({
      ...rowToProject(row),
      exists: !!stat && stat.isDirectory(),
      versionCount: versions.length,
      deliveryCount: deliveries,
      latestVersion: latest,
      openComments,
      versions,
    });
  }
  return out;
}

export function getProject(app, projectId) {
  const row = get(app.db, 'SELECT * FROM projects WHERE id = ?', projectId);
  if (!row) throw new AppError('project_missing', '项目不存在', 404);
  return rowToProject(row);
}

/* ------------------------------------------------------------------ drafts */

function ensureDraftTable(app) {
  run(
    app.db,
    `CREATE TABLE IF NOT EXISTS draft_items (
      project_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (project_id, source_path)
    )`,
  );
}

export async function addDraft(app, projectId, { paths = [], dir = null }) {
  ensureDraftTable(app);
  const project = getProject(app, projectId);
  const collected = [];

  const addDir = (abs) => {
    const parent = path.dirname(abs);
    return walkFiles(abs).then((walk) => {
      for (const f of walk.files) {
        collected.push({ sourcePath: f.sourcePath, relPath: toPosix(path.relative(parent, f.sourcePath)) });
      }
    });
  };

  const addFile = (abs) => {
    const relInside = path.relative(project.folder_path, abs);
    const inside = relInside && !relInside.startsWith('..') && !path.isAbsolute(relInside);
    collected.push({ sourcePath: abs, relPath: toPosix(inside ? relInside : path.basename(abs)) });
  };

  if (dir) await addDir(path.resolve(dir));
  for (const p of paths) {
    const abs = path.resolve(p);
    const stat = await statOrNull(abs);
    if (!stat) throw new AppError('source_missing', `找不到 ${path.basename(abs)}`, 400);
    if (stat.isDirectory()) await addDir(abs);
    else addFile(abs);
  }
  let added = 0;
  for (const f of collected) {
    const exists = get(app.db, 'SELECT source_path FROM draft_items WHERE project_id = ? AND source_path = ?', projectId, f.sourcePath);
    if (exists) continue;
    run(
      app.db,
      'INSERT INTO draft_items (project_id, source_path, rel_path, added_at) VALUES (?,?,?,?)',
      projectId, f.sourcePath, f.relPath, nowIso(),
    );
    added += 1;
  }
  const summary = await getDraft(app, projectId);
  log(app, 'draft.updated', `本次待审清单新增 ${added} 个文件（共 ${summary.items.length} 个）`, { projectId });
  return summary;
}

export async function getDraft(app, projectId) {
  ensureDraftTable(app);
  const rows = all(app.db, 'SELECT * FROM draft_items WHERE project_id = ? ORDER BY rel_path', projectId);
  const items = [];
  const problems = [];
  for (const row of rows) {
    const stat = await statOrNull(row.source_path);
    const name = path.basename(row.source_path);
    if (!stat || !stat.isFile()) {
      problems.push({ sourcePath: row.source_path, relPath: row.rel_path, issue: 'missing' });
      items.push({
        sourcePath: row.source_path,
        relPath: row.rel_path,
        name,
        size: null,
        kind: fileKind(name),
        exists: false,
        changed: false,
      });
      continue;
    }
    items.push({
      sourcePath: row.source_path,
      relPath: row.rel_path,
      name,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      kind: fileKind(name),
      exists: true,
      preview: previewSupport(name).preview,
    });
  }
  const totalBytes = items.reduce((sum, i) => sum + (i.size || 0), 0);
  const used = new Set();
  const plan = items.map((i) => {
    const rel = uniqueName(i.relPath, used);
    used.add(rel);
    return { ...i, snapshotName: rel };
  });
  return {
    projectId,
    items: plan,
    problems,
    count: items.length,
    totalBytes,
    totalBytesLabel: formatBytes(totalBytes),
  };
}

export async function removeDraft(app, projectId, { sourcePath, clearAll }) {
  ensureDraftTable(app);
  if (clearAll) run(app.db, 'DELETE FROM draft_items WHERE project_id = ?', projectId);
  else run(app.db, 'DELETE FROM draft_items WHERE project_id = ? AND source_path = ?', projectId, path.resolve(sourcePath));
  return getDraft(app, projectId);
}

/* --------------------------------------------------------------- snapshots */

async function nextVersionCode(app, projectId) {
  const n = get(app.db, 'SELECT COUNT(*) AS n FROM versions WHERE project_id = ?', projectId).n;
  return `V${String(n + 1).padStart(2, '0')}`;
}

export async function submitVersion(app, projectId, { deviceIds = [], note = '' }) {
  const ws = requireWorkspace(app);
  const project = getProject(app, projectId);
  const draft = await getDraft(app, projectId);
  if (!draft.items.length) throw new AppError('nothing_selected', '请先选择要提审的文件', 400);
  const missing = draft.items.filter((i) => !i.exists);
  if (missing.length) {
    const err = new AppError('files_missing', '清单里有文件已经不存在，请先移除或恢复', 409);
    err.detail = { missing: missing.map((m) => m.relPath) };
    throw err;
  }
  const reviewers = deviceIds.map((id) => {
    const d = get(app.db, 'SELECT * FROM devices WHERE id = ?', id);
    if (!d) throw new AppError('device_missing', '所选审核设备不存在', 400);
    if (d.status !== 'approved') throw new AppError('device_unapproved', `设备「${d.name}」尚未获得授权`, 403);
    if (d.role !== 'reviewer' && d.role !== 'both') throw new AppError('device_wrong_role', `设备「${d.name}」不是审核设备`, 400);
    return d;
  });
  if (!reviewers.length) throw new AppError('no_reviewers', '请至少选择一台已授权的审核设备', 400);

  const code = await nextVersionCode(app, projectId);
  const totalBytes = draft.items.reduce((s, i) => s + i.size, 0);
  const free = await diskFreeBytes(ws);
  if (free.supported && free.free < totalBytes + 256 * 1024 * 1024) {
    const err = new AppError('not_enough_space', '工作区所在磁盘空间不足，无法保存这个审核版本', 507);
    err.detail = { need: totalBytes, free: free.free, workspace: ws };
    throw err;
  }

  const snapshotDir = path.join(workspaceSnapshotRoot(ws), project.id, code);
  await fsp.mkdir(snapshotDir, { recursive: true });

  const files = [];
  for (const item of draft.items) {
    const relDisplay = toPosix(item.relPath);
    const snapshotRel = item.snapshotName || relDisplay;
    const target = safeJoin(snapshotDir, snapshotRel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const before = await statOrNull(item.sourcePath);
    if (!before) {
      await cleanupSnapshot(snapshotDir);
      throw new AppError('source_missing', `文件在提交过程中消失了：${item.name}`, 409);
    }
    await fsp.copyFile(item.sourcePath, target);
    const after = await statOrNull(item.sourcePath);
    if (!after) {
      await cleanupSnapshot(snapshotDir);
      throw new AppError('source_missing', `文件在提交过程中消失了：${item.name}`, 409);
    }
    const stat = await fsp.stat(target);
    if (stat.size !== after.size) {
      await cleanupSnapshot(snapshotDir);
      const err = new AppError('file_changed', `文件正在被修改，本次提交已中止：${item.name}`, 409);
      err.detail = { file: item.name, copied: stat.size, source: after.size };
      throw err;
    }
    const sha = await sha256File(target);
    const support = previewSupport(target);
    files.push({
      id: newId('fil'),
      rel_path: relDisplay,
      display_name: path.basename(relDisplay),
      source_path: item.sourcePath,
      snapshot_rel: snapshotRel,
      kind: fileKind(target),
      ext: path.extname(target).toLowerCase().replace(/^\./, ''),
      size: stat.size,
      mtime_ms: Math.round(after.mtimeMs),
      sha256: sha,
      preview: after.size > 512 * 1024 * 1024 ? 'none' : support.preview,
      preview_note: after.size > 512 * 1024 * 1024 ? '文件过大，建议下载后查看' : support.reason || '',
      created_at: nowIso(),
    });
  }

  const versionId = newId('ver');
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  const manifest = {
    format: 'lanreview-snapshot/1',
    generatedAt: nowIso(),
    hostName: app.cfg.hostName,
    project: { id: project.id, name: project.name, brand: project.brand, date: project.project_date, folder: project.folder_path },
    version: { id: versionId, code, note: String(note || '').slice(0, 2000) },
    files: files.map((f) => ({
      relPath: f.rel_path,
      snapshotRel: f.snapshot_rel,
      name: f.display_name,
      size: f.size,
      sha256: f.sha256,
      sourceMtimeMs: f.mtime_ms,
      kind: f.kind,
    })),
    count: files.length,
    totalBytes,
  };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const previous = get(app.db, 'SELECT id FROM versions WHERE project_id = ? ORDER BY submitted_at DESC LIMIT 1', projectId);
  run(
    app.db,
    `INSERT INTO versions (id, project_id, code, note, status, snapshot_dir, manifest_path, created_at, submitted_at, previous_version_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    versionId, projectId, code, manifest.version.note, 'reviewing', snapshotDir, manifestPath, nowIso(), nowIso(), previous?.id || null,
  );
  for (const f of files) {
    run(
      app.db,
      `INSERT INTO version_files (id, version_id, rel_path, display_name, source_path, snapshot_rel, kind, ext, size, mtime_ms, sha256, preview, preview_note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      f.id, versionId, f.rel_path, f.display_name, f.source_path, f.snapshot_rel, f.kind, f.ext, f.size, f.mtime_ms, f.sha256, f.preview, f.preview_note, f.created_at,
    );
  }
  for (const d of reviewers) {
    run(app.db, 'INSERT OR REPLACE INTO assignments (version_id, device_id, assigned_at) VALUES (?,?,?)', versionId, d.id, nowIso());
    app.events.publish(`device:${d.id}`, 'task:new', { versionId, code });
  }
  run(app.db, 'UPDATE projects SET updated_at = ? WHERE id = ?', nowIso(), projectId);
  log(app, 'version.submitted', `提交 ${code} 进行审核（${files.length} 个文件，${formatBytes(totalBytes)}）`, {
    projectId, versionId, detail: { devices: reviewers.map((r) => r.name) },
  });
  return getVersionDetail(app, versionId);
}

async function cleanupSnapshot(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {}
}

/* ---------------------------------------------------------------- versions */

export function listVersions(app, projectId) {
  return all(app.db, 'SELECT * FROM versions WHERE project_id = ? ORDER BY submitted_at DESC', projectId);
}

export function versionSummary(app, versionId) {
  const v = get(app.db, 'SELECT * FROM versions WHERE id = ?', versionId);
  if (!v) throw new AppError('version_missing', '版本不存在', 404);
  const files = all(app.db, 'SELECT * FROM version_files WHERE version_id = ? ORDER BY rel_path', versionId);
  const reviews = all(
    app.db,
    `SELECT r.*, d.name AS device_name FROM reviews r LEFT JOIN devices d ON d.id = r.device_id WHERE r.version_id = ? ORDER BY r.updated_at`,
    versionId,
  );
  const comments = all(
    app.db,
    `SELECT c.*, d.name AS device_name FROM comments c LEFT JOIN devices d ON d.id = c.device_id WHERE c.version_id = ? ORDER BY c.created_at`,
    versionId,
  );
  const assignments = all(
    app.db,
    `SELECT a.*, d.name AS device_name, d.status AS device_status, d.last_seen_at FROM assignments a LEFT JOIN devices d ON d.id = a.device_id WHERE a.version_id = ?`,
    versionId,
  );
  const deliveries = all(
    app.db,
    `SELECT dl.*, d.name AS device_name FROM deliveries dl LEFT JOIN devices d ON d.id = dl.device_id WHERE dl.version_id = ? ORDER BY dl.created_at DESC`,
    versionId,
  );
  const pending = assignments.filter((a) => !reviews.some((r) => r.device_id === a.device_id));
  return {
    ...v,
    files: files.map((f) => ({ ...f, kindLabel: kindLabel(f.kind) })),
    reviews,
    comments: comments.map((c) => ({ ...c, fileLabel: files.find((f) => f.id === c.file_id)?.rel_path || '整体意见' })),
    assignments,
    deliveries,
    stats: {
      fileCount: files.length,
      totalBytes: files.reduce((s, f) => s + f.size, 0),
      commentCount: comments.length,
      openCommentCount: comments.filter((c) => !c.resolved_at).length,
      reviewerCount: assignments.length,
      pendingReviewerCount: pending.length,
      decisions: reviews.map((r) => ({ device: r.device_name, decision: r.decision, at: r.updated_at })),
    },
  };
}

export const getVersionDetail = versionSummary;

export function listProjectVersionCards(app, projectId) {
  return listVersions(app, projectId).map((v) => versionSummary(app, v.id));
}

export async function reassignReviewers(app, versionId, deviceIds) {
  const v = get(app.db, 'SELECT * FROM versions WHERE id = ?', versionId);
  if (!v) throw new AppError('version_missing', '版本不存在', 404);
  if (v.status !== 'reviewing') throw new AppError('version_locked', '该版本已经得出审核结论，请提交新版本', 409);
  const keep = new Set(deviceIds);
  const current = all(app.db, 'SELECT device_id FROM assignments WHERE version_id = ?', versionId).map((r) => r.device_id);
  for (const id of current) if (!keep.has(id)) run(app.db, 'DELETE FROM assignments WHERE version_id = ? AND device_id = ?', versionId, id);
  for (const id of deviceIds) {
    if (current.includes(id)) continue;
    run(app.db, 'INSERT INTO assignments (version_id, device_id, assigned_at) VALUES (?,?,?)', versionId, id, nowIso());
    app.events.publish(`device:${id}`, 'task:new', { versionId, code: v.code });
  }
  log(app, 'version.reassigned', `调整 ${v.code} 的审核设备`, { versionId, projectId: v.project_id });
  return versionSummary(app, versionId);
}

export async function verifyVersionIntegrity(app, versionId, { touchSources = false } = {}) {
  const v = get(app.db, 'SELECT * FROM versions WHERE id = ?', versionId);
  if (!v) throw new AppError('version_missing', '版本不存在', 404);
  const files = all(app.db, 'SELECT * FROM version_files WHERE version_id = ?', versionId);
  const detail = [];
  let ok = true;
  for (const f of files) {
    const abs = safeJoin(v.snapshot_dir, f.snapshot_rel);
    const stat = await statOrNull(abs);
    if (!stat) {
      ok = false;
      detail.push({ file: f.rel_path, issue: 'snapshot_missing' });
      continue;
    }
    if (stat.size !== f.size) {
      ok = false;
      detail.push({ file: f.rel_path, issue: 'size_mismatch', expected: f.size, actual: stat.size });
      continue;
    }
    const sha = await sha256File(abs);
    if (sha !== f.sha256) {
      ok = false;
      detail.push({ file: f.rel_path, issue: 'hash_mismatch', expected: f.sha256.slice(0, 12), actual: sha.slice(0, 12) });
      continue;
    }
    if (touchSources) {
      const src = await statOrNull(f.source_path);
      if (!src) detail.push({ file: f.rel_path, issue: 'source_missing' });
      else if (Math.round(src.mtimeMs) !== f.mtime_ms || src.size !== f.size) detail.push({ file: f.rel_path, issue: 'source_changed' });
    }
  }
  const integrity = ok ? 'ok' : 'broken';
  const changed = detail.filter((d) => d.issue === 'source_changed' || d.issue === 'source_missing').length;
  run(app.db, 'UPDATE versions SET integrity = ?, integrity_detail = ? WHERE id = ?', integrity, JSON.stringify({ detail, sourceChanged: changed }), versionId);
  return { integrity, detail, sourceChanged: changed };
}

/* ----------------------------------------------------------------- devices */

export function deviceIsOnline(device) {
  if (!device?.last_seen_at) return false;
  return Date.now() - Date.parse(device.last_seen_at) < ONLINE_WINDOW_MS;
}

export function listDevices(app) {
  return all(app.db, 'SELECT * FROM devices ORDER BY paired_at DESC').map((d) => ({
    ...d,
    can_receive: !!d.can_receive,
    online: deviceIsOnline(d),
    assignedVersions: all(
      app.db,
      `SELECT v.id, v.code, v.status, a.assigned_at FROM assignments a JOIN versions v ON v.id = a.version_id WHERE a.device_id = ? ORDER BY a.assigned_at DESC`,
      d.id,
    ),
    pendingTasks: get(
      app.db,
      `SELECT COUNT(*) AS n FROM assignments a JOIN versions v ON v.id = a.version_id
       WHERE a.device_id = ? AND v.status = 'reviewing'
         AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.version_id = v.id AND r.device_id = ?)`,
      d.id, d.id,
    ).n,
    lastDelivery: get(app.db, 'SELECT * FROM deliveries WHERE device_id = ? ORDER BY created_at DESC LIMIT 1', d.id) || null,
  }));
}

export function getDevice(app, id) {
  return get(app.db, 'SELECT * FROM devices WHERE id = ?', id) || null;
}

export function createPairingCode(app, { role = 'reviewer', canReceive = false, label = '', ttlMs = 10 * 60_000 } = {}) {
  if (!['reviewer', 'receiver'].includes(role)) throw new AppError('bad_role', '设备用途不正确', 400);
  run(app.db, 'DELETE FROM pairing_codes WHERE expires_at < ?', nowIso());
  const code = unusedPairingCode(app);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  run(
    app.db,
    'INSERT INTO pairing_codes (code, intended_role, intended_can_receive, label, created_at, expires_at) VALUES (?,?,?,?,?,?)',
    code, role, canReceive ? 1 : 0, String(label || '').slice(0, 60), createdAt, expiresAt,
  );
  log(app, 'pairing.created', `生成配对码 ${code}（${role === 'receiver' ? '接收设备' : '审核设备'}）`);
  return { code, role, canReceive: !!canReceive, createdAt, expiresAt };
}

function unusedPairingCode(app) {
  for (let i = 0; i < 40; i++) {
    const candidate = pairingCode();
    if (!get(app.db, 'SELECT code FROM pairing_codes WHERE code = ?', candidate)) return candidate;
  }
  throw new AppError('pairing_busy', '暂时无法生成配对码，请稍后重试', 500);
}


export function redeemPairingCode(app, { code, name, platform, address, port, userAgent, appVersion }) {
  const clean = String(code || '').trim().toUpperCase();
  const row = get(app.db, 'SELECT * FROM pairing_codes WHERE code = ?', clean);
  if (!row) throw new AppError('pairing_invalid', '配对码无效，请让创作者重新生成', 400);
  if (row.consumed_at) throw new AppError('pairing_used', '这个配对码已经被使用', 409);
  if (Date.parse(row.expires_at) < Date.now()) throw new AppError('pairing_expired', '配对码已过期，请让创作者重新生成', 409);
  const deviceId = newId('dev');
  const token = newId('tok') + hmac(app.cfg.hostSecret, deviceId).slice(0, 12);
  run(
    app.db,
    `INSERT INTO devices (id, name, platform, role, token, status, approved_role, can_receive, address, port, user_agent, paired_at, app_version)
     VALUES (?,?,?,?,?, 'pending', '', ?, ?, ?, ?, ?, ?)`,
    deviceId,
    sanitizeSegment(name, platform || '未命名设备').slice(0, 40),
    String(platform || '').slice(0, 40),
    row.intended_role,
    token,
    row.intended_can_receive,
    String(address || ''),
    Number(port || 0),
    String(userAgent || '').slice(0, 200),
    nowIso(),
    String(appVersion || ''),
  );
  run(app.db, 'UPDATE pairing_codes SET consumed_at = ?, device_id = ? WHERE code = ?', nowIso(), deviceId, clean);
  app.events.publish('creator', 'device.pending', { deviceId, name });
  log(app, 'device.pairing', `新设备申请连接：${name || '未命名设备'}（${row.intended_role === 'receiver' ? '接收' : '审核'}）`, { deviceId });
  return { deviceId, token, role: row.intended_role, canReceive: !!row.intended_can_receive, approved: false, hostName: app.cfg.hostName };
}

export function approveDevice(app, deviceId, { role, canReceive, name } = {}) {
  const d = getDevice(app, deviceId);
  if (!d) throw new AppError('device_missing', '设备不存在', 404);
  const finalRole = ['reviewer', 'receiver', 'both'].includes(role) ? role : d.role;
  run(
    app.db,
    `UPDATE devices SET status = 'approved', approved_role = ?, role = ?, can_receive = ?, name = COALESCE(NULLIF(?, ''), name), approved_at = ?, revoked_at = NULL WHERE id = ?`,
    finalRole,
    finalRole === 'receiver' ? 'receiver' : canReceive ? 'both' : finalRole,
    canReceive || finalRole === 'receiver' || finalRole === 'both' ? 1 : 0,
    String(name || ''),
    nowIso(),
    deviceId,
  );
  app.events.publish(`device:${deviceId}`, 'device.approved', { deviceId });
  app.events.publish('creator', 'device.approved', { deviceId });
  log(app, 'device.approved', `授权设备 ${d.name}`, { deviceId });
  return getDevice(app, deviceId);
}

export function revokeDevice(app, deviceId) {
  const d = getDevice(app, deviceId);
  if (!d) throw new AppError('device_missing', '设备不存在', 404);
  run(app.db, "UPDATE devices SET status = 'revoked', revoked_at = ?, can_receive = 0 WHERE id = ?", nowIso(), deviceId);
  app.events.publish(`device:${deviceId}`, 'device.revoked', { deviceId });
  app.events.publish('creator', 'device.revoked', { deviceId });
  log(app, 'device.revoked', `取消授权 ${d.name}`, { deviceId });
  return getDevice(app, deviceId);
}

export function forgetDevice(app, deviceId) {
  const open = get(app.db, "SELECT COUNT(*) AS n FROM deliveries WHERE device_id = ? AND status IN ('queued','transferring','verifying')", deviceId).n;
  if (open) throw new AppError('device_busy', '该设备正在接收文件，请等交付结束后再移除', 409);
  run(app.db, 'DELETE FROM assignments WHERE device_id = ?', deviceId);
  run(app.db, 'DELETE FROM reviews WHERE device_id = ?', deviceId);
  run(app.db, 'DELETE FROM comments WHERE device_id = ?', deviceId);
  run(app.db, 'DELETE FROM devices WHERE id = ?', deviceId);
  log(app, 'device.forgotten', `移除设备记录`, { deviceId });
  return { ok: true };
}

export function touchDevice(app, deviceId, { address, port } = {}) {
  const before = getDevice(app, deviceId);
  const wasOnline = deviceIsOnline(before);
  run(
    app.db,
    'UPDATE devices SET last_seen_at = ?, address = COALESCE(NULLIF(?, \'\'), address), port = COALESCE(NULLIF(?, 0), port) WHERE id = ?',
    nowIso(), String(address || ''), Number(port || 0), deviceId,
  );
  const d = getDevice(app, deviceId);
  if (d && !wasOnline) app.events.publish('creator', 'device.online', { deviceId, name: d.name });
  return d;
}

export function sweepDevicePresence(app) {
  if (!app.onlineDeviceIds) app.onlineDeviceIds = new Set();
  const rows = all(app.db, "SELECT id, name, last_seen_at FROM devices WHERE status = 'approved'");
  const onlineNow = new Set(rows.filter((r) => deviceIsOnline(r)).map((r) => r.id));
  for (const id of app.onlineDeviceIds) {
    if (!onlineNow.has(id)) {
      const row = rows.find((r) => r.id === id);
      app.events.publish('creator', 'device.offline', { deviceId: id, name: row?.name || '' });
    }
  }
  for (const id of onlineNow) {
    if (!app.onlineDeviceIds.has(id)) {
      const row = rows.find((r) => r.id === id);
      app.events.publish('creator', 'device.online', { deviceId: id, name: row?.name || '' });
    }
  }
  app.onlineDeviceIds = onlineNow;
}

/* ---------------------------------------------------------------- feedback */

export function addComment(app, { versionId, deviceId, fileId, body, timecode }) {
  const v = get(app.db, 'SELECT * FROM versions WHERE id = ?', versionId);
  if (!v) throw new AppError('version_missing', '版本不存在', 404);
  const text = String(body || '').trim();
  if (!text) throw new AppError('comment_empty', '请填写意见内容', 400);
  if (text.length > 4000) throw new AppError('comment_too_long', '单条意见请控制在 4000 字以内', 400);
  if (fileId) {
    const f = get(app.db, 'SELECT id FROM version_files WHERE id = ? AND version_id = ?', fileId, versionId);
    if (!f) throw new AppError('file_missing', '评论的文件不在本次版本中', 400);
  }
  let tc = null;
  if (timecode !== undefined && timecode !== null && timecode !== '') {
    const n = Number(timecode);
    if (!Number.isFinite(n) || n < 0) throw new AppError('bad_timecode', '时间码不正确', 400);
    tc = Math.round(n * 100) / 100;
  }
  const id = newId('cmt');
  run(
    app.db,
    'INSERT INTO comments (id, version_id, file_id, device_id, body, timecode, created_at) VALUES (?,?,?,?,?,?,?)',
    id, versionId, fileId || null, deviceId, text, tc, nowIso(),
  );
  const device = getDevice(app, deviceId);
  run(app.db, 'UPDATE projects SET updated_at = ? WHERE id = ?', nowIso(), v.project_id);
  app.events.publish('creator', 'comment.created', { versionId, projectId: v.project_id, fileId, body: text, timecode: tc, device: device?.name });
  log(app, 'comment.created', `${device?.name || '审核者'} 提交了${tc != null ? ` ${v.code} 的时间码` : '一条'}意见`, {
    projectId: v.project_id, versionId, deviceId, detail: text.slice(0, 120),
  });
  return get(app.db, 'SELECT * FROM comments WHERE id = ?', id);
}

export function setCommentResolved(app, { commentId, resolved, deviceId = null }) {
  const c = get(app.db, 'SELECT * FROM comments WHERE id = ?', commentId);
  if (!c) throw new AppError('comment_missing', '意见不存在', 404);
  const v = get(app.db, 'SELECT * FROM versions WHERE id = ?', c.version_id);
  if (deviceId && v.status !== 'reviewing') throw new AppError('version_locked', '该版本已结束审核，无法再改动意见状态', 409);
  run(app.db, 'UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?', resolved ? nowIso() : null, deviceId, commentId);
  app.events.publish('creator', 'comment.resolved', { versionId: c.version_id, commentId, resolved });
  if (deviceId) app.events.publish(`device:${deviceId}`, 'comment.resolved', { commentId, resolved });
  return get(app.db, 'SELECT * FROM comments WHERE id = ?', commentId);
}

export function saveReview(app, { versionId, deviceId, decision, note = '' }) {
  const v = get(app.db, 'SELECT * FROM versions WHERE id = ?', versionId);
  if (!v) throw new AppError('version_missing', '版本不存在', 404);
  if (!['pass', 'changes'].includes(decision)) throw new AppError('bad_decision', '审核结论不正确', 400);
  const assignment = get(app.db, 'SELECT * FROM assignments WHERE version_id = ? AND device_id = ?', versionId, deviceId);
  if (!assignment) throw new AppError('not_assigned', '这个版本没有分配给该设备', 403);
  const existing = get(app.db, 'SELECT * FROM reviews WHERE version_id = ? AND device_id = ?', versionId, deviceId);
  const ts = nowIso();
  if (existing) {
    run(app.db, 'UPDATE reviews SET decision = ?, note = ?, updated_at = ? WHERE id = ?', decision, String(note || '').slice(0, 2000), ts, existing.id);
  } else {
    run(
      app.db,
      'INSERT INTO reviews (id, version_id, device_id, decision, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      newId('rev'), versionId, deviceId, decision, String(note || '').slice(0, 2000), ts, ts,
    );
  }
  const status = recomputeVersionStatus(app, versionId);
  const device = getDevice(app, deviceId);
  app.events.publish('creator', 'decision.created', { versionId, projectId: v.project_id, decision, device: device?.name, status });
  log(app, 'decision.created', `${device?.name || '审核者'} 对 ${v.code} 给出「${decision === 'pass' ? '审核通过' : '需要修改'}」`, {
    projectId: v.project_id, versionId, deviceId,
  });
  return { decision, versionStatus: status, at: ts };
}

export function recomputeVersionStatus(app, versionId) {
  const assignments = all(app.db, 'SELECT device_id FROM assignments WHERE version_id = ?', versionId);
  const reviews = all(app.db, 'SELECT device_id, decision FROM reviews WHERE version_id = ?', versionId);
  let status = 'reviewing';
  if (assignments.length && reviews.length === assignments.length) {
    status = reviews.every((r) => r.decision === 'pass') ? 'approved' : 'changes_requested';
  } else if (reviews.some((r) => r.decision === 'changes')) {
    status = 'changes_requested';
  }
  const current = get(app.db, 'SELECT status, decided_at FROM versions WHERE id = ?', versionId);
  if (current?.status === 'delivered') return current.status;
  run(app.db, 'UPDATE versions SET status = ?, decided_at = ?, delivery_ready_at = ? WHERE id = ?',
    status, status === 'approved' ? nowIso() : null, status === 'approved' ? nowIso() : null, versionId);
  return status;
}

/* -------------------------------------------------------------- deliveries */

export async function createDelivery(app, { versionId, deviceId, targetDirHint }) {
  const v = get(app.db, 'SELECT * FROM versions WHERE id = ?', versionId);
  if (!v) throw new AppError('version_missing', '版本不存在', 404);
  if (!['approved', 'delivered'].includes(v.status)) throw new AppError('not_approved', '只有审核通过的版本才能正式交付', 409);
  const device = getDevice(app, deviceId);
  if (!device) throw new AppError('device_missing', '接收设备不存在', 404);
  if (device.status !== 'approved') throw new AppError('device_unapproved', `设备「${device.name}」尚未授权`, 403);
  if (!device.can_receive && device.role !== 'receiver' && device.role !== 'both') {
    const err = new AppError('device_cannot_receive', `「${device.name}」没有接收文件的能力`, 400);
    err.detail = { hint: '请在设备管理中把该设备的用途设为「接收文件」，或在笔记本上打开接收端程序' };
    throw err;
  }
  const online = deviceIsOnline(device);
  const integrity = await verifyVersionIntegrity(app, versionId, { touchSources: false });
  if (integrity.integrity !== 'ok') {
    const err = new AppError('integrity_broken', '批准版本的文件校验失败，已停止交付', 500);
    err.detail = { integrity: integrity.detail };
    throw err;
  }
  const files = all(app.db, 'SELECT * FROM version_files WHERE version_id = ? ORDER BY rel_path', versionId);
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const deliveryId = newId('dlv');
  const runNo = get(app.db, 'SELECT COUNT(*) AS n FROM deliveries WHERE version_id = ?', versionId).n + 1;
  const defaultTarget = path.join(device.receive_root || path.join(app.workspace, '..', `${app.cfg.hostName}-已接收`), v.code);
  const targetDir = path.resolve(String(targetDirHint || defaultTarget));
  run(
    app.db,
    `INSERT INTO deliveries (id, project_id, version_id, device_id, status, target_dir, total_bytes, file_count, attempts, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', ?,?,?,0,?,?)`,
    deliveryId, v.project_id, versionId, deviceId, targetDir, totalBytes, files.length, nowIso(), nowIso(),
  );
  const manifest = JSON.parse(await fsp.readFile(v.manifest_path, 'utf8'));
  log(app, 'delivery.queued', `安排交付 ${v.code} 给 ${device.name}（第 ${runNo} 次）`, { projectId: v.project_id, versionId, deviceId });
  app.events.publish('creator', 'delivery.updated', { deliveryId, versionId, status: 'queued' });
  app.events.publish(`device:${deviceId}`, 'delivery.offer', { deliveryId, versionCode: v.code });
  return {
    deliveryId,
    versionId,
    versionCode: v.code,
    deviceId,
    deviceName: device.name,
    targetDir,
    totalBytes,
    fileCount: files.length,
    files: files.map((f) => ({
      fileId: f.id,
      relPath: f.rel_path,
      name: f.display_name,
      size: f.size,
      sha256: f.sha256,
      transferName: f.snapshot_rel,
    })),
    manifest,
    runNo,
    hostOnline: online,
  };
}

export function deliveryPayloadForDevice(app, deliveryId) {
  const dl = get(app.db, 'SELECT * FROM deliveries WHERE id = ?', deliveryId);
  if (!dl) return null;
  const v = get(app.db, 'SELECT * FROM versions WHERE id = ?', dl.version_id);
  const project = get(app.db, 'SELECT * FROM projects WHERE id = ?', dl.project_id);
  const files = all(app.db, 'SELECT * FROM version_files WHERE version_id = ? ORDER BY rel_path', dl.version_id);
  return {
    deliveryId,
    status: dl.status,
    targetDir: dl.target_dir,
    totalBytes: dl.total_bytes,
    attempts: dl.attempts,
    createdAt: dl.created_at,
    project: { id: project.id, name: project.name, brand: project.brand, date: project.project_date },
    version: { id: v.id, code: v.code, note: v.note, decidedAt: v.decided_at, approvedAt: v.approved_at || v.decided_at },
    files: files.map((f) => ({
      fileId: f.id,
      relPath: f.rel_path,
      name: f.display_name,
      size: f.size,
      sha256: f.sha256,
      transferName: f.snapshot_rel,
      kind: f.kind,
    })),
  };
}

export function acceptDelivery(app, { deliveryId, deviceId, targetDir, freeBytes }) {
  const dl = get(app.db, 'SELECT * FROM deliveries WHERE id = ?', deliveryId);
  if (!dl) throw new AppError('delivery_missing', '交付任务不存在', 404);
  if (dl.device_id !== deviceId) throw new AppError('delivery_forbidden', '该交付任务不属于此设备', 403);
  const now = nowIso();
  const target = path.resolve(String(targetDir || dl.target_dir));
  if (typeof freeBytes === 'number' && dl.total_bytes > 0 && freeBytes < dl.total_bytes + 64 * 1024 * 1024) {
    failDelivery(app, {
      deliveryId,
      code: 'receiver_no_space',
      message: `接收电脑磁盘空间不足：需要 ${formatBytes(dl.total_bytes + 64 * 1024 * 1024)}，剩余 ${formatBytes(freeBytes)}`,
    });
    throw new AppError('receiver_no_space', '接收电脑磁盘空间不足', 507, { need: dl.total_bytes, free: freeBytes });
  }
  run(
    app.db,
    `UPDATE deliveries SET status = 'transferring', target_dir = ?, accepted_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?, attempts = attempts + 1, error_code = '', error_message = '' WHERE id = ?`,
    target, now, now, now, deliveryId,
  );
  app.events.publish('creator', 'delivery.updated', { deliveryId, status: 'transferring', targetDir: target });
  return get(app.db, 'SELECT * FROM deliveries WHERE id = ?', deliveryId);
}

export function updateDeliveryProgress(app, { deliveryId, deviceId, transferredBytes, okCount, fileId, status }) {
  const dl = get(app.db, 'SELECT * FROM deliveries WHERE id = ?', deliveryId);
  if (!dl) throw new AppError('delivery_missing', '交付任务不存在', 404);
  if (dl.device_id !== deviceId) throw new AppError('delivery_forbidden', '无权更新该交付任务', 403);
  const bytes = Math.max(0, Math.min(Number(transferredBytes) || 0, dl.total_bytes));
  let done = [];
  try {
    done = (JSON.parse(dl.result_json || '{}').items || []).map((i) => i.fileId).filter(Boolean);
  } catch {
    done = [];
  }
  if (fileId && !done.includes(fileId)) done.push(fileId);
  run(
    app.db,
    "UPDATE deliveries SET transferred_bytes = ?, ok_count = ?, status = CASE WHEN status = 'verifying' THEN 'verifying' ELSE 'transferring' END, updated_at = ?, error_code = '', error_message = '', result_json = ? WHERE id = ?",
    bytes,
    Math.max(0, Number(okCount) || done.length),
    nowIso(),
    JSON.stringify({ partialItems: done }),
    deliveryId,
  );
  app.events.publish('creator', 'delivery.progress', { deliveryId, transferredBytes: bytes, totalBytes: dl.total_bytes, okCount: done.length, fileId });
  return get(app.db, 'SELECT * FROM deliveries WHERE id = ?', deliveryId);
}

export function finishDelivery(app, { deliveryId, deviceId, items, failed, errorMessage, errorCode }) {
  const dl = get(app.db, 'SELECT * FROM deliveries WHERE id = ?', deliveryId);
  if (!dl) throw new AppError('delivery_missing', '交付任务不存在', 404);
  if (dl.device_id !== deviceId) throw new AppError('delivery_forbidden', '无权更新该交付任务', 403);
  const v = get(app.db, 'SELECT * FROM versions WHERE id = ?', dl.version_id);
  const files = all(app.db, 'SELECT * FROM version_files WHERE version_id = ?', dl.version_id);
  const byId = new Map(files.map((f) => [f.id, f]));
  const received = Array.isArray(items) ? items : [];
  const problems = [];
  let verifiedBytes = 0;
  for (const r of received) {
    const expected = byId.get(r.fileId);
    if (!expected) {
      problems.push({ fileId: r.fileId, issue: 'unknown_file' });
      continue;
    }
    if (expected.sha256 !== String(r.sha256 || '').toLowerCase()) {
      problems.push({ file: expected.rel_path, issue: 'hash_mismatch', expected: expected.sha256.slice(0, 12), actual: String(r.sha256 || '').slice(0, 12) });
      continue;
    }
    if (Number(r.size) !== expected.size) {
      problems.push({ file: expected.rel_path, issue: 'size_mismatch', expected: expected.size, actual: r.size });
      continue;
    }
    verifiedBytes += expected.size;
  }
  if (received.length !== files.length) problems.push({ issue: 'count_mismatch', expected: files.length, actual: received.length });
  const ok = !problems.length && !failed;
  const now = nowIso();
  const status = ok ? 'succeeded' : 'failed';
  run(
    app.db,
    `UPDATE deliveries SET status = ?, transferred_bytes = ?, ok_count = ?, finished_at = ?, updated_at = ?, result_json = ?,
     error_code = ?, error_message = ? WHERE id = ?`,
    status,
    ok ? dl.total_bytes : verifiedBytes,
    received.length,
    now,
    now,
    JSON.stringify({ items: received, problems, targetDir: dl.target_dir }),
    ok ? '' : String(errorCode || (failed ? 'transfer_failed' : 'verify_failed')),
    ok ? '' : String(errorMessage || (problems[0]?.issue === 'hash_mismatch' ? '文件校验失败，接收端保存的内容与批准版本不一致' : '交付未完成')),
    deliveryId,
  );
  if (ok) run(app.db, "UPDATE versions SET status = 'delivered' WHERE id = ? AND status = 'approved'", dl.version_id);
  run(app.db, 'UPDATE projects SET updated_at = ? WHERE id = ?', now, dl.project_id);
  app.events.publish('creator', 'delivery.updated', { deliveryId, status, ok });
  app.events.publish(`device:${deviceId}`, 'delivery.finished', { deliveryId, status });
  log(app, ok ? 'delivery.succeeded' : 'delivery.failed', ok
    ? `${v.code} 已交付到 ${dl.target_dir}`
    : `${v.code} 交付失败：${errorMessage || problems[0]?.issue || '未知原因'}`, { projectId: dl.project_id, versionId: dl.version_id, deviceId });
  return get(app.db, 'SELECT * FROM deliveries WHERE id = ?', deliveryId);
}

export function failDelivery(app, { deliveryId, code, message }) {
  const now = nowIso();
  run(
    app.db,
    `UPDATE deliveries SET status = 'failed', finished_at = ?, updated_at = ?, error_code = ?, error_message = ? WHERE id = ?`,
    now, now, String(code || 'failed'), String(message || '交付失败'), deliveryId,
  );
  const dl = get(app.db, 'SELECT * FROM deliveries WHERE id = ?', deliveryId);
  if (dl) {
    app.events.publish('creator', 'delivery.updated', { deliveryId, status: 'failed', message });
    app.events.publish(`device:${dl.device_id}`, 'delivery.failed', { deliveryId, message });
    log(app, 'delivery.failed', `交付失败：${message}`, { projectId: dl.project_id, versionId: dl.version_id, deviceId: dl.device_id });
  }
  return dl;
}

export function setDeliveryStatus(app, deliveryId, status, extra = {}) {
  run(app.db, 'UPDATE deliveries SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), deliveryId);
  const dl = get(app.db, 'SELECT * FROM deliveries WHERE id = ?', deliveryId);
  if (dl) {
    app.events.publish('creator', 'delivery.updated', { deliveryId, status, ...extra });
    app.events.publish(`device:${dl.device_id}`, `delivery.${status}`, { deliveryId, ...extra });
  }
  return dl;
}

export function cancelDelivery(app, deliveryId) {
  const dl = get(app.db, 'SELECT * FROM deliveries WHERE id = ?', deliveryId);
  if (!dl) throw new AppError('delivery_missing', '交付任务不存在', 404);
  if (dl.status === 'succeeded') throw new AppError('delivery_done', '该交付已经完成，无法取消', 409);
  const now = nowIso();
  run(app.db, "UPDATE deliveries SET status = 'cancelled', finished_at = ?, updated_at = ?, error_code = 'cancelled', error_message = '创作者已取消本次交付' WHERE id = ?", now, now, deliveryId);
  app.events.publish(`device:${dl.device_id}`, 'delivery.cancelled', { deliveryId });
  app.events.publish('creator', 'delivery.updated', { deliveryId, status: 'cancelled' });
  log(app, 'delivery.cancelled', '取消了一次交付', { projectId: dl.project_id, versionId: dl.version_id, deviceId: dl.device_id });
  return get(app.db, 'SELECT * FROM deliveries WHERE id = ?', deliveryId);
}

export function listDeliveries(app, { projectId, deviceId, versionId, limit = 60 } = {}) {
  const where = [];
  const params = [];
  if (projectId) {
    where.push('dl.project_id = ?');
    params.push(projectId);
  }
  if (deviceId) {
    where.push('dl.device_id = ?');
    params.push(deviceId);
  }
  if (versionId) {
    where.push('dl.version_id = ?');
    params.push(versionId);
  }
  const sql = `SELECT dl.*, v.code AS version_code, p.name AS project_name, d.name AS device_name
    FROM deliveries dl JOIN versions v ON v.id = dl.version_id JOIN projects p ON p.id = dl.project_id LEFT JOIN devices d ON d.id = dl.device_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY dl.created_at DESC LIMIT ${Math.max(1, Math.min(500, limit))}`;
  return all(app.db, sql, ...params).map((r) => ({
    ...r,
    percent: r.total_bytes ? Math.round((r.transferred_bytes / r.total_bytes) * 100) : 0,
    result: safeJson(r.result_json),
  }));
}

export function getDelivery(app, id) {
  const row = get(app.db, `SELECT dl.*, v.code AS version_code, p.name AS project_name, d.name AS device_name, d.address AS device_address, d.port AS device_port, d.last_seen_at, d.status AS device_status, d.receive_root
    FROM deliveries dl JOIN versions v ON v.id = dl.version_id JOIN projects p ON p.id = dl.project_id LEFT JOIN devices d ON d.id = dl.device_id WHERE dl.id = ?`, id);
  if (!row) return null;
  return { ...row, percent: row.total_bytes ? Math.round((row.transferred_bytes / row.total_bytes) * 100) : 0, result: safeJson(row.result_json), deviceOnline: deviceIsOnline({ last_seen_at: row.last_seen_at }) };
}

export function safeJson(text) {
  try {
    return JSON.parse(text || 'null');
  } catch {
    return null;
  }
}

export function listActivity(app, limit = 80) {
  return all(app.db, 'SELECT * FROM activity ORDER BY id DESC LIMIT ?', Math.max(1, Math.min(500, limit)));
}

export function projectStats(app) {
  const versions = all(app.db, 'SELECT status, COUNT(*) AS n FROM versions GROUP BY status');
  const map = Object.fromEntries(versions.map((r) => [r.status, r.n]));
  return {
    projects: get(app.db, 'SELECT COUNT(*) AS n FROM projects').n,
    versions: get(app.db, 'SELECT COUNT(*) AS n FROM versions').n,
    awaitingReview: map.reviewing || 0,
    changesRequested: map.changes_requested || 0,
    approved: (map.approved || 0) + (map.delivered || 0),
    delivered: get(app.db, "SELECT COUNT(*) AS n FROM deliveries WHERE status = 'succeeded'").n,
    devices: all(app.db, 'SELECT * FROM devices').filter(deviceIsOnline).length,
    openComments: get(app.db, 'SELECT COUNT(*) AS n FROM comments WHERE resolved_at IS NULL').n,
    failedDeliveries: get(app.db, "SELECT COUNT(*) AS n FROM deliveries WHERE status = 'failed'").n,
  };
}
