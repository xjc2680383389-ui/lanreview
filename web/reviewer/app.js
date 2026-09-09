/* ============================================================================
 * 局域网提审 · 审核端（手机 / 平板 / 笔记本浏览器）
 *
 * 单页应用，零构建零依赖：只用 web/shared/ui.js 的 helper，只调用
 *   POST /api/pair/redeem      配对
 *   GET  /api/info             创作者电脑主机名
 *   GET  /api/me/profile       这台设备的状态
 *   POST /api/me/heartbeat     心跳 / 等待授权
 *   GET  /api/me/tasks         我的审核任务
 *   GET  /api/me/versions/:id  版本详情（文件 / 评论 / 结论 / 审核人）
 *   POST /api/me/comments      提交意见（可带时间码）
 *   POST /api/me/decision      提交结论
 *   /api/me/media、/api/me/text 预览与下载：只用服务端下发的签名链接，不自己拼
 *   GET  /api/me/events?t=     SSE 实时事件（live() 自带轮询兜底）
 * ==========================================================================*/

import {
  ApiError,
  BOOT,
  KIND_NAME,
  banner,
  bootstrapHeader,
  confirmDialog,
  createApi,
  debounce,
  deviceNameGuess,
  emptyState,
  fileIcon,
  fmtAgo,
  fmtBytes,
  fmtClock,
  fmtTime,
  h,
  live,
  loading,
  modal,
  mount,
  parseHashParams,
  progressBar,
  qs,
  qsa,
  setFavicon,
  statusMeta,
  store,
  toast,
} from '/shared/ui.js';

/* ============================================================== 1. 小工具 */

const DECISION_TEXT = { pass: '已通过', changes: '需要修改' };
const PENDING_POLL_MS = 3000; // 等待授权时问得密一点
const ONLINE_POLL_MS = 10000; // 服务端认为「在线」的窗口是 25 秒

function decisionText(d) {
  return d === 'pass' ? '已通过' : d === 'changes' ? '需要修改' : '还没看';
}

function setBusy(btn, on, text = '正在处理…') {
  if (!btn) return;
  if (on) {
    if (!btn.dataset.orig) btn.dataset.orig = btn.textContent || '';
    btn.disabled = true;
    btn.textContent = text;
  } else {
    btn.disabled = false;
    if (btn.dataset.orig) btn.textContent = btn.dataset.orig;
  }
}

function statusPillFor(status, label) {
  const meta = statusMeta(status);
  return h('span', { class: `pill ${meta.cls}` }, label || meta.label);
}

/** 支持 12、0:12、1:02:03；空 → null，非法 → NaN */
function parseTimecode(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map((p) => p.trim());
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  const n = parts.map(Number);
  return n.length === 3 ? n[0] * 3600 + n[1] * 60 + n[2] : n[0] * 60 + n[1];
}

function viewerKind(f) {
  if (f.textUrl) return 'text'; // csv / md / json / txt 一律读文本样本
  if (f.preview === 'none') return 'none';
  if (f.preview === 'maybe') return 'maybe';
  if (f.kind === 'image') return 'image';
  if (f.kind === 'video') return 'video';
  if (f.kind === 'audio') return 'audio';
  if (f.kind === 'pdf') return 'pdf';
  return 'none';
}

function isMediaFile(f) {
  const k = viewerKind(f);
  return k === 'video' || k === 'audio' || (k === 'maybe' && (f.kind === 'video' || f.kind === 'audio'));
}

function previewInfo(f) {
  if (f.textUrl) return { text: '文本预览', cls: 'chip chip-ok' };
  if (f.preview === 'inline') return { text: '可直接预览', cls: 'chip chip-ok' };
  if (f.preview === 'maybe') return { text: '浏览器可能播不了', cls: 'chip chip-warn' };
  return { text: '不能预览，可下载', cls: 'chip chip-warn' };
}

function downloadLink(f, opts = {}) {
  return h(
    'a',
    {
      class: opts.class || 'btn btn-sm',
      href: f.downloadUrl,
      download: f.name,
      target: '_blank',
      rel: 'noopener',
      onClick: opts.onStop ? (e) => e.stopPropagation() : null,
    },
    opts.text || '下载',
  );
}

function initials(name) {
  const s = String(name || '审').trim();
  return s ? s.slice(0, 1).toUpperCase() : '审';
}

function platformLabel() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone/iPad 浏览器';
  if (/Android/i.test(ua)) return 'Android 浏览器';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS 浏览器';
  if (/Windows/i.test(ua)) return 'Windows 浏览器';
  return '网页浏览器';
}

function isEditing(host) {
  const a = document.activeElement;
  if (!a) return false;
  if (a.tagName !== 'TEXTAREA' && a.tagName !== 'INPUT') return false;
  return !!(host && host.contains && host.contains(a));
}

/* ================================================================= 2. 状态 */

const tokenStore = store('reviewer');

function readSession() {
  const raw = tokenStore.read();
  if (!raw || typeof raw !== 'object' || typeof raw.token !== 'string' || !raw.token) return null;
  return {
    token: raw.token,
    deviceId: String(raw.deviceId || ''),
    name: String(raw.name || '这台设备'),
    role: String(raw.role || 'reviewer'),
    canReceive: !!raw.canReceive,
    hostName: String(raw.hostName || ''),
    approved: raw.approved === true,
    status: String(raw.status || 'pending'),
    pairedAt: String(raw.pairedAt || ''),
  };
}

const state = {
  session: readSession(),
  device: null,
  hostName: BOOT.hostName || '',
  net: { ok: true, error: '', failures: 0, retryAt: 0, lastOkAt: 0 },
  softNote: '', // 不致命但用户必须知道的返回信息（比如还没选工作区）
  pairNotice: '',
  tab: 'files',
  lastDecision: null, // { versionId, text }
  pendingSeek: null, // { versionId, fileId, t }
  details: new Map(),
};

const api = createApi({ token: state.session ? state.session.token : null, label: '审核端' });

function saveSession(patch) {
  if (!state.session) return;
  state.session = { ...state.session, ...patch };
  tokenStore.write(state.session);
}

function clearSession() {
  tokenStore.clear();
  state.session = null;
  state.device = null;
  state.details.clear();
  state.softNote = '';
  api.setToken(null);
  stopLive();
  stopBeat();
  if (location.hash !== tasksHash()) history.replaceState(null, '', location.pathname + location.search + tasksHash());
}

function phase() {
  const s = state.session;
  if (!s || !s.token) return 'pairing';
  if (s.status === 'revoked') return 'revoked';
  if (s.role && !['reviewer', 'both'].includes(s.role)) return 'wrongrole';
  if (!s.approved) return 'waiting';
  return 'ready';
}

/* =============================================== 3. 连接状态 / 心跳 / 实时事件 */

const netEl = h('div', { class: 'rv-net hidden' });
let netCountdownSpan = null;

function renderNet() {
  if (state.net.ok) {
    netEl.classList.add('hidden');
    mount(netEl);
    netCountdownSpan = null;
    return;
  }
  netEl.classList.remove('hidden');
  netCountdownSpan = h('span', { class: 'nowrap text-sm' }, '');
  mount(
    netEl,
    banner(
      'warn',
      '与创作者电脑的连接中断，正在重试…',
      h(
        'div',
        { class: 'row row-wrap gap-sm', style: { marginTop: '4px' } },
        h('span', { class: 'text-sm' }, state.net.error || '请确认两台设备连的是同一个 Wi-Fi'),
        netCountdownSpan,
        h('button', { class: 'btn btn-sm', onClick: () => beatNow() }, '立即重试'),
      ),
    ),
  );
  tickNet();
}

function tickNet() {
  if (state.net.ok || !netCountdownSpan) return;
  if (!state.session || !state.session.token) {
    netCountdownSpan.textContent = '（检查网络后重新点「连接并开始审核」）';
    return;
  }
  const left = Math.max(0, Math.ceil((state.net.retryAt - Date.now()) / 1000));
  netCountdownSpan.textContent = `${left} 秒后自动重试`;
}

function markOffline(message) {
  const firstFail = state.net.ok;
  state.net.ok = false;
  state.net.failures += 1;
  state.net.error = message || '连不上创作者电脑';
  if (firstFail) toast('连不上创作者电脑，正在自动重试', 'error');
  renderNet();
  scheduleBeat();
}

function markOnline() {
  const recovered = !state.net.ok;
  state.net.ok = true;
  state.net.failures = 0;
  state.net.error = '';
  state.net.lastOkAt = Date.now();
  renderNet();
  if (recovered) {
    toast('已重新连上创作者电脑', 'success');
    refreshQuiet();
  }
}

