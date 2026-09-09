import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileKind, previewSupport, extOf, statOrNull } from './util.js';

export const MAX_BROWSE_ENTRIES = 800;
export const MAX_WALK_FILES = 4000;

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.DS_Store', '__MACOSX', '.Trash', '.Spotlight-V100',
  '.fseventsd', '.lanreview', '$RECYCLE.BIN', 'System Volume Information', '.qoder',
]);

export function homeDirs() {
  const home = os.homedir();
  const candidates = [
    ['主目录', home],
    ['桌面', path.join(home, 'Desktop')],
    ['文档', path.join(home, 'Documents')],
    ['下载', path.join(home, 'Downloads')],
    ['影片', path.join(home, 'Movies')],
    ['图片', path.join(home, 'Pictures')],
    ['音乐', path.join(home, 'Music')],
  ];
  if (process.platform === 'win32') {
    candidates.push(['此电脑', 'C:\\']);
  } else {
    candidates.push(['卷宗 /', '/']);
  }
  return candidates.map(([label, p]) => ({ label, path: path.resolve(p) }));
}

export function assertInside(root, target, message = '路径超出允许范围') {
  const r = path.resolve(root);
  const t = path.resolve(target);
  const rel = path.relative(r, t);
  if (rel === '') return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(message);
  return true;
}

export async function listChildren(dir) {
  const abs = path.resolve(dir);
  const stat = await statOrNull(abs);
  if (!stat) throw new Error('文件夹不存在或已被移动');
  if (!stat.isDirectory()) throw new Error('这是一个文件，不是文件夹');
  const names = await fsp.readdir(abs);
  const entries = [];
  for (const name of names.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))) {
    if (name.startsWith('.lanreview')) continue;
    const full = path.join(abs, name);
    const st = await statOrNull(full);
    if (!st) continue;
    entries.push({
      name,
      path: full,
      isDir: st.isDirectory(),
      size: st.isDirectory() ? null : st.size,
      mtimeMs: Math.round(st.mtimeMs),
      kind: st.isDirectory() ? 'dir' : fileKind(name),
      ext: st.isDirectory() ? '' : extOf(name),
      hidden: name.startsWith('.'),
    });
    if (entries.length >= MAX_BROWSE_ENTRIES) break;
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-Hans-CN') : a.isDir ? -1 : 1));
  const parent = path.dirname(abs);
  return {
    dir: abs,
    parent: parent === abs ? null : parent,
    entries,
    truncated: entries.length >= MAX_BROWSE_ENTRIES,
  };
}

/** Recursively collect files under a directory (skips VCS / build noise folders). */
export async function walkFiles(root, { maxFiles = MAX_WALK_FILES } = {}) {
  const out = [];
  const skipped = [];
  async function visit(dir, rel) {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      skipped.push(rel || path.basename(dir));
      return;
    }
    for (const name of names.sort()) {
      if (out.length >= maxFiles) return;
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = await statOrNull(full);
      if (!st) continue;
      if (st.isDirectory()) await visit(full, childRel);
      else if (st.isFile()) out.push({ sourcePath: full, relPath: childRel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    }
  }
  await visit(root, '');
  return { files: out, skippedDirs: skipped, capped: out.length >= maxFiles };
}

export async function fileBrief(sourcePath) {
  const st = await statOrNull(sourcePath);
  if (!st) throw new Error(`文件不存在：${path.basename(sourcePath)}`);
  const name = path.basename(sourcePath);
  const support = previewSupport(name);
  return {
    sourcePath: path.resolve(sourcePath),
    name,
    size: st.size,
    mtimeMs: Math.round(st.mtimeMs),
    kind: fileKind(name),
    ext: extOf(name),
    isDir: st.isDirectory(),
    preview: support.preview,
    previewNote: support.reason,
  };
}

export async function diskFreeBytes(targetPath) {
  const abs = path.resolve(targetPath || os.homedir());
  try {
    if (typeof fs.promises.statfs === 'function') {
      const s = await fs.promises.statfs(abs);
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize, supported: true };
    }
  } catch {
    /* fall through */
  }
  return { free: null, total: null, supported: false };
}

export async function readTextSample(absPath, { maxBytes = 64 * 1024, maxLines = 400 } = {}) {
  const handle = await fsp.open(absPath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    let text = buffer.toString('utf8');
    if (text.includes('\u0000')) return { text: null, truncated: false, binary: true, size };
    if (size > length) text += `\n…（内容较大，仅显示前 ${Math.round(length / 1024)} KB）`;
    const lines = text.split(/\r?\n/);
    if (lines.length > maxLines) return { text: lines.slice(0, maxLines).join('\n'), truncated: true, binary: false, size };
    return { text, truncated: size > length, binary: false, size };
  } finally {
    await handle.close();
  }
}

export function safeJoin(root, rel) {
  const cleaned = String(rel).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..');
  return path.join(path.resolve(root), ...cleaned);
}
