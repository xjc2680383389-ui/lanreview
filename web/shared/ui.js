/**
 * Shared DOM + API helpers for the three interfaces (创作者控制台 / 审核页 / 接收端).
 * No build step, no dependencies: plain ES modules loaded by the pages.
 */

export const BOOT = typeof window !== 'undefined' ? window.__LR_BOOTSTRAP__ || {} : {};

/* --------------------------------------------------------------- formatting */

export function fmtBytes(n) {
  if (n === null || n === undefined) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.max(0, Number(n) || 0);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const pad = (x) => String(x).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function fmtAgo(iso) {
  if (!iso) return '从未';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '-';
  if (diff < 8000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function todayDate() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ------------------------------------------------------------------- dom */

export function h(tag, props = null, ...children) {
  const parts = String(tag).split(/(?=[.#])/);
  const el = document.createElement(parts[0] || 'div');
  if (parts[1] && !parts[1].startsWith('.')) el.id = parts[1].slice(1);
  for (const p of parts.slice(parts[1] && !parts[1].startsWith('.') ? 2 : 1)) {
    if (p.startsWith('.')) el.classList.add(p.slice(1));
    else if (p.startsWith('#')) el.id = p.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  const attrs = props || {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') el.setAttribute('class', String(value));
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'text') el.textContent = String(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(6)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(container, ...nodes) {
  container.textContent = '';
  append(container, nodes);
  return container;
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function debounce(fn, ms = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text));
    return true;
  } catch {
    const ta = h('textarea', { value: String(text), style: { position: 'fixed', left: '-9999px' } });
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/* ------------------------------------------------------------- UI fragments */

export const KIND_LABEL = {
  image: '图',
  video: '视',
  audio: '音',
  pdf: 'PDF',
  sheet: '表',
  slides: '演',
  document: '文',
  text: '文',
  archive: '压',
  font: '字',
  other: '档',
};

export const KIND_NAME = {
  image: '图片',
  video: '视频',
  audio: '音频',
  pdf: 'PDF 文档',
  sheet: '表格',
  slides: '演示文稿',
  document: '文档',
  text: '文本',
  archive: '压缩包',
  font: '字体',
  other: '文件',
};

export function fileIcon(kind, ext) {
  return h('span', { class: `file-icon ${kind || 'other'}`, title: KIND_NAME[kind] || '文件' }, (ext || kind || '?').slice(0, 4));
}

const STATUS_META = {
  reviewing: { label: '审核中', cls: 'pill-brand' },
  approved: { label: '审核通过', cls: 'pill-ok' },
  changes_requested: { label: '需要修改', cls: 'pill-warn' },
  delivered: { label: '已交付', cls: 'pill-ok' },
  queued: { label: '等待接收', cls: 'pill-brand' },
  transferring: { label: '传输中', cls: 'pill-brand' },
  verifying: { label: '校验中', cls: 'pill-brand' },
  succeeded: { label: '交付成功', cls: 'pill-ok' },
  failed: { label: '交付失败', cls: 'pill-danger' },
  stalled: { label: '传输中断', cls: 'pill-warn' },
  cancelled: { label: '已取消', cls: 'pill-outline' },
  pending: { label: '待授权', cls: 'pill-warn' },
  revoked: { label: '已取消授权', cls: 'pill-outline' },
  blocked: { label: '已被拒绝', cls: 'pill-outline' },
  retrying: { label: '正在重试', cls: 'pill-brand' },
  offered: { label: '等待接收', cls: 'pill-brand' },
};

export function statusMeta(status) {
  return STATUS_META[status] || { label: status || '未知', cls: 'pill' };
}

export function statusPill(status) {
  const meta = statusMeta(status);
  return h('span', { class: `pill ${meta.cls}` }, meta.label);
}

export function onlineDot(online) {
  return h('span', { class: `dot ${online ? 'dot-online' : 'dot-offline'}` });
}

export function banner(type, title, ...body) {
  return h('div', { class: `banner banner-${type}` }, h('div', { class: 'banner-body' }, h('div', { class: 'strong' }, title), ...body));
}

export function emptyState(title, hint, action = null) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-title' }, title), hint ? h('div', { class: 'text-sm' }, hint) : null, action ? h('div', { style: { marginTop: '14px' } }, action) : null);
}

export function loading(text = '正在处理…') {
  return h('div', { class: 'loading-block' }, h('span', { class: 'spinner' }), h('span', { class: 'text-sm muted' }, text));
}

export function progressBar(percent, variant = '') {
  return h(
    'div',
    { class: 'progress' },
    h('div', { class: `progress-bar ${variant}`, style: { width: `${Math.max(0, Math.min(100, Math.round(percent || 0)))}%` } }),
  );
}

/* ------------------------------------------------------------------ toast */

let toastWrap = null;
export function toast(message, type = 'info', ms = 4200) {
  if (!toastWrap) {
    toastWrap = h('div', { class: 'toast-wrap' });
    document.body.appendChild(toastWrap);
  }
  const node = h('div', { class: `toast toast-${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}` }, h('div', { class: 'grow' }, String(message)));
  const close = h('button', { class: 'btn btn-ghost btn-sm', style: { color: '#fff', opacity: 0.7 }, onClick: () => node.remove() }, '×');
  node.appendChild(close);
  toastWrap.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 320);
  }, ms);
  return node;
}

/* ------------------------------------------------------------------ modal */

export function modal({ title, body, actions = [], onClose, wide = false, dismissible = true }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible) close();
  };
  const box = h(
    'div',
    { class: `modal${wide ? ' modal-lg' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '对话框' },
    title ? h('div', { class: 'modal-head' }, h('h2', { class: 'grow' }, title), dismissible ? h('button', { class: 'btn btn-ghost btn-icon', onClick: close, 'aria-label': '关闭' }, '×') : null) : null,
    body,
    actions.length ? h('div', { class: 'modal-foot' }, ...actions) : null,
  );
  backdrop.appendChild(box);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && dismissible) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  const focusable = box.querySelector('input, textarea, button.btn-primary');
  if (focusable) setTimeout(() => focusable.focus(), 30);
  return { el: box, close, backdrop };
}

export function confirmDialog({ title, message, confirmText = '确定', cancelText = '返回', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      dialog.close();
    };
    const dialog = modal({
      title,
      body: h('div', { class: 'stack' }, ...[].concat(message).map((m) => (typeof m === 'string' ? h('p', { class: 'muted' }, m) : m))),
      actions: [
        h('button', { class: 'btn', onClick: () => finish(false) }, cancelText),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onClick: () => finish(true) }, confirmText),
      ],
      onClose: () => finish(false),
    });
  });
}

export function promptDialog({ title, label, message, value = '', placeholder = '', confirmText = '确定', multiline = false }) {
  return new Promise((resolve) => {
    let input = null;
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
      dialog.close();
    };
    const body = h('div', { class: 'stack' }, message ? (typeof message === 'string' ? h('p', { class: 'muted' }, message) : message) : null, h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), (input = multiline ? h('textarea', { class: 'textarea', placeholder, value }) : h('input', { class: 'input', placeholder, value }))));
    const dialog = modal({
      title,
      body,
      actions: [h('button', { class: 'btn', onClick: () => finish(null) }, '取消'), h('button', { class: 'btn btn-primary', onClick: () => finish(input.value.trim()) }, confirmText)],
      onClose: () => finish(null),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multiline) {
        e.preventDefault();
        finish(input.value.trim());
      }
    });
  });
}

/* -------------------------------------------------------------------- api */

export class ApiError extends Error {
  constructor(message, { code = 'error', status = 0, detail = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function createApi({ baseUrl = '', token = null, creatorToken = null, label = 'api' } = {}) {
  const headers = () => {
    const out = { 'Content-Type': 'application/json' };
    if (token) out['X-LR-Device-Token'] = token;
    if (creatorToken) out['X-LR-Creator'] = creatorToken;
    return out;
  };
  const setToken = (value) => {
    token = value;
  };
  const setCreatorToken = (value) => {
    creatorToken = value;
  };
  const getToken = () => token;
  const getCreatorToken = () => creatorToken;
  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(baseUrl + path, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw new ApiError('连不上创作者电脑，请确认两台设备在同一个局域网', { code: 'network', status: 0 });
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const err = data?.error || {};
      throw new ApiError(err.message || `${label} 请求失败（${res.status}）`, { code: err.code || 'http_error', status: res.status, detail: err.detail || null });
    }
    return data;
  }
  return {
    get: (path) => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
    setToken,
    getToken,
    setCreatorToken,
    getCreatorToken,
    request,
    headers,
  };
}

/* ---------------------------------------------------------------- sse + poll */

/**
 * Live updates via SSE with an automatic polling fallback, so the UI keeps
 * working even when a browser or proxy kills the event stream.
 */
export function live({ url, onEvent, onPoll, intervalMs = 6000 }) {
  let source = null;
  let stopped = false;
  let timer = null;
  let failures = 0;

  const startPolling = () => {
    if (timer || !onPoll) return;
    timer = setInterval(async () => {
      if (stopped) return;
      try {
        await onPoll();
      } catch {
        /* ignore transient poll errors */
      }
    }, intervalMs);
  };

  const connect = () => {
    if (stopped || typeof EventSource === 'undefined') {
      startPolling();
      return;
    }
    try {
      source = new EventSource(url);
    } catch {
      startPolling();
      return;
    }
    source.onopen = () => {
      failures = 0;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    source.onmessage = (e) => handle(e);
    source.onerror = () => {
      failures += 1;
      try {
        source.close();
      } catch {}
      source = null;
      startPolling();
      if (!stopped && failures < 12) setTimeout(connect, Math.min(15000, 1200 * failures));
    };
  };

  const anyHandlers = new Set();
  function handle(e) {
    let envelope = {};
    try {
      envelope = JSON.parse(e.data);
    } catch {
      envelope = {};
    }
    const kind = envelope.kind || 'message';
    const payload = envelope.data || {};
    if (onEvent) onEvent(kind, payload, envelope.at);
    for (const fn of anyHandlers) fn(kind, payload, envelope.at);
  }

  connect();
  startPolling();

  return {
    onAny(fn) {
      anyHandlers.add(fn);
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      try {
        source?.close();
      } catch {}
    },
  };
}

/* ------------------------------------------------------------ device storage */

export function store(scope) {
  const key = `lanreview:${scope}`;
  return {
    read() {
      try {
        return JSON.parse(localStorage.getItem(key) || 'null');
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* private mode */
      }
    },
    clear() {
      try {
        localStorage.removeItem(key);
      } catch {}
    },
  };
}

export function parseHashParams(hash = location.hash) {
  const out = {};
  const raw = String(hash).replace(/^#/, '');
  for (const part of raw.split('&')) {
    if (!part) continue;
    const [k, v = ''] = part.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

export function deviceNameGuess() {
  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return '安卓手机或平板';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'Mac 电脑';
  if (/Windows/i.test(ua)) return 'Windows 电脑';
  return '这台设备';
}

export function isMobileViewport() {
  return window.matchMedia('(max-width: 760px)').matches;
}

export function setFavicon() {
  if (document.querySelector('link[rel="icon"]')) return;
  document.head.appendChild(h('link', { rel: 'icon', href: '/shared/favicon.svg' }));
}

export function bootstrapHeader({ title, subtitle, right = null, showBack = null }) {
  return h(
    'header',
    { class: 'app-header' },
    showBack ? h('button', { class: 'btn btn-ghost btn-sm', onClick: showBack.onClick }, '← ' + (showBack.label || '返回')) : null,
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'LR'), h('div', {}, h('div', { class: 'truncate' }, title), subtitle ? h('div', { class: 'header-meta' }, subtitle) : null)),
    h('div', { class: 'header-spacer' }),
    right,
  );
}