/** 把 ApiError 归类，并做出全局反应；把归类结果交回调用方决定怎么显示 */
function classify(err) {
  if (!(err instanceof ApiError)) {
    console.error(err);
    markOffline('页面出现了意外错误，正在重试');
    return { kind: 'offline', message: '页面出现了意外错误，正在重试' };
  }
  if (err.code === 'network' || (!err.status && err.code === 'error')) {
    markOffline(err.message);
    return { kind: 'offline', message: err.message };
  }
  if (err.code === 'device_unpaired') {
    state.pairNotice = err.message || '这台设备的配对信息已失效，请重新扫码连接';
    clearSession();
    mountCurrent({ force: true });
    return { kind: 'unpaired', message: err.message };
  }
  if (err.code === 'device_revoked') {
    markRevoked(err.message);
    return { kind: 'revoked', message: err.message };
  }
  if (err.code === 'device_pending') {
    if (state.session && state.session.approved) {
      saveSession({ approved: false, status: 'pending' });
      mountCurrent({ force: true });
    }
    return { kind: 'pending', message: err.message };
  }
  if (err.code === 'workspace_missing') {
    state.softNote = err.message;
    if (screen && screen.name === 'waiting') screen.apply({ quiet: true });
    return { kind: 'soft', message: err.message };
  }
  if (err.code === 'device_wrong_role') return { kind: 'fatal', message: err.message };
  return { kind: 'error', message: err.message || '这个操作没有成功' };
}

function markRevoked(message) {
  saveSession({ status: 'revoked', approved: false });
  state.softNote = message || '创作者已取消本设备授权';
  stopLive();
  mountCurrent({ force: true });
}

let beatTimer = null;

function beatDelay() {
  if (!state.net.ok) return PENDING_POLL_MS;
  return state.session && state.session.approved ? ONLINE_POLL_MS : PENDING_POLL_MS;
}

function scheduleBeat(delayMs) {
  clearTimeout(beatTimer);
  if (!state.session || !state.session.token) return; // 还没配对，没有心跳可发
  const ms = delayMs === undefined ? beatDelay() : delayMs;
  state.net.retryAt = Date.now() + ms;
  beatTimer = setTimeout(async () => {
    await beat();
    scheduleBeat();
  }, ms);
}

function stopBeat() {
  clearTimeout(beatTimer);
  beatTimer = null;
}

function beatNow() {
  beat().then(() => scheduleBeat());
}

async function beat() {
  if (!state.session || !state.session.token) return;
  try {
    const res = await api.post('/api/me/heartbeat', {});
    markOnline();
    state.softNote = '';
    const dev = res.device || {};
    state.device = dev;
    if (dev.status === 'revoked') {
      markRevoked('创作者已取消本设备授权');
      return;
    }
    const wasApproved = !!state.session.approved;
    saveSession({
      approved: !!dev.approved,
      status: dev.status || state.session.status,
      name: dev.name || state.session.name,
      role: dev.role || state.session.role,
    });
    if (!wasApproved && dev.approved) {
      toast('创作者已允许这台设备，开始审核', 'success');
      startLive();
      mountCurrent({ force: true });
    } else if (wasApproved && !dev.approved) {
      mountCurrent({ force: true });
    } else if (screen && screen.name === 'waiting') {
      screen.apply({ quiet: true });
    }
  } catch (err) {
    classify(err);
  }
}

let liveHandle = null;

function stopLive() {
  try {
    if (liveHandle) liveHandle.stop();
  } catch {
    /* 忽略 */
  }
  liveHandle = null;
}

function startLive() {
  stopLive();
  if (!state.session || !state.session.token) return;
  liveHandle = live({
    url: `/api/me/events?t=${encodeURIComponent(state.session.token)}`,
    intervalMs: 12000,
    onEvent: (kind) => {
      if (kind === 'device.approved') {
        beatNow();
        return;
      }
      if (kind === 'device.revoked') {
        markRevoked('创作者已取消本设备授权');
        return;
      }
      if (kind === 'task:new' || kind === 'decision:updated' || kind === 'comment:created' || kind === 'comment.resolved') refreshQuiet();
    },
    onPoll: async () => {
      if (!state.session) return;
      await beat();
      if (state.session.approved) refreshQuiet();
    },
  });
}

const refreshQuiet = debounce(() => {
  if (screen && typeof screen.apply === 'function') screen.apply({ quiet: true });
}, 500);

/* =================================================================== 4. 路由 */

function routeFromHash() {
  const p = parseHashParams();
  const versionId = p.task ? String(p.task) : null;
  const fileId = p.file ? String(p.file) : null;
  return {
    name: versionId ? 'version' : 'tasks',
    versionId,
    fileId,
    code: p.code ? String(p.code).toUpperCase() : '',
  };
}

const tasksHash = () => '#reviewer';
const versionHash = (vid) => `#reviewer&task=${encodeURIComponent(vid)}`;
const fileHash = (vid, fid) => `#reviewer&task=${encodeURIComponent(vid)}&file=${encodeURIComponent(fid)}`;

function go(hash) {
  if (location.hash === hash) mountCurrent({ force: true });
  else location.hash = hash;
}

let screen = null;
let mountSeq = 0;

async function mountCurrent({ force = false } = {}) {
  const seq = ++mountSeq;
  qsa('.rv-bar').forEach((n) => n.remove());
  document.body.classList.remove('rv-bar-open');
  const ph = phase();
  const r = routeFromHash();
  if (ph === 'ready' && r.code) history.replaceState(null, '', location.pathname + location.search + tasksHash());
  const key = `${ph}|${r.name}|${r.versionId || ''}|${r.fileId || ''}`;
  if (!force && screen && screen.key === key) {
    await screen.apply({ quiet: true });
    return;
  }
  const ok = () => seq === mountSeq;
  const built =
    ph === 'pairing'
      ? screenPairing(r.code, ok)
      : ph === 'waiting'
        ? screenWaiting(ok)
        : ph === 'revoked'
          ? screenRevoked()
          : ph === 'wrongrole'
            ? screenWrongRole()
            : r.name === 'version' && r.fileId
              ? screenViewer(r.versionId, r.fileId, ok)
              : r.name === 'version'
                ? screenVersion(r.versionId, ok)
                : screenTasks(ok);
  screen = { key, ...built };
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------ 页面外框/通用件 */

function shell(title, subtitle, { back, right, bar } = {}) {
  const root = qs('#app');
  root.textContent = '';
  const page = h('main', { class: 'rv-page' + (bar ? ' rv-page-with-bar' : '') });
  root.append(
    bootstrapHeader({
      title,
      subtitle,
      right: right || null,
      showBack: back ? { label: back.label || '返回', onClick: back.onClick } : null,
    }),
    netEl,
    page,
  );
  document.title = `${title} · 局域网提审`;
  if (bar) {
    const host = h('div', { class: 'rv-bar' }, h('div', { class: 'rv-bar-inner' }, bar));
    document.body.appendChild(host);
    document.body.classList.add('rv-bar-open');
  }
  return page;
}

function headerRight() {
  return h(
    'div',
    { class: 'row gap-sm' },
    h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { beatNow(); mountCurrent({ force: true }); } }, '刷新'),
    h('button', { class: 'btn btn-ghost btn-sm truncate', style: { maxWidth: '92px' }, onClick: openDeviceModal }, state.session ? state.session.name : '未连接'),
  );
}

function errorCard(message, retry, opts = {}) {
  return h(
    'div',
    { class: 'card stack' },
    banner('error', opts.title || '这个操作没有成功', h('div', { class: 'text-sm' }, message || '未知错误')),
    h(
      'div',
      { class: 'row row-wrap' },
      retry ? h('button', { class: 'btn btn-primary', onClick: () => retry() }, '再试一次') : null,
      h('button', { class: 'btn', onClick: () => openDeviceModal() }, '检查这台设备的连接'),
    ),
  );
}

function openDeviceModal() {
  const s = state.session;
  const d = state.device;
  const body = h(
    'div',
    { class: 'stack' },
    h(
      'dl',
      { class: 'kv' },
      h('dt', {}, '这台设备'),
      h('dd', {}, s ? s.name : '未配对'),
      h('dt', {}, '创作者电脑'),
      h('dd', {}, state.hostName || (s ? s.hostName : '') || '未知'),
      h('dt', {}, '角色'),
      h('dd', {}, s ? (s.role === 'receiver' ? '接收端' : s.role === 'both' ? '审核 + 接收' : '审核设备') : '-'),
      h('dt', {}, '授权状态'),
      h('dd', {}, s ? (s.status === 'revoked' ? '已被取消' : s.approved ? '已允许' : '等待创作者点允许') : '-'),
      h('dt', {}, '配对时间'),
      h('dd', {}, s && s.pairedAt ? `${fmtTime(s.pairedAt)}（${fmtAgo(s.pairedAt)}）` : '-'),
      h('dt', {}, '最近一次通信'),
      h('dd', {}, d && d.lastSeenAt ? fmtAgo(d.lastSeenAt) : state.net.ok ? '刚刚' : '连接中断'),
    ),
    state.net.ok
      ? banner('success', '与创作者电脑连接正常', h('div', { class: 'text-sm' }, '这个页面只在局域网里工作；换到别的 Wi-Fi 或关掉创作者电脑就会断线。'))
      : banner('error', '连接中断', h('div', { class: 'text-sm' }, state.net.error)),
    h('div', { class: 'text-sm muted' }, '要换手机、或者要连另一台创作者电脑时，先取消配对，再扫新的配对码。'),
  );
  modal({
    title: '这台设备的连接信息',
    body,
    actions: [
      h(
        'button',
        {
          class: 'btn',
          onClick: (e) => {
            setBusy(e.currentTarget, true, '正在检查…');
            beat().then(() => {
              setBusy(e.currentTarget, false);
              mountCurrent({ force: true });
              toast(state.session && state.session.approved ? '已授权，可以审核' : '创作者还没有点允许', 'info');
            });
          },
        },
        '立即检查授权',
      ),
      h(
        'button',
        {
          class: 'btn btn-danger',
          onClick: async (e) => {
            const btn = e.currentTarget;
            const sure = await confirmDialog({
              title: '取消这台设备的配对？',
              message: ['取消后需要重新扫码或输入配对码才能继续审核。', '已经提交的意见和结论仍会保留在创作者电脑上。'],
              confirmText: '确定取消配对',
              cancelText: '继续审核',
              danger: true,
            });
            if (!sure) return;
            setBusy(btn, true, '正在取消…');
            state.pairNotice = '';
            clearSession();
            mountCurrent({ force: true });
            toast('已取消配对', 'info');
          },
        },
        '取消配对',
      ),
    ],
  });
}

