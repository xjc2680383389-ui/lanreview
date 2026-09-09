import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ name, address: a.address, cidr: a.cidr || `${a.address}/32` });
    }
  }
  const score = (a) => {
    if (/^192\.168\./.test(a)) return 0;
    if (/^10\./.test(a)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return 2;
    if (/^169\.254\./.test(a)) return 9;
    return 5;
  };
  return out.sort((x, y) => score(x.address) - score(y.address));
}

export function primaryLanAddress() {
  const list = lanAddresses().filter((a) => !/^169\.254\./.test(a.address));
  return list[0]?.address || null;
}

export function isLoopback(remoteAddress) {
  const ip = String(remoteAddress || '').replace(/^::ffff:/i, '');
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

export function clientAddress(req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/i, '') || 'unknown';
}

export function portIsFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve({ free: false, code: err.code }));
    srv.once('listening', () => {
      srv.close(() => resolve({ free: true }));
    });
    srv.listen(port, host);
  });
}

export async function findFreePort(start, tries = 25) {
  let port = start;
  for (let i = 0; i < tries; i++) {
    const { free } = await portIsFree(port);
    if (free) return port;
    port += 1;
  }
  throw new Error(`找不到可用端口（从 ${start} 开始尝试了 ${tries} 个）`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false, ...opts });
    } catch (err) {
      resolve({ ok: false, error: err.message, code: 'spawn_failed' });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve({ ok: false, error: '选择窗口超时，请重试', code: 'timeout' });
    }, opts.timeout || 120000);
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, code: 'spawn_failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** Open the OS-native folder picker. Returns {ok, path, cancelled, reason}. */
export async function pickFolderNative(initialDir) {
  const platform = process.platform;
  if (platform === 'darwin') {
    const script = `try\n set p to choose folder with prompt "选择文件夹"\n return POSIX path of p\non error errStr number errorNumber\n if errorNumber is -128 then return "__CANCELLED__"\n return "__ERR__" & errStr\nend try`;
    const res = await run('osascript', ['-e', script]);
    if (!res.ok) return { ok: false, cancelled: true, reason: res.error || res.stderr || '系统选择窗口不可用' };
    const out = res.stdout;
    if (out === '__CANCELLED__') return { ok: false, cancelled: true };
    if (out.startsWith('__ERR__')) return { ok: false, cancelled: true, reason: out.slice(7) };
    return { ok: true, path: out.replace(/\/+$/, '') || '/' };
  }
  if (platform === 'win32') {
    const safe = String(initialDir || '').replace(/'/g, "''");
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$f.Description = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("6YCJ5oup5paH5Lu25Zmo5ZKM5Yqg5Y2V5Z2X5oum5oiq5Zu+55qE5paH5Lu25Zmo"))',
      `$f.SelectedPath = '${safe}'`,
      '$r = $f.ShowDialog()',
      'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) } else { [Console]::Out.Write("__CANCELLED__") }',
    ].join('; ');
    const res = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-sta', '-Command', ps], {
      timeout: 180000,
    });
    if (!res.ok) return { ok: false, cancelled: true, reason: res.error || res.stderr || '系统选择窗口不可用' };
    const out = res.stdout.trim().replace(/[\\/]+$/, '');
    if (!out || out === '__CANCELLED__') return { ok: false, cancelled: true };
    return { ok: true, path: out };
  }
  if (platform === 'linux') {
    const args = ['--file-selection', '--directory'];
    if (initialDir) args.push(`--filename=${initialDir}/`);
    const res = await run('zenity', args);
    if (!res.ok) return { ok: false, cancelled: true, reason: res.error || '未检测到 zenity/kdialog，请在页面中手动选择文件夹' };
    const out = res.stdout.trim().replace(/\/+$/, '');
    if (!out) return { ok: false, cancelled: true };
    return { ok: true, path: out };
  }
  return { ok: false, cancelled: true, reason: '当前系统没有原生选择窗口，请使用页面内的文件夹浏览器' };
}

export function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    else if (platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsVerbatimArguments: true }).unref();
    else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

export function revealInFileManager(absPath) {
  try {
    if (process.platform === 'darwin') spawn('open', [absPath], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'win32') spawn('explorer.exe', [`/select,${absPath}`], { stdio: 'ignore', detached: true }).unref();
    else spawn('xdg-open', [fs.existsSync(absPath) ? absPath : path.dirname(absPath)], { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}
