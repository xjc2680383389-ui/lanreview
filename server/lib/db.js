import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirp } from './util.js';
import { workspaceDbPath } from './config.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT NOT NULL DEFAULT '',
  project_date TEXT NOT NULL DEFAULT '',
  folder_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_folder ON projects(folder_path);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'reviewing',
  snapshot_dir TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  decided_at TEXT,
  delivery_ready_at TEXT,
  integrity TEXT NOT NULL DEFAULT 'unknown',
  integrity_detail TEXT NOT NULL DEFAULT '',
  previous_version_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_code ON versions(project_id, code);
CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id);

CREATE TABLE IF NOT EXISTS version_files (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  snapshot_rel TEXT NOT NULL,
  kind TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  preview TEXT NOT NULL DEFAULT 'none',
  preview_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_rel ON version_files(version_id, rel_path);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'reviewer',
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_role TEXT NOT NULL DEFAULT '',
  can_receive INTEGER NOT NULL DEFAULT 0,
  receive_root TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT NOT NULL DEFAULT '',
  paired_at TEXT NOT NULL,
  approved_at TEXT,
  revoked_at TEXT,
  last_seen_at TEXT,
  app_version TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token ON devices(token);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  intended_role TEXT NOT NULL DEFAULT 'reviewer',
  intended_can_receive INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  device_id TEXT
);

CREATE TABLE IF NOT EXISTS assignments (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL,
  seen_at TEXT,
  PRIMARY KEY (version_id, device_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES version_files(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  timecode REAL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_version ON comments(version_id);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_pair ON reviews(version_id, device_id);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  target_dir TEXT NOT NULL DEFAULT '',
  total_bytes INTEGER NOT NULL DEFAULT 0,
  transferred_bytes INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  ok_count INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_deliveries_version ON deliveries(version_id);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT,
  version_id TEXT,
  device_id TEXT,
  message TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts DESC);
`;

const opened = new Map();

export function dbPathFor(workspace) {
  return workspaceDbPath(workspace);
}

export function openWorkspaceDb(workspace) {
  const key = path.resolve(workspace);
  if (opened.has(key)) return opened.get(key);
  const file = workspaceDbPath(key);
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const existing = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (!existing) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('workspace_path', key);
  }
  opened.set(key, db);
  return db;
}

export function closeWorkspaceDb(workspace) {
  const key = path.resolve(workspace);
  const db = opened.get(key);
  if (!db) return;
  try {
    db.close();
  } catch {}
  opened.delete(key);
}

export async function ensureWorkspaceDirs(workspace) {
  await mkdirp(path.join(workspace, '.lanreview'));
  await mkdirp(path.join(workspace, '.lanreview', 'submissions'));
  await mkdirp(path.join(workspace, '.lanreview', 'tmp'));
}

export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function get(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}