/* ================================================================ 5. 配对页 */

function screenPairing(code, ok) {
  const content = shell('手机审核页', state.hostName ? `创作者电脑：${state.hostName}` : '局域网提审与交付');
  const notice = state.pairNotice;
  state.pairNotice = '';
  const errorHost = h('div', {});

  const codeInput = h('input', {
    class: 'input input-mono rv-code',
    value: code || '',
    placeholder: 'XXXXXX',
    maxlength: '6',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    inputmode: 'text',
    'aria-label': '配对码',
  });
  const nameInput = h('input', {
    class: 'input',
    value: deviceNameGuess(),
    maxlength: '24',
    placeholder: '例如：小林的 iPhone',
    'aria-label': '这台设备的名字',
  });
  const submitBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button' }, '连接并开始审核');

  content.append(
    h(
      'div',
      { class: 'card rv-hero stack', style: { marginBottom: '16px' } },
      h('h1', {}, '在这里审核创作者提交的版本'),
      h(
        'div',
        { class: 'text-sm muted' },
        state.hostName ? `你要连接的是「${state.hostName}」这台创作者电脑。` : '正在识别创作者电脑…',
      ),
    ),
    errorHost,
    h(
      'div',
      { class: 'card stack' },
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label' }, '配对码'),
        codeInput,
        h('span', { class: 'field-hint' }, code ? '已经从二维码里自动填好了，直接点连接即可。' : '创作者在「设备」页生成配对码：6 位字母数字，10 分钟内有效。'),
      ),
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label' }, '这台设备叫'),
        nameInput,
        h('span', { class: 'field-hint' }, '创作者在授权列表里看到的就是这个名字，改成你自己认得出的更好。'),
      ),
      submitBtn,
    ),
    h(
      'div',
      { class: 'card card-flat', style: { marginTop: '16px' } },
      h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, '接下来会发生什么')),
      h(
        'div',
        { class: 'steps' },
        ...[
          ['1', '点上面的「连接并开始审核」', '手机向创作者电脑申请配对，配对码必须正确且没被用过。'],
          ['2', '创作者在他的电脑上点「允许」', '这个页面会自己跳到任务列表，不用你反复刷新。'],
          ['3', '看文件、写意见、给结论', '所有内容只存在局域网内的创作者电脑上，不经过外网。'],
        ].map((row) =>
          h(
            'div',
            { class: 'step' },
            h('div', { class: 'step-index' }, row[0]),
            h('div', { class: 'grow' }, h('div', { class: 'strong' }, row[1]), h('div', { class: 'text-sm muted' }, row[2])),
          ),
        ),
      ),
    ),
  );

  if (notice) mount(errorHost, banner('warn', '需要重新连接', h('div', { class: 'text-sm' }, notice)));
  if (state.softNote) mount(errorHost, banner('warn', '创作者那边还没准备好', h('div', { class: 'text-sm' }, state.softNote)));

  async function connect() {
    const clean = String(codeInput.value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const name = String(nameInput.value || '').trim() || deviceNameGuess();
    codeInput.value = clean;
    if (clean.length !== 6) {
      mount(
        errorHost,
        banner('warn', '配对码是 6 位字母数字', h('div', { class: 'text-sm' }, '请回到创作者电脑重新生成配对码，或仔细对照二维码下方的文字。')),
      );
      codeInput.focus();
      return;
    }
    mount(errorHost);
    setBusy(submitBtn, true, '正在连接…');
    try {
      const r = await api.post('/api/pair/redeem', {
        code: clean,
        name,
        platform: platformLabel(),
        appVersion: BOOT.appVersion || 'web',
      });
      tokenStore.write({
        token: r.token,
        deviceId: r.deviceId,
        name,
        role: r.role,
        canReceive: !!r.canReceive,
        hostName: r.hostName || '',
        approved: !!r.approved,
        status: 'pending',
        pairedAt: new Date().toISOString(),
      });
      state.session = readSession();
      api.setToken(state.session.token);
      state.hostName = r.hostName || state.hostName;
      state.details.clear();
      state.softNote = '';
      toast('已连接，等待创作者点「允许」', 'success');
      startLive();
      scheduleBeat(300);
      go(tasksHash());
    } catch (err) {
      setBusy(submitBtn, false);
      if (!ok()) return;
      const info = classify(err);
      if (['unpaired', 'revoked', 'pending', 'offline'].includes(info.kind)) return;
      mount(
        errorHost,
        banner(
          'error',
          '没能连上创作者电脑',
          h('div', { class: 'text-sm' }, info.message),
          h('div', { class: 'text-sm muted', style: { marginTop: '6px' } }, '配对码 10 分钟内有效、只能用一次；如果被提示已用过，请让创作者重新生成。'),
          h(
            'div',
            { class: 'row row-wrap', style: { marginTop: '10px' } },
            h(
              'button',
              {
                class: 'btn btn-sm btn-primary',
                onClick: () => {
                  codeInput.value = '';
                  mount(errorHost);
                  codeInput.focus();
                },
              },
              '重新输入配对码',
            ),
            h(
              'button',
              {
                class: 'btn btn-sm',
                onClick: () => {
                  setBusy(submitBtn, false);
                  connect();
                },
              },
              '再试一次',
            ),
          ),
        ),
      );
    }
  }

  submitBtn.addEventListener('click', (e) => {
    e.preventDefault();
    connect();
  });
  const onEnter = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      connect();
    }
  };
  codeInput.addEventListener('keydown', onEnter);
  nameInput.addEventListener('keydown', onEnter);

  return { name: 'pairing', apply: async () => loadInfo() };
}

/* ============================================================ 6. 等待授权页 */

function screenWaiting(ok) {
  const name = state.session ? state.session.name : '';
  const host = state.hostName || (state.session ? state.session.hostName : '');
  const bodyHost = h('div', { class: 'stack' });
  shell('等待创作者授权', host ? `创作者电脑：${host}` : '', { right: headerRight() }).append(bodyHost);

  const checkBtn = h(
    'button',
    {
      class: 'btn btn-primary btn-lg btn-block',
      onClick: async (e) => {
        setBusy(e.currentTarget, true, '正在检查…');
        await beat();
        if (!ok()) return;
        setBusy(e.currentTarget, false);
        mountCurrent({ force: true });
      },
    },
    '我已经点过允许了，立即检查',
  );

  function render() {
    mount(
      bodyHost,
      h(
        'div',
        { class: 'card stack' },
        h(
          'div',
          { class: 'rv-wait-ring' },
          h('span', { class: 'spinner' }),
          h('div', { class: 'strong', style: { fontSize: '17px' } }, '等待创作者在你的电脑上点「允许」'),
          h('div', { class: 'text-sm muted' }, '这台设备登记的名称是'),
          h('span', { class: 'pill pill-brand', style: { fontSize: '14px', padding: '6px 14px' } }, name),
        ),
        h('div', { class: 'divider' }),
        h('p', { class: 'text-sm' }, '请在创作者电脑打开的页面里找到「连接的设备」，确认这个名字还在待授权列表里，点「允许」。批准后这个页面会自动进入任务列表。'),
        h('p', { class: 'text-sm muted' }, `正在每 ${PENDING_POLL_MS / 1000} 秒向${host ? `「${host}」` : '创作者电脑'}确认一次，最近一次确认：${state.net.lastOkAt ? fmtAgo(new Date(state.net.lastOkAt).toISOString()) : '还没有成功过'}。`),
        state.softNote ? banner('warn', '创作者那边还没准备好', h('div', { class: 'text-sm' }, state.softNote)) : null,
        !state.net.ok ? banner('error', '连不上创作者电脑', h('div', { class: 'text-sm' }, state.net.error)) : null,
        checkBtn,
        h(
          'button',
          {
            class: 'btn btn-block',
            onClick: async () => {
              const sure = await confirmDialog({
                title: '取消这次配对？',
                message: ['取消后要重新扫码或输入配对码才能继续。', '如果创作者那边看不到这台设备，多半是配对码过期了，重新生成一个更快。'],
                confirmText: '取消配对',
                cancelText: '继续等待',
                danger: true,
              });
              if (!sure) return;
              state.pairNotice = '已取消这次配对，请重新扫码或输入配对码。';
              clearSession();
              mountCurrent({ force: true });
            },
          },
          '取消这次配对',
        ),
      ),
    );
  }

  render();
  return { name: 'waiting', apply: async () => render() };
}

/* ========================================================== 7. 授权被取消等 */

