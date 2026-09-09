import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function dataDir() {
  return process.env.LANREVIEW_DATA_DIR || path.join(os.homedir(), '.lanreview');
}

export function creatorToken() {
  return JSON.parse(fs.readFileSync(path.join(dataDir(), 'host.json'), 'utf8')).creatorToken;
}

export function runningState() {
  return JSON.parse(fs.readFileSync(path.join(dataDir(), 'running.json'), 'utf8'));
}

export class Api {
  constructor(baseUrl, { token = null, creator = false, label = 'client' } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.label = label;
    this.creator = creator;
  }

  headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (this.token) h['X-LR-Device-Token'] = this.token;
    if (this.creator) h['X-LR-Creator'] = creatorToken();
    return h;
  }

  async raw(method, urlPath, body, extraHeaders = {}) {
    const res = await fetch(this.baseUrl + urlPath, {
      method,
      headers: this.headers(extraHeaders),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    return { status: res.status, data, headers: res.headers };
  }

  async call(method, urlPath, body, extraHeaders = {}) {
    const { status, data, headers } = await this.raw(method, urlPath, body, extraHeaders);
    if (status >= 400) {
      const err = new Error(
        `${this.label} ${method} ${urlPath} → ${status} ${data?.error?.code || ''} ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`,
      );
      err.status = status;
      err.payload = data;
      throw err;
    }
    return { status, data, headers };
  }

  get(p, extra) {
    return this.call('GET', p, undefined, extra);
  }

  post(p, body) {
    return this.call('POST', p, body ?? {});
  }

  expectFail(method, urlPath, body, wantedStatus) {
    return this.raw(method, urlPath, body).then((r) => {
      if (r.status !== wantedStatus) {
        throw new Error(`${this.label} ${method} ${urlPath} 期望 ${wantedStatus}，实际 ${r.status} (${JSON.stringify(r.data).slice(0, 160)})`);
      }
      return r;
    });
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

export function equals(actual, expected, message) {
  if (actual !== expected) throw new Error(`断言失败：${message}（期望 ${expected}，实际 ${actual}）`);
}

const results = [];
export async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
    return detail;
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: err.message });
    console.log(`  ✗ ${name}\n      ${err.message}`);
    throw err;
  }
}

export function summary(title) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${title}：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log(`  未通过：${f.name} — ${f.error}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

export function resetResults() {
  results.length = 0;
}

export function makeTmpDir(name) {
  const dir = path.join(os.tmpdir(), `lanreview-${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

export function sha256FileSync(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
