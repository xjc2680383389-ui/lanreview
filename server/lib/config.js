import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomHex, writeFileAtomic } from './util.js';

export const DATA_DIR =
  process.env.LANREVIEW_DATA_DIR || path.join(os.homedir(), '.lanreview');
const CONFIG_FILE = path.join(DATA_DIR, 'host.json');
const STATE_FILE = path.join(DATA_DIR, 'running.json');

export const DEFAULT_PORT = Number(process.env.LANREVIEW_PORT || 8780);

let cache = null;

function defaults() {
  return {
    appVersion: 1,
    hostName: os.hostname() || '创作者电脑',
    hostSecret: randomHex(32),
    creatorToken: randomHex(12),
    port: DEFAULT_PORT,
    workspace: null,
    recentWorkspaces: [],
    createdAt: new Date().toISOString(),
  };
}

function normalize(raw) {
  const base = defaults();
  const cfg = { ...base, ...raw };
  if (!cfg.hostSecret) cfg.hostSecret = base.hostSecret;
  if (!cfg.creatorToken) cfg.creatorToken = base.creatorToken;
  if (!Array.isArray(cfg.recentWorkspaces)) cfg.recentWorkspaces = [];
  if (typeof cfg.workspace !== 'string' || !cfg.workspace) cfg.workspace = null;
  return cfg;
}

export async function loadConfig() {
  if (cache) return cache;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
    cache = normalize(raw);
  } catch {
    cache = normalize({});
    await saveConfig(cache);
  }
  return cache;
}

export async function saveConfig(patch) {
  const base = cache || (await loadConfig());
  const next = normalize({ ...base, ...patch });
  cache = next;
  await writeFileAtomic(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

export function configPath() {
  return CONFIG_FILE;
}

export async function writeState(state) {
  await writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2));
}

export function workspaceDirName() {
  return '.lanreview';
}

export function workspaceMetaPath(workspace) {
  return path.join(workspace, workspaceDirName(), 'workspace.json');
}

export function workspaceDbPath(workspace) {
  return path.join(workspace, workspaceDirName(), 'review.db');
}

export function workspaceSnapshotRoot(workspace) {
  return path.join(workspace, workspaceDirName(), 'submissions');
}

export function workspaceTempRoot(workspace) {
  return path.join(workspace, workspaceDirName(), 'tmp');
}

export function isSafeWorkspace(p) {
  if (!p || typeof p !== 'string') return false;
  const abs = path.resolve(p);
  if (abs === path.parse(abs).root) return false;
  const home = path.resolve(os.homedir());
  if (abs === home) return false;
  if (abs === path.resolve(os.rootDir?.() || '/') && process.platform !== 'win32') return false;
  return true;
}

export function fsAccessible(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