function screenRevoked() {
  const content = shell('授权已取消', '');
  content.append(
    h(
      'div',
      { class: 'stack' },
      banner(
        'error',
        '创作者已取消本设备授权',
        h('div', { class: 'text-sm' }, '你之前提交的意见和结论都会保留，但这台设备不能再打开文件。'),
        h('div', { class: 'text-sm', style: { marginTop: '6px' } }, state.softNote || '需要继续审核时，请让创作者重新生成一个「审核」配对码。'),
      ),
      h(
        'div',
        { class: 'card stack' },
        h('div', { class: 'card-title' }, '怎么办'),
        h('p', { class: 'text-sm' }, '1）创作者在电脑上重新生成「审核设备」配对码；2）用手机重新扫码，或在配对页输入配对码；3）创作者点允许后就能继续审核。'),
        h(
          'button',
          {
            class: 'btn btn-primary btn-lg btn-block',
            onClick: () => {
              state.pairNotice = '';
              state.softNote = '';
              clearSession();
              mountCurrent({ force: true });
            },
          },
          '重新配对',
        ),
      ),
    ),
  );
  return { name: 'revoked', apply: async () => {} };
}

function screenWrongRole() {
  const content = shell('这是接收端的配对码', '');
  content.append(
    h(
      'div',
      { class: 'stack' },
      banner(
        'warn',
        '这台设备被登记为「接收端」',
        h('div', { class: 'text-sm' }, '接收端用于接收创作者正式交付的文件，需要在那台电脑上运行接收端程序；在浏览器里审核要用「审核设备」的配对码。'),
      ),
      h(
        'div',
        { class: 'card stack' },
        h('p', { class: 'text-sm' }, '请让创作者生成配对码时选择「审核设备」，然后重新扫一次二维码。'),
        h(
          'button',
          {
            class: 'btn btn-primary btn-lg btn-block',
            onClick: () => {
              state.pairNotice = '请用「审核设备」的配对码重新连接。';
              clearSession();
              mountCurrent({ force: true });
            },
          },
          '用审核配对码重新连接',
        ),
      ),
    ),
  );
  return { name: 'wrongrole', apply: async () => {} };
}

/* ================================================================== 8. 数据层 */

async function loadInfo() {
  try {
    const r = await api.get('/api/info');
    state.hostName = (r && r.host && r.host.name) || state.hostName;
    markOnline();
    return r;
  } catch (err) {
    const info = classify(err);
    if (info.kind === 'offline') state.net.error = info.message;
    renderNet();
    return null;
  }
}

async function fetchTasks() {
  const r = await api.get('/api/me/tasks');
  return r && Array.isArray(r.tasks) ? r.tasks : [];
}

function taskSubmitted(t) {
  return t.submitted_at || t.submittedAt || '';
}

function sortTasks(rows) {
  const score = (t) => (t.open ? 0 : t.status === 'reviewing' ? 1 : 2);
  return rows.slice().sort((a, b) => {
    const d = score(a) - score(b);
    if (d) return d;
    return String(taskSubmitted(b)).localeCompare(String(taskSubmitted(a)));
  });
}

async function loadDetail(versionId, { force = false } = {}) {
  if (!force) {
    const hit = state.details.get(versionId);
    if (hit) return hit;
  }
  const r = await api.get(`/api/me/versions/${encodeURIComponent(versionId)}`);
  state.details.set(versionId, r);
  return r;
}

function commentsOf(detail, fileId) {
  return detail.comments.filter((c) => (c.file_id || null) === (fileId || null));
}

function countByFile(detail) {
  const m = new Map();
  for (const c of detail.comments) m.set(c.file_id || '__overall__', (m.get(c.file_id || '__overall__') || 0) + 1);
  return m;
}

function detailSignature(d) {
  const last = d.comments.length ? d.comments[d.comments.length - 1].id : '';
  return [
    d.version.status,
    d.version.decidedAt || '',
    d.comments.length,
    last,
    d.reviews.map((r) => `${r.device_id}:${r.updated_at}`).join(','),
    d.files.length,
  ].join('|');
}

/* ================================================================= 9. 任务列表 */

function screenTasks(ok) {
  const content = shell('审核任务', state.hostName ? `创作者电脑：${state.hostName}` : '', { right: headerRight() });
  const headHost = h('div', {});
  const listHost = h('div', {});
  content.append(headHost, listHost);

  function renderHead(rows) {
    const openCount = rows.filter((t) => t.open).length;
    mount(
      headHost,
      h(
        'div',
        { class: 'card card-flat row row-between row-wrap', style: { marginBottom: '14px' } },
        h(
          'div',
          { class: 'grow', style: { minWidth: '0' } },
          h('div', { class: 'strong', style: { fontSize: '17px' } }, openCount ? `${openCount} 个等你给结论` : '没有待处理的任务'),
          h('div', { class: 'text-sm muted' }, `共 ${rows.length} 个任务 · 这台设备：${state.session.name}`),
        ),
        h('button', { class: 'btn btn-sm', onClick: () => apply({ quiet: true }) }, '刷新'),
      ),
    );
  }

  function taskCard(t) {
    const submitted = taskSubmitted(t);
    const mine = (t.mine && t.mine.decision) || t.my_decision || null;
    return h(
      'button',
      { type: 'button', class: `card rv-task ${t.open ? 'is-open' : 'is-done'}`, onClick: () => go(versionHash(t.id)) },
      h(
        'div',
        { class: 'row row-between' },
        h('div', { class: 'strong truncate', style: { fontSize: '16px' } }, t.project_name || '未命名项目'),
        statusPillFor(t.status, t.statusLabel),
      ),
      h(
        'div',
        { class: 'row row-wrap gap-sm', style: { marginTop: '8px' } },
        h('span', { class: 'pill pill-brand' }, t.code),
        h('span', { class: 'text-sm muted' }, `${t.file_count || 0} 个文件 · ${fmtTime(submitted)}`),
        h('span', { class: 'text-xs muted' }, `（${fmtAgo(submitted)}提交）`),
      ),
      t.note ? h('div', { class: 'text-sm muted truncate', style: { marginTop: '6px' } }, `说明：${t.note}`) : null,
      h('div', { class: 'divider', style: { margin: '12px 0' } }),
      h(
        'div',
        { class: 'row row-between row-wrap gap-sm' },
        h(
          'span',
          { class: 'text-sm' },
          '我的结论：',
          h('span', { class: `pill ${mine === 'pass' ? 'pill-ok' : mine === 'changes' ? 'pill-warn' : 'pill-outline'}` }, decisionText(mine)),
        ),
        h('span', { class: 'text-xs muted' }, `${t.comment_count || 0} 条意见 · 你写了 ${(t.mine && t.mine.commentCount) || 0} 条 · ${t.decision_count || 0} 人已给结论`),
      ),
    );
  }

  function renderList(rows) {
    renderHead(rows);
    if (!rows.length) {
      mount(
        listHost,
        h(
          'div',
          { class: 'card' },
          emptyState(
            '还没有分配给你的审核任务',
            '创作者需要先在电脑上选好文件、点「提交审核」并勾选这台设备。任务一分配，这个页面会自动出现，不用一直刷新。',
            h('button', { class: 'btn btn-primary', onClick: () => apply({}) }, '重新读取任务'),
          ),
        ),
      );
      return;
    }
    const list = h('div', {});
    for (const t of sortTasks(rows)) list.append(taskCard(t));
    mount(listHost, list);
  }

  async function apply({ quiet = false } = {}) {
    if (!quiet && !listHost.childNodes.length) mount(listHost, loading('正在读取任务…'));
    try {
      const rows = await fetchTasks();
      if (!ok()) return;
      state.softNote = '';
      renderList(rows);
    } catch (err) {
      if (!ok()) return;
      const info = classify(err);
      if (['offline', 'unpaired', 'revoked', 'pending', 'soft'].includes(info.kind)) {
        if (!state.net.ok && !quiet) mount(listHost, loading('连接中断，正在自动重试…'));
        return;
      }
      mount(
        headHost,
        h(
          'div',
          { class: 'card card-flat row row-between', style: { marginBottom: '14px' } },
          h('div', { class: 'strong', style: { fontSize: '17px' } }, '任务列表没读出来'),
          h('button', { class: 'btn btn-sm', onClick: () => apply({}) }, '重试'),
        ),
      );
      mount(listHost, errorCard(info.message, () => apply({}), { title: info.kind === 'fatal' ? '这台设备不能审核' : '任务列表读取失败' }));
    }
  }

  apply();
  return { name: 'tasks', apply };
}

/* ============================================================= 10. 版本详情页 */

function screenVersion(versionId, ok) {
  shell('版本详情', state.hostName ? `创作者电脑：${state.hostName}` : '', {
    back: { label: '任务列表', onClick: () => go(tasksHash()) },
    right: headerRight(),
    bar: h('div', {}),
  });
  const barHost = qsa('.rv-bar .rv-bar-inner')[0];
  const content = qs('.rv-page');
  const headHost = h('div', { class: 'stack' });
  const tabsHost = h('div', { class: 'tabs' });
  const bodyHost = h('div', { class: 'stack' });
  content.append(headHost, tabsHost, bodyHost);

  let lastSig = '';
  let held = null;
  let loadedOnce = false;

  function render(detail) {
    renderHead(detail);
    renderTabs(detail);
    renderBody(detail);
    renderBar(detail);
  }

  function renderHead(detail) {
    const v = detail.version;
    const note = state.lastDecision && state.lastDecision.versionId === versionId ? state.lastDecision : null;
    mount(
      headHost,
      h(
        'div',
        { class: 'card stack' },
        h(
          'div',
          { class: 'row row-between row-wrap' },
          h(
            'div',
            { class: 'grow', style: { minWidth: '0' } },
            h('div', { class: 'strong', style: { fontSize: '18px' } }, (detail.project && detail.project.name) || v.projectName || '项目'),
            detail.project && (detail.project.brand || detail.project.project_date)
              ? h('div', { class: 'text-sm muted' }, [detail.project.brand, detail.project.project_date].filter(Boolean).join(' · '))
              : null,
          ),
          statusPillFor(v.status, v.statusLabel),
        ),
        h(
          'div',
          { class: 'row row-wrap gap-sm' },
          h('span', { class: 'pill pill-brand' }, v.code),
          h('span', { class: 'text-sm muted' }, `提交于 ${fmtTime(v.submittedAt)}（${fmtAgo(v.submittedAt)}）`),
          v.decidedAt ? h('span', { class: 'text-sm muted' }, `定稿于 ${fmtTime(v.decidedAt)}`) : null,
        ),
        v.note
          ? h(
              'div',
              { class: 'card card-flat', style: { background: 'var(--surface-2)', padding: '12px 14px' } },
              h('div', { class: 'text-xs muted' }, '创作者说明'),
              h('div', { class: 'rv-comment-text' }, v.note),
            )
          : null,
        v.previousVersionId
          ? h('button', { class: 'btn btn-sm', style: { alignSelf: 'flex-start' }, onClick: () => go(versionHash(v.previousVersionId)) }, '查看上一版（旧意见和旧结论都还在）')
          : null,
        note
          ? banner(
              'success',
              '你的结论已经提交',
              h('div', { class: 'text-sm' }, note.text),
              h('button', { class: 'btn btn-sm', style: { marginTop: '8px' }, onClick: () => { state.lastDecision = null; renderDetailKeepStage(); } }, '知道了'),
            )
          : null,
      ),
      reviewersCard(detail),
    );
  }

  function renderDetailKeepStage() {
    const d = state.details.get(versionId);
    if (d) render(d);
  }

  function renderTabs(detail) {
    const tabs = [
      ['files', `文件 ${detail.files.length}`],
      ['comments', `意见 ${detail.comments.length}`],
    ];
    mount(
      tabsHost,
      ...tabs.map((t) =>
        h(
          'button',
          {
            class: `tab ${state.tab === t[0] ? 'active' : ''}`,
            onClick: () => {
              state.tab = t[0];
              renderTabs(detail);
              renderBody(detail);
            },
          },
          t[1],
        ),
      ),
    );
  }

  function renderBody(detail) {
    if (state.tab === 'comments') {
      mount(bodyHost, commentsSection(detail, versionId, () => apply({ force: true })));
      return;
    }
    const counts = countByFile(detail);
    mount(
      bodyHost,
      h('div', { class: 'text-sm muted', style: { marginBottom: '10px' } }, '点文件就能预览；不能预览的文件可以直接下载。针对单个文件的意见在打开文件后写。'),
      detail.files.length
        ? h(
            'div',
            { class: 'list' },
            ...detail.files.map((f) => fileRow(f, counts.get(f.id) || 0, () => go(fileHash(versionId, f.id)))),
          )
        : h('div', { class: 'card' }, emptyState('这个版本里没有文件', '创作者提交时清单是空的，请让他重新选择文件再提交一次。')),
    );
  }

  function renderBar(detail) {
    if (!barHost) return;
    mount(barHost, decisionBar(detail, () => apply({ force: true })));
  }

  async function apply(opts = {}) {
    const quiet = !!opts.quiet;
    if (!loadedOnce) mount(bodyHost, loading('正在读取版本…'));
    let detail;
    try {
      detail = await loadDetail(versionId, { force: quiet || opts.force || loadedOnce });
    } catch (err) {
      if (!ok()) return;
      const info = classify(err);
      if (['offline', 'unpaired', 'revoked', 'pending', 'soft'].includes(info.kind)) {
        if (quiet) return;
        if (!loadedOnce) mount(bodyHost, loading('连接中断，正在自动重试…'));
        return;
      }
      loadedOnce = true;
      mount(headHost, errorCard(info.message, () => apply({ force: true }), { title: info.kind === 'fatal' ? '这台设备打不开这个版本' : '版本读取失败' }));
      mount(tabsHost);
      mount(bodyHost);
      if (barHost) mount(barHost, emptyDecisionBar());
      return;
    }
    if (!ok()) return;
    loadedOnce = true;
    const sig = detailSignature(detail);
    if (quiet && sig === lastSig) return;
    if (isEditing(bodyHost) || isEditing(barHost)) {
      held = detail;
      return;
    }
    lastSig = sig;
    render(detail);
  }

  apply();
  return {
    name: 'version',
    apply,
    flush: () => {
      if (!held) return;
      const d = held;
      held = null;
      lastSig = detailSignature(d);
      render(d);
    },
  };
}

function emptyDecisionBar() {
  return h('div', { class: 'text-sm muted' }, '这个版本现在不能给结论，请返回任务列表。');
}

function reviewersCard(detail) {
  const reviewers = detail.reviewers || [];
  const decided = reviewers.filter((r) => r.decided).length;
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title grow' }, '审核进度'), h('span', { class: 'chip' }, `${decided}/${reviewers.length} 人已给结论`)),
    progressBar(reviewers.length ? (decided / reviewers.length) * 100 : 0, reviewers.length && decided === reviewers.length ? 'ok' : ''),
    reviewers.length
      ? h(
          'div',
          { class: 'row row-wrap gap-sm', style: { marginTop: '12px' } },
          ...reviewers.map((r) =>
            h(
              'span',
              { class: `pill ${r.decided ? (r.decision === 'pass' ? 'pill-ok' : 'pill-warn') : 'pill-outline'}` },
              r.name || '设备',
              r.decided ? `：${decisionText(r.decision)}` : '：还没看',
            ),
          ),
        )
      : null,
    h('div', { class: 'text-xs muted', style: { marginTop: '10px' } }, '所有人都给「通过」，版本才会变成「已通过，待交付」；任何一个人要求修改，版本立刻回到「需要修改」。'),
  );
}

function fileRow(f, count, onOpen) {
  const p = previewInfo(f);
  return h(
    'div',
    {
      class: 'list-item rv-file',
      role: 'button',
      tabindex: '0',
      onClick: onOpen,
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      },
    },
    fileIcon(f.kind, f.ext),
    h(
      'div',
      { class: 'grow rv-file-main' },
      h('div', { class: 'rv-file-name truncate' }, f.name),
      f.relPath && f.relPath !== f.name ? h('div', { class: 'rv-file-meta' }, h('span', { class: 'truncate' }, f.relPath)) : null,
      h(
        'div',
        { class: 'rv-file-meta' },
        h('span', {}, KIND_NAME[f.kind] || '文件'),
        h('span', {}, fmtBytes(f.size)),
        h('span', { class: p.cls }, p.text),
        count ? h('span', { class: 'chip chip-ok' }, `${count} 条意见`) : null,
      ),
    ),
    h('div', { class: 'col gap-sm' }, h('span', { class: 'chip' }, '预览 ›'), downloadLink(f, { onStop: true, text: '下载' })),
  );
}

/* ------------------------------------------------------------------ 评论区块 */

function commentsSection(detail, versionId, onPosted) {
  const composer = commentComposer(detail, null, onPosted);
  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'card-head' }, h('div', { class: 'card-title grow' }, '整体意见'), h('span', { class: 'chip' }, `${commentsOf(detail, null).length} 条`)),
      h('p', { class: 'text-sm muted', style: { marginTop: '-6px' } }, '不针对具体文件的判断写在这里，例如节奏、风格、是否符合交付要求。'),
      composer.node,
    ),
    h('div', { class: 'section-title' }, `全部意见 ${detail.comments.length} 条`),
    h(
      'div',
      { class: 'card' },
      detail.comments.length
        ? h(
            'div',
            {},
            ...detail.comments.map((c) =>
              commentItem(c, {
                onSeek:
                  c.file_id != null
                    ? (t) => {
                        state.pendingSeek = { versionId, fileId: c.file_id, t };
                        go(fileHash(versionId, c.file_id));
                      }
                    : null,
                onOpenFile: c.file_id ? () => go(fileHash(versionId, c.file_id)) : null,
              }),
            ),
          )
        : emptyState('这个版本还没有任何意见', '可以先在这里写整体意见，也可以打开某个文件对着画面提意见。'),
    ),
  );
}

function commentItem(c, { onSeek, onOpenFile } = {}) {
  return h(
    'div',
    { class: 'rv-comment' + (c.mine ? ' mine' : '') },
    h('div', { class: 'rv-avatar' }, initials(c.device_name)),
    h(
      'div',
      { class: 'grow rv-comment-body' },
      h(
        'div',
        { class: 'row row-wrap gap-sm' },
        h('span', { class: 'strong text-sm' }, c.mine ? `${c.device_name || '这台设备'}（你）` : c.device_name || '审核设备'),
        h('span', { class: 'text-xs muted' }, `${fmtTime(c.created_at)} · ${fmtAgo(c.created_at)}`),
      ),
      h('div', { class: 'rv-comment-text', style: { marginTop: '4px' } }, c.body),
      h(
        'div',
        { class: 'row row-wrap gap-sm', style: { marginTop: '8px' } },
        c.timecode != null ? timecodeChip(c.timecode, onSeek) : null,
        c.file_id ? (onOpenFile ? h('button', { class: 'chip', onClick: onOpenFile }, `${c.fileLabel || '文件'} ›`) : h('span', { class: 'chip' }, c.fileLabel || '文件')) : h('span', { class: 'chip' }, '整体意见'),
        c.resolved_at ? h('span', { class: 'chip chip-ok' }, '创作者已标记处理') : null,
      ),
    ),
  );
}

function timecodeChip(t, onSeek) {
  const label = `⏱ ${fmtClock(t)}`;
  if (onSeek) return h('button', { class: 'chip rv-tc', onClick: () => onSeek(t) }, label);
  return h('span', { class: 'chip rv-tc' }, label);
}

/** 返回 { node, bindPlayer }；bindPlayer 让「标记此刻」拿到播放器 */
function commentComposer(detail, fileId, onPosted) {
  const versionId = detail.version.id;
  const file = fileId ? detail.files.find((f) => f.id === fileId) : null;
  const media = !!file && isMediaFile(file);
  const ta = h('textarea', {
    class: 'textarea',
    rows: '3',
    placeholder: media ? '例如：0:03 处 logo 出现太晚，建议提前半秒' : '例如：整体色调偏冷，品牌希望更暖一点',
  });
  const tcInput = h('input', { class: 'input input-mono', placeholder: '0:12', inputmode: 'numeric', 'aria-label': '时间码' });
  const errHost = h('div', {});
  const sendBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'button' }, '添加评论');
  let player = null;
  let duration = 0;

  const markBtn = h(
    'button',
    {
      class: 'btn btn-lg',
      type: 'button',
      onClick: () => {
        if (!player || !player.readyState || !Number.isFinite(player.currentTime)) {
          mount(errHost, banner('warn', '播放器还没准备好', h('div', { class: 'text-sm' }, '先点播放，等画面或进度条出来后再接这个按钮。')));
          return;
        }
        tcInput.value = fmtClock(Math.round(player.currentTime));
        mount(errHost);
        toast(`已标记 ${fmtClock(Math.round(player.currentTime))}`, 'info', 1800);
      },
    },
    '标记此刻 (mm:ss)',
  );

  async function post() {
    const body = String(ta.value || '').trim();
    if (!body) {
      mount(errHost, banner('warn', '请先写意见内容', h('div', { class: 'text-sm' }, '哪怕一句「这版没问题」也比空着强。')));
      ta.focus();
      return;
    }
    let tc = null;
    if (media && String(tcInput.value || '').trim()) {
      const parsed = parseTimecode(tcInput.value);
      if (parsed === null || Number.isNaN(parsed) || parsed < 0) {
        mount(errHost, banner('warn', '时间码格式不对', h('div', { class: 'text-sm' }, '用 mm:ss（如 0:12）或 h:mm:ss，也可以直接填秒数。')));
        tcInput.focus();
        return;
      }
      tc = parsed;
      if (duration && tc > duration + 1) {
        mount(errHost, banner('warn', `时间码超过了文件长度 ${fmtClock(duration)}`, h('div', { class: 'text-sm' }, '确认一下是不是想标别的位置。')));
        return;
      }
    }
    mount(errHost);
    setBusy(sendBtn, true, '正在发送…');
    try {
      await api.post('/api/me/comments', { versionId, fileId: fileId || null, body, timecode: tc });
      ta.value = '';
      tcInput.value = '';
      setBusy(sendBtn, false);
      toast('意见已发送', 'success');
      onPosted();
    } catch (err) {
      setBusy(sendBtn, false);
      const info = classify(err);
      if (info.kind === 'offline') {
        mount(errHost, banner('error', '这条意见没发出去：连接中断', h('div', { class: 'text-sm' }, '内容还留在输入框里，恢复连接后再点一次「添加评论」。')));
      } else if (info.kind === 'error' || info.kind === 'fatal') {
        mount(
          errHost,
          banner(
            'error',
            '这条意见没有保存',
            h('div', { class: 'text-sm' }, info.message),
            h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn btn-sm btn-primary', onClick: () => post() }, '重发这条')),
          ),
        );
      }
    }
  }

  sendBtn.addEventListener('click', post);

  const node = h(
    'div',
    { class: 'stack' },
    ta,
    media
      ? h(
          'div',
          { class: 'rv-mark' },
          markBtn,
          h('span', { class: 'text-sm muted' }, '时间码'),
          tcInput,
          h('span', { class: 'text-xs muted' }, '留空就是不针对具体时间点'),
        )
      : null,
    errHost,
    h('div', { class: 'row row-between' }, h('span', { class: 'grow text-xs muted' }, '发送后创作者那边立刻可见'), sendBtn),
  );

  return { node, bindPlayer: (el, dur) => { player = el || null; duration = dur || 0; } };
}

/* ------------------------------------------------------------- 结论（粘性条） */

function decisionBar(detail, onDone) {
  const v = detail.version;
  const mine = detail.myDecision;
  const ended = detail.locked || v.status !== 'reviewing';

  if (ended) {
    return h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'row row-wrap' },
        h('span', { class: 'strong' }, '本次审核已结束'),
        statusPillFor(v.status, v.statusLabel),
        mine ? h('span', { class: 'text-sm muted' }, `你的结论：${decisionText(mine.decision)}`) : h('span', { class: 'text-sm muted' }, '你当时没有给结论'),
      ),
      mine && mine.note ? h('div', { class: 'text-sm muted' }, `你的说明：${mine.note}`) : null,
      h('div', { class: 'text-xs muted' }, '版本一旦定稿就不能再改结论；要继续审核，请让创作者提交新版本。'),
    );
  }

  const changesLabel = `${mine && mine.decision === 'changes' ? '更新' : '需要修改'}`;
  const passLabel = `${mine && mine.decision === 'pass' ? '更新' : '审核通过'}`;
  const noteInput = h('textarea', { class: 'textarea', rows: '3', placeholder: '说明（可选）：改哪里、为什么要改，创作者照着做就行' });
  noteInput.value = mine && mine.note ? mine.note : '';
  const noteWrap = h('div', { class: 'rv-note' + (mine ? ' open' : '') }, noteInput);
  const errHost = h('div', {});
  const changesBtn = h('button', { class: 'btn btn-danger btn-lg btn-decision', type: 'button' }, `✗ ${changesLabel}`);
  const passBtn = h('button', { class: 'btn btn-ok btn-lg btn-decision', type: 'button' }, `✓ ${passLabel}`);

  const beginBusy = (btn) => {
    changesBtn.disabled = true;
    passBtn.disabled = true;
    btn.textContent = '正在提交…';
  };
  const endBusy = () => {
    changesBtn.disabled = false;
    passBtn.disabled = false;
    changesBtn.textContent = `✗ ${changesLabel}`;
    passBtn.textContent = `✓ ${passLabel}`;
  };

  async function submit(decision, btn) {
    mount(errHost);
    beginBusy(btn);
    try {
      const res = await api.post('/api/me/decision', { versionId: v.id, decision, note: String(noteInput.value || '').trim() });
      const fresh = await loadDetail(v.id, { force: true });
      const sentence = decisionSentence(fresh, res.versionStatus, decision);
      state.lastDecision = { versionId: v.id, text: sentence };
      toast(sentence, 'success');
      endBusy();
      onDone();
    } catch (err) {
      endBusy();
      const info = classify(err);
      if (info.kind === 'offline') {
        mount(errHost, banner('error', '结论没有提交成功：连接中断', h('div', { class: 'text-sm' }, '说明还留在输入框里，恢复连接后再点一次。')));
      } else if (info.kind === 'error' || info.kind === 'fatal') {
        mount(
          errHost,
          banner(
            'error',
            '结论没有提交成功',
            h('div', { class: 'text-sm' }, info.message),
            h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn btn-sm btn-primary', onClick: () => submit(decision, btn) }, '重试提交')),
          ),
        );
      }
    }
  }

  changesBtn.addEventListener('click', () => submit('changes', changesBtn));
  passBtn.addEventListener('click', () => submit('pass', passBtn));

  const decided = (detail.reviewers || []).filter((r) => r.decided).length;
  const total = (detail.reviewers || []).length;
  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'row row-between' },
      mine
        ? h(
            'span',
            { class: 'text-sm' },
            '你的结论：',
            h('span', { class: `pill ${mine.decision === 'pass' ? 'pill-ok' : 'pill-warn'}` }, decisionText(mine.decision)),
            h('span', { class: 'text-xs muted' }, ` ${fmtTime(mine.updated_at)}，可随时改`),
          )
        : h('span', { class: 'strong text-sm' }, '还没有给出结论'),
      h(
        'button',
        {
          class: 'btn btn-ghost btn-sm rv-note-toggle',
          type: 'button',
          onClick: () => {
            noteWrap.classList.toggle('open');
            if (noteWrap.classList.contains('open')) noteInput.focus();
          },
        },
        mine ? '改说明' : '＋ 补充说明',
      ),
    ),
    noteWrap,
    errHost,
    h('div', { class: 'row row-wrap' }, changesBtn, passBtn),
    h('div', { class: 'text-xs muted' }, total ? `${decided}/${total} 位审核人已给结论 · 这个版本正在审核中` : '这个版本正在审核中'),
  );
}

function decisionSentence(detail, versionStatus, decision) {
  const reviewers = detail.reviewers || [];
  const done = reviewers.filter((r) => r.decided).length;
  const head = `已记录「${DECISION_TEXT[decision] || decision}」`;
  if (versionStatus === 'reviewing') return `${head}，还在等其他审核人（${done}/${reviewers.length || done}）`;
  if (versionStatus === 'approved') return `${head}，全部审核人已通过 → 版本状态：${detail.version.statusLabel}`;
  if (versionStatus === 'changes_requested') return `${head}，有审核人要求修改 → 版本状态：${detail.version.statusLabel}`;
  return `${head} → 版本状态：${detail.version.statusLabel}`;
}

/* ============================================================== 11. 文件查看器 */

function screenViewer(versionId, fileId, ok) {
  shell('文件预览', '', {
    back: { label: '返回版本', onClick: () => go(versionHash(versionId)) },
    right: headerRight(),
    bar: h('div', {}),
  });
  const barHost = qsa('.rv-bar .rv-bar-inner')[0];
  const content = qs('.rv-page');
  const stageHost = h('div', { class: 'stack' });
  const infoHost = h('div', { class: 'stack' });
  const threadHost = h('div', { class: 'stack' });
  content.append(stageHost, infoHost, threadHost);

  const ctl = {
    player: null,
    duration: 0,
    onMeta: null,
    seek(t) {
      if (!ctl.player) {
        toast('这个文件没有可跳转的时间轴', 'info');
        return;
      }
      const el = ctl.player;
      const apply = () => {
        try {
          el.currentTime = t;
        } catch {
          /* 元数据还没好时会抛错，忽略 */
        }
        const p = el.play();
        if (p && p.catch) p.catch(() => {});
      };
      if (el.readyState >= 1) apply();
      else el.addEventListener('loadedmetadata', apply, { once: true });
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      toast(`已跳到 ${fmtClock(t)}`, 'info', 2000);
    },
  };

  let detail = null;
  let file = null;
  let composer = null;
  let threadSig = '';
  let heldThread = false;
  let loadedOnce = false;

  function buildStage() {
    ctl.player = null;
    ctl.duration = 0;
    ctl.onMeta = () => {
      if (!ok()) return;
      renderInfo();
      if (composer && isMediaFile(file)) composer.bindPlayer(ctl.player, ctl.duration);
    };
    mount(stageHost, viewerStage(file, ctl, { onReload: () => reloadStage() }));
    if (composer && isMediaFile(file)) composer.bindPlayer(ctl.player, ctl.duration);

    const pending = state.pendingSeek;
    if (pending && pending.versionId === versionId && pending.fileId === fileId) {
      state.pendingSeek = null;
      if (ctl.player) {
        if (ctl.player.readyState >= 1) ctl.seek(pending.t);
        else ctl.player.addEventListener('loadedmetadata', () => ctl.seek(pending.t), { once: true });
      }
    }
  }

  function reloadStage() {
    apply({ force: true, rebuild: true });
  }

  function renderInfo() {
    if (!detail || !file) return;
    const counts = countByFile(detail);
    const p = previewInfo(file);
    mount(
      infoHost,
      h(
        'div',
        { class: 'card stack' },
        h(
          'div',
          { class: 'row row-between row-wrap' },
          h(
            'div',
            { class: 'grow', style: { minWidth: '0' } },
            h('div', { class: 'strong truncate' }, file.name),
            h('div', { class: 'text-xs muted rv-mono-sm truncate' }, file.relPath),
          ),
          h('span', { class: 'chip' }, KIND_NAME[file.kind] || '文件'),
        ),
        h(
          'div',
          { class: 'row row-wrap gap-sm' },
          h('span', { class: 'text-sm muted' }, fmtBytes(file.size)),
          h('span', { class: p.cls }, p.text),
          isMediaFile(file) ? h('span', { class: 'chip' }, ctl.duration ? `时长 ${fmtClock(ctl.duration)}` : '时长读取中…') : null,
          h('span', { class: 'grow' }),
          downloadLink(file, { class: 'btn btn-sm btn-primary', text: '下载副本' }),
        ),
        file.previewNote && viewerKind(file) !== 'text' ? banner('warn', '关于这个文件', h('div', { class: 'text-sm' }, file.previewNote)) : null,
        h(
          'div',
          { class: 'row row-between' },
          h('span', { class: 'text-sm' }, `这个文件的意见 ${counts.get(file.id) || 0} 条`),
          h('button', { class: 'btn btn-sm', onClick: () => { state.tab = 'comments'; go(versionHash(versionId)); } }, '看整体意见'),
        ),
      ),
    );
  }

  function renderThread() {
    const list = commentsOf(detail, file.id);
    const sig = `${file.id}:${list.length}:${list.length ? list[list.length - 1].id : ''}`;
    if (sig === threadSig && composer) return;
    threadSig = sig;
    composer = commentComposer(detail, file.id, () => apply({ force: true, keepStage: true }));
    mount(
      threadHost,
      h(
        'div',
        { class: 'card stack' },
        list.length
          ? h(
              'div',
              {},
              ...list.map((c) =>
                commentItem(c, {
                  onSeek: c.timecode != null ? (t) => ctl.seek(t) : null,
                  onOpenFile: null,
                }),
              ),
            )
          : emptyState('这个文件还没有意见', '写完点「添加评论」即可，创作者那边会立刻出现。'),
        isMediaFile(file) ? h('p', { class: 'text-xs muted', style: { marginTop: '-6px' } }, '边播边写：播到问题那一下按「标记此刻」，创作者能直接跳过去看。') : null,
        composer.node,
      ),
    );
    if (isMediaFile(file)) composer.bindPlayer(ctl.player, ctl.duration);
  }

  function renderBar() {
    if (!barHost || !detail) return;
    const mine = detail.myDecision;
    const ended = detail.locked || detail.version.status !== 'reviewing';
    mount(
      barHost,
      h(
        'div',
        { class: 'row row-between row-wrap' },
        h(
          'span',
          { class: 'text-sm' },
          '我的结论：',
          h('span', { class: `pill ${mine ? (mine.decision === 'pass' ? 'pill-ok' : 'pill-warn') : 'pill-outline'}` }, decisionText(mine && mine.decision)),
        ),
        h(
          'button',
          {
            class: 'btn btn-sm btn-primary',
            onClick: () => {
              if (ended) {
                go(versionHash(versionId));
                return;
              }
              openDecisionModal(detail, () => apply({ force: true, keepStage: true }));
            },
          },
          ended ? '去版本页看结论' : mine ? '修改结论' : '给出结论',
        ),
      ),
    );
  }

  function applyTitle() {
    const v = detail.version;
    const box = qs('#app .app-header .brand > div:nth-child(2)');
    if (box) {
      box.textContent = '';
      box.append(h('div', { class: 'truncate' }, file.name), h('div', { class: 'header-meta' }, `${(detail.project && detail.project.name) || v.projectName || ''} · ${v.code}`));
    }
    document.title = `${file.name} · 审核`;
  }

  async function apply(opts = {}) {
    if (!stageHost.childNodes.length) mount(stageHost, loading('正在打开文件…'));
    try {
      detail = await loadDetail(versionId, { force: !!opts.force || loadedOnce });
    } catch (err) {
      if (!ok()) return;
      const info = classify(err);
      if (['offline', 'unpaired', 'revoked', 'pending', 'soft'].includes(info.kind)) return;
      mount(stageHost, errorCard(info.message, info.kind === 'fatal' ? null : () => apply({ force: true }), { title: '这个版本打不开' }));
      return;
    }
    if (!ok()) return;
    loadedOnce = true;
    file = detail.files.find((f) => f.id === fileId);
    if (!file) {
      mount(
        stageHost,
        errorCard('这个文件已经不在这个版本里了（可能创作者重新提交了版本）。请回版本页看现在的文件清单。', () => go(versionHash(versionId)), { title: '文件不在了' }),
      );
      return;
    }
    applyTitle();
    if (opts.rebuild || !ctl.stageBuilt) {
      buildStage();
      ctl.stageBuilt = true;
    }
    renderInfo();
    if (isEditing(threadHost) && opts.keepStage !== true) heldThread = true;
    else {
      heldThread = false;
      renderThread();
    }
    renderBar();
  }

  apply();
  return {
    name: 'viewer',
    apply,
    flush: () => {
      if (!heldThread) return;
      heldThread = false;
      threadSig = '';
      renderThread();
    },
  };
}

function openDecisionModal(detail, onDone) {
  const bar = decisionBar(detail, () => {
    dlg.close();
    onDone();
  });
  const dlg = modal({ title: `对 ${detail.version.code} 的结论`, body: bar });
}

function viewerStage(f, ctl, { onReload }) {
  const kind = viewerKind(f);
  if (!f.mediaUrl && kind !== 'none' && kind !== 'text') return noneCard(f, { onReload }, '预览链接不可用，请重新进入这个文件获取新链接。');
  if (kind === 'image') return imageStage(f, onReload);
  if (kind === 'video') return mediaStage(f, ctl, 'video', onReload);
  if (kind === 'audio') return mediaStage(f, ctl, 'audio', onReload);
  if (kind === 'pdf') return pdfStage(f);
  if (kind === 'text') return textStage(f, onReload);
  if (kind === 'maybe') return maybeStage(f, ctl, onReload);
  return noneCard(f, { onReload });
}

function imageStage(f, onReload) {
  const status = h('div', { class: 'text-xs muted' }, '正在加载图片…');
  const img = h('img', { class: 'rv-img', src: f.mediaUrl, alt: f.name });
  const stage = h('div', { class: 'rv-stage rv-stage-tall' }, img);
  img.addEventListener('load', () => {
    status.textContent = '点图片可放大 / 缩小，双指可捏合看细节。';
  });
  img.addEventListener('error', () => {
    mount(stage, brokenCard(f, '这张图片无法在浏览器里解码。', onReload));
    status.textContent = '图片加载失败。';
  });
  img.addEventListener('click', () => img.classList.toggle('zoomed'));
  return h('div', { class: 'stack' }, stage, status);
}

function mediaStage(f, ctl, tag, onReload) {
  const status = h('div', { class: 'text-xs muted' }, tag === 'video' ? '正在读取视频信息…' : '正在读取音频信息…');
  const el = document.createElement(tag);
  el.className = tag === 'video' ? 'rv-video' : 'rv-audio';
  el.setAttribute('controls', '');
  el.setAttribute('playsinline', '');
  el.setAttribute('webkit-playsinline', '');
  el.setAttribute('preload', 'metadata');
  el.src = f.mediaUrl;
  ctl.player = el;
  const stage = h('div', { class: 'rv-stage' }, el);
  el.addEventListener('loadedmetadata', () => {
    ctl.duration = Number(el.duration) || 0;
    status.textContent = tag === 'video' ? '可以直接拖进度条：服务器支持分段读取，不用等整个文件下载完。' : '可以拖动进度条定位到具体秒，再按下面的「标记此刻」。';
    if (ctl.onMeta) ctl.onMeta();
  });
  el.addEventListener('error', () => {
    mount(stage, brokenCard(f, tag === 'video' ? '这个视频在当前浏览器里播放失败（多半是封装格式或编码不支持）。' : '这个音频在当前浏览器里播放失败。', onReload));
    status.textContent = '播放失败，可以改用下载。';
  });
  return h('div', { class: 'stack' }, stage, status);
}

function pdfStage(f) {
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'rv-stage rv-stage-flow' }, h('iframe', { class: 'rv-pdf', src: f.mediaUrl, title: f.name })),
    h(
      'div',
      { class: 'row row-wrap gap-sm' },
      h('a', { class: 'btn btn-sm', href: f.mediaUrl, target: '_blank', rel: 'noopener' }, '在新窗口打开'),
      h('span', { class: 'text-xs muted' }, '手机里如果这块是空白的，请改用「在新窗口打开」，或下载后用本机阅读器看。'),
    ),
  );
}

function textStage(f, onReload) {
  const box = h('div', { class: 'stack' }, loading('正在读取文本内容…'));
  (async () => {
    try {
      const r = await api.get(f.textUrl);
      if (!r || r.binary || r.text === null || r.text === undefined) {
        mount(box, noneCard(f, { onReload }, '这个文件的内容不是纯文本，浏览器里读不出来，请下载后用对应软件打开。'));
        return;
      }
      mount(
        box,
        r.truncated ? banner('warn', '文件较大，只预览了前面部分', h('div', { class: 'text-sm' }, '完整内容请点「下载副本」。')) : null,
        h('pre', { class: 'rv-pre' }, String(r.text)),
      );
    } catch (err) {
      const info = classify(err);
      if (info.kind === 'offline') mount(box, loading('连接中断，正在自动重试读取文本…'));
      else mount(box, errorCard(info.message, () => onReload(), { title: '文本内容读取失败' }));
    }
  })();
  return box;
}

function maybeStage(f, ctl, onReload) {
  return h(
    'div',
    { class: 'stack' },
    noneCard(f, { onReload }, f.previewNote || '这种封装格式浏览器不一定支持直接播放，可以先下载再看。'),
    h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'card-title' }, '仍然想在这里试试？'),
      h('p', { class: 'text-sm muted' }, '下面会直接调用浏览器自带的播放器；能播就能看，也能标时间码。'),
      h(
        'button',
        {
          class: 'btn btn-primary btn-lg',
          onClick: (e) => {
            const host = e.currentTarget.closest('.stack');
            const node =
              f.kind === 'audio'
                ? mediaStage(f, ctl, 'audio', onReload)
                : f.kind === 'image'
                  ? imageStage(f, onReload)
                  : f.kind === 'pdf'
                    ? pdfStage(f)
                    : mediaStage(f, ctl, 'video', onReload);
            if (host) mount(host, node, h('div', { class: 'text-xs muted' }, '如果一直黑屏或没有声音，请改用下载。'));
            if (ctl.onMeta) ctl.onMeta();
          },
        },
        '仍然尝试播放',
      ),
    ),
  );
}

function noneCard(f, opts = {}, reasonOverride = null) {
  const onReload = opts && opts.onReload ? opts.onReload : null;
  return h(
    'div',
    { class: 'card stack' },
    h(
      'div',
      { class: 'row' },
      fileIcon(f.kind, f.ext),
      h('div', { class: 'grow', style: { minWidth: '0' } }, h('div', { class: 'strong truncate' }, f.name), h('div', { class: 'text-xs muted rv-mono-sm truncate' }, f.relPath)),
    ),
    h(
      'dl',
      { class: 'kv' },
      h('dt', {}, '为什么不能预览'),
      h('dd', {}, reasonOverride || f.previewNote || '浏览器没有内置这种格式的查看能力（如 PSD、AI、Excel 等）。'),
      h('dt', {}, '类型'),
      h('dd', {}, `${KIND_NAME[f.kind] || '文件'} · ${(f.ext || '未知').toUpperCase()}`),
      h('dt', {}, '大小'),
      h('dd', {}, fmtBytes(f.size)),
    ),
    h(
      'div',
      { class: 'row row-wrap' },
      downloadLink(f, { class: 'btn btn-primary btn-lg', text: '下载这个文件' }),
      f.mediaUrl ? h('a', { class: 'btn btn-lg', href: f.mediaUrl, target: '_blank', rel: 'noopener' }, '尝试直接打开') : null,
      onReload ? h('button', { class: 'btn btn-lg', onClick: () => onReload() }, '重新取一次链接') : null,
    ),
    h('div', { class: 'text-xs muted' }, '下载链接是这台设备专属的，转发给别人打不开；链接约 6 小时后失效，重新进入文件就会拿到新的。'),
  );
}

function brokenCard(f, message, onReload) {
  return h(
    'div',
    { class: 'card stack', style: { margin: '12px' } },
    banner('error', '预览加载失败', h('div', { class: 'text-sm' }, message)),
    h(
      'div',
      { class: 'row row-wrap' },
      h('button', { class: 'btn btn-primary', onClick: () => (onReload ? onReload() : location.reload()) }, '重新取链接再试'),
      downloadLink(f, { class: 'btn', text: '下载这个文件' }),
    ),
    h('div', { class: 'text-xs muted' }, '预览链接约 6 小时后失效；页面放着没动很久后再进来时，点这里重新取一次就行。'),
  );
}

/* ================================================================== 12. 启动 */

window.addEventListener('hashchange', () => mountCurrent());
window.addEventListener('focus', () => {
  if (state.session && state.session.token) beatNow();
});
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (screen && typeof screen.flush === 'function') screen.flush();
  }, 80);
});
window.addEventListener('online', () => beatNow());
window.addEventListener('offline', () => markOffline('这台设备似乎断开了 Wi-Fi 或蜂窝网络'));
setInterval(tickNet, 1000);

async function boot() {
  setFavicon();
  renderNet();
  await loadInfo();
  if (state.session && state.session.token) {
    api.setToken(state.session.token);
    try {
      const p = await api.get('/api/me/profile');
      state.device = p.device;
      state.hostName = (p.host && p.host.name) || state.hostName;
      saveSession({
        approved: !!p.device.approved,
        status: p.device.status,
        name: p.device.name || state.session.name,
        role: p.device.role || state.session.role,
        hostName: state.hostName || state.session.hostName,
      });
      markOnline();
    } catch (err) {
      const info = classify(err);
      if (info.kind === 'error' || info.kind === 'fatal') {
        state.softNote = info.message;
        saveSession({ approved: false });
      }
    }
    if (state.session && state.session.token) {
      scheduleBeat();
      if (state.session.approved) startLive();
    }
  }
  await mountCurrent({ force: true });
}

boot().catch((err) => {
  console.error('审核页启动失败', err);
  const root = qs('#app');
  if (root) {
    root.textContent = '';
    root.append(netEl, h('div', { class: 'rv-page' }, errorCard(err && err.message ? err.message : '页面启动失败', () => location.reload(), { title: '页面没能打开' })));
  }
});
