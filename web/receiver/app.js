import {
  ApiError, BOOT, banner, confirmDialog, copyText, createApi, emptyState, fmtAgo, fmtBytes, fmtTime,
  h, loading, live, modal, mount, progressBar, qs, setFavicon, statusPill, store, toast,
} from '/shared/ui.js';

const api = createApi({ label: '接收端' });
const ui = store('receiver-ui').read() || { lastHostUrl: '', lastName: '' };
const root = qs('#app');

const s = {
  state: null,
  loading: true,
  error: null,
  selfTest: null,
  selfTesting: false,
  expanded: null,
  showAdvanced: false,
  live: null,
  notified: new Set(store('receiver-notified').read() || []),
};

const CODE_KEYS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ------------------------------------------------------------------ helpers */

function errText(err) {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'network':
        return '连不上本机接收端服务，请确认接收端程序仍在运行。';
      case 'host_unreachable':
        return err.message;
      case 'pairing_expired':
        return '配对码已过期（有效期 10 分钟）。请让创作者重新生成一个。';
      case 'pairing_invalid':
        return '配对码不正确。请对照创作者电脑上的 6 位字母数字重新输入（不区分大小写）。';
      case 'pairing_used':
        return '这个配对码已经被用过，请让创作者重新生成。';
      case 'bad_code':
        return '配对码是 6 位字母和数字的组合。';
      case 'bad_host':
        return '地址格式不对。请填写创作者电脑上显示的地址，通常长这样：http://192.168.1.20:8780';
      case 'no_receive_root':
        return '请先选择这台电脑保存交付文件的文件夹。';
      case 'not_a_folder':
      case 'path_missing':
      case 'bad_workspace':
        return err.message;
      default:
        return err.message || '操作没有成功，请重试。';
    }
  }
  return err?.message || '出现了未知错误，请重试。';
}

async function refresh({ silent = false } = {}) {
  try {
    const next = await api.get('/api/state');
    s.state = next;
    s.error = null;
    if (!silent) s.loading = false;
    announceDeliveries(next);
    render();
    return next;
  } catch (err) {
    if (!silent) s.error = errText(err);
    s.loading = false;
    render();
    throw err;
  } finally {
    /* keep previous state on silent refresh failures */
  }
}

function announceDeliveries(state) {
  for (const d of state.deliveries || []) {
    if (s.notified.has(`${d.deliveryId}:${d.status}`)) continue;
    if (d.status === 'succeeded') {
      s.notified.add(`${d.deliveryId}:${d.status}`);
      toast(`${d.version?.code || '版本'} 已接收完成，保存在 ${d.targetDir}`, 'success', 9000);
    } else if (d.status === 'failed' && d.error?.message) {
      s.notified.add(`${d.deliveryId}:${d.status}`);
      toast(`接收失败：${d.error.message}`, 'error', 10000);
    }
  }
  store('receiver-notified').write([...s.notified]);
}

/* -------------------------------------------------------------------- shell */

function header(state) {
  const paired = state?.paired;
  const approved = state?.device?.approved;
  return h(
    'header',
    { class: 'app-header' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'LR'), h('div', {}, h('div', {}, '接收端'), h('div', { class: 'header-meta' }, state?.name || '这台电脑'))),
    paired
      ? h('span', { class: `pill ${approved ? 'pill-ok' : 'pill-warn'}` }, approved ? '已连接创作者电脑' : '等待创作者允许')
      : h('span', { class: 'pill' }, '尚未连接'),
    h('div', { class: 'header-spacer' }),
    paired ? h('button', { class: 'btn btn-ghost btn-sm', onClick: disconnect }, '取消连接') : null,
  );
}

async function disconnect() {
  const yes = await confirmDialog({
    title: '取消这台电脑的连接？',
    message: ['取消后需要创作者重新生成配对码才能继续接收文件。已经收到的文件不会被删除。'],
    confirmText: '确定取消连接',
    cancelText: '先不取消',
    danger: true,
  });
  if (!yes) return;
  try {
    await api.post('/api/unpair', {});
    toast('已取消连接');
    await refresh({ silent: true });
  } catch (err) {
    toast(errText(err), 'error', 8000);
  }
}

function render() {
  const state = s.state;
  document.title = state?.paired
    ? `接收端 · ${state.device?.approved ? '已连接' : '等待允许'}`
    : '接收端 · 连接创作者电脑';
  const children = [];
  children.push(header(state || {}));
  const page = h('div', { class: 'receiver-page stack' });
  children.push(page);

  if (s.loading && !state) {
    mount(page, loading('正在读取接收端状态…'));
    mount(root, ...children);
    return;
  }

  if (s.error) page.appendChild(banner('error', '读取状态失败', h('div', { class: 'row' }, h('span', { class: 'text-sm' }, s.error), h('button', { class: 'btn btn-sm', onClick: () => refresh({ silent: false }) }, '重试'))));

  if (!state) {
    page.appendChild(banner('warn', '还没有连接创作者电脑', '请按下面的步骤完成设置。'));
  }

  if (!state?.paired) {
    page.appendChild(setupHero());
    page.appendChild(setupSteps(state || {}));
  } else {
    page.appendChild(connectedPanel(state));
    if (!state.receiveRoot) page.appendChild(banner('warn', '还没有选择接收文件夹', '创作者交付文件前，需要先告诉这台电脑把文件保存在哪里。'));
    page.appendChild(deliveriesSection(state));
  }
  page.appendChild(aboutSection(state || {}));
  mount(root, ...children);
}

/* -------------------------------------------------------------------- setup */

function setupHero() {
  return h(
    'section',
    { class: 'hero' },
    h('div', { class: 'hero-badge' }, h('span', { class: 'dot dot-pending' }), '第 1 步：把这台电脑接到创作者的电脑上'),
    h('h1', {}, '这台电脑用来接收交付的成片'),
    h('p', {}, '审核通过后，创作者电脑会把「被批准的那一版文件」原样传输到这里。你只需要选一个保存位置，然后输入创作者电脑上显示的配对码。'),
    h('p', { class: 'text-sm muted' }, `接收端版本 ${BOOT.app?.version || '1.0.0'} · 只在你家/公司的局域网里工作，不需要联网，也不会上传到任何服务器。`),
  );
}

function setupSteps(state) {
  const hasRoot = !!state.receiveRoot && state.receiveRootExists !== false;
  const paired = !!state.paired;
  const approved = !!state.device?.approved;
  return h(
    'div',
    { class: 'setup-grid' },
    stepFolder(hasRoot, state),
    stepConnect(state, hasRoot, paired),
    stepWait(state, paired, approved),
  );
}

function stepFolder(hasRoot, state) {
  return h(
    'div',
    { class: 'setup-card', dataset: { state: hasRoot ? 'done' : 'active' } },
    h('div', { class: 'setup-head' }, h('span', { class: 'setup-index' }, hasRoot ? '✓' : '1'), h('h3', {}, '选择接收文件夹')),
    hasRoot
      ? h(
          'div',
          { class: 'stack gap-sm' },
          h('div', { class: 'path-chip', title: state.receiveRoot }, state.receiveRoot),
          h('div', { class: 'text-xs muted' }, state.receiveRootExists === false ? '这个文件夹当前不存在，请重新选择。' : `文件会保存在这里${state.receiveRootFree ? ` · 剩余 ${fmtBytes(state.receiveRootFree)}` : ''}`),
          h(
            'div',
            { class: 'btn-group' },
            h('button', { class: 'btn btn-sm', onClick: () => pickFolder() }, '换一个'),
            h('button', { class: 'btn btn-sm btn-ghost', onClick: () => reveal(state.receiveRoot) }, '打开'),
          ),
        )
      : h(
          'div',
          { class: 'stack' },
          h('p', { class: 'text-sm muted' }, '选一个你容易找的文件夹，例如桌面上的「客户交付」。'),
          h('button', { class: 'btn btn-primary btn-block', onClick: () => pickFolder() }, '选择文件夹'),
          h('button', { class: 'btn btn-ghost btn-sm btn-block', onClick: () => browseModal() }, '手动浏览文件夹'),
        ),
  );
}

function stepConnect(state, hasRoot, paired) {
  const locked = !hasRoot && !paired;
  return h(
    'div',
    { class: 'setup-card', dataset: { state: paired ? 'done' : locked ? 'locked' : 'active' } },
    h('div', { class: 'setup-head' }, h('span', { class: 'setup-index' }, paired ? '✓' : '2'), h('h3', {}, '连接创作者电脑')),
    h(
      'div',
      { class: 'stack' },
      h('p', { class: 'text-sm muted' }, paired ? `已连接：${state.hostUrl}` : '输入创作者电脑上「设备连接」页面显示的地址和 6 位配对码。'),
      paired
        ? h('div', { class: 'btn-group' }, h('button', { class: 'btn btn-sm', onClick: () => pairModal(true) }, '换一台创作者电脑'))
        : h(
            'div',
            { class: 'stack' },
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, '创作者电脑地址'), h('input', { class: 'input input-mono', id: 'host-input', placeholder: 'http://192.168.1.20:8780', value: ui.lastHostUrl || state.hostUrl || '' })),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, '配对码（6 位）'), h('input', { class: 'input code-input', id: 'code-input', maxlength: '6', placeholder: 'AB23CD', autocapitalize: 'characters', autocomplete: 'off', onInput: (e) => { e.target.value = cleanCode(e.target.value); } })),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, '这台电脑的名称'), h('input', { class: 'input', id: 'name-input', value: ui.lastName || state.name || '我的笔记本', placeholder: '例如：设计部笔记本' })),
            h('button', { class: 'btn btn-primary btn-block', onClick: () => doPair() }, '连接'),
            locked ? h('div', { class: 'text-xs muted' }, '请先完成第 1 步选择接收文件夹。') : null,
          ),
    ),
  );
}

function stepWait(state, paired, approved) {
  return h(
    'div',
    { class: 'setup-card', dataset: { state: approved ? 'done' : paired ? 'active' : 'locked' } },
    h('div', { class: 'setup-head' }, h('span', { class: 'setup-index' }, approved ? '✓' : '3'), h('h3', {}, '等待创作者允许')),
    h(
      'div',
      { class: 'stack' },
      !paired
        ? h('p', { class: 'text-sm muted' }, '完成上一步后，这里会显示等待状态。')
        : approved
          ? h('p', { class: 'text-sm' }, '已获授权。创作者审核通过后点击「正式交付」，文件会自动出现在这台电脑。')
          : h(
              'div',
              { class: 'waiting-panel' },
              h('span', { class: 'spinner' }),
              h('div', {}, h('div', { class: 'strong' }, '等待创作者点「允许」'), h('div', { class: 'text-sm muted' }, `请在创作者电脑的「设备连接」里，找到「${state.name || '这台设备'}」并点允许。这个页面会自动继续。`)),
            ),
      state.device?.status === 'revoked' ? banner('error', '创作者已取消这台设备的授权', h('button', { class: 'btn btn-sm', onClick: () => pairModal(false) }, '重新输入配对码')) : null,
    ),
  );
}

function cleanCode(value) {
  return String(value || '')
    .toUpperCase()
    .split('')
    .filter((c) => CODE_KEYS.includes(c))
    .slice(0, 6)
    .join('');
}

function pairModal(prefillHost) {
  const state = s.state || {};
  let hostInput = null;
  let codeInput = null;
  let nameInput = null;
  const dlg = modal({
    title: '连接创作者电脑',
    body: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted text-sm' }, '在创作者电脑的「设备连接」页面选择「接收设备」，会生成地址和 6 位配对码。'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '创作者电脑地址'), (hostInput = h('input', { class: 'input input-mono', placeholder: 'http://192.168.1.20:8780', value: prefillHost ? state.hostUrl || ui.lastHostUrl || '' : ui.lastHostUrl || '' }))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '配对码'), (codeInput = h('input', { class: 'input code-input', maxlength: '6', placeholder: 'AB23CD', autocapitalize: 'characters', onInput: (e) => { e.target.value = cleanCode(e.target.value); } }))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '这台电脑的名称'), (nameInput = h('input', { class: 'input', value: state.name || ui.lastName || '我的笔记本' }))),
    ),
    actions: [
      h('button', { class: 'btn', onClick: () => dlg.close() }, '取消'),
      h('button', { class: 'btn btn-primary', onClick: async (e) => {
        e.target.disabled = true;
        e.target.textContent = '正在连接…';
        const ok = await submitPair(hostInput.value, codeInput.value, nameInput.value);
        if (ok) dlg.close();
        else {
          e.target.disabled = false;
          e.target.textContent = '连接';
        }
      } }, '连接'),
    ],
  });
}

async function submitPair(hostUrl, code, name) {
  if (!code || code.length !== 6) {
    toast('请输入 6 位配对码', 'error');
    return false;
  }
  try {
    await api.post('/api/pair', { hostUrl: hostUrl.trim(), code, name: name.trim() });
    ui.lastHostUrl = hostUrl.trim();
    ui.lastName = name.trim();
    store('receiver-ui').write(ui);
    toast('已连接，等待创作者允许', 'success');
    await refresh({ silent: true });
    return true;
  } catch (err) {
    toast(errText(err), 'error', 9000);
    return false;
  }
}

function doPair() {
  const host = qs('#host-input');
  const code = qs('#code-input');
  const name = qs('#name-input');
  if (!host || !code) return;
  if (!code.value.trim()) {
    code.focus();
    toast('请输入创作者电脑上的 6 位配对码', 'error');
    return;
  }
  submitPair(host.value, code.value, name?.value || '');
}

async function pickFolder() {
  try {
    const res = await api.post('/api/receive-root/pick', {});
    if (res.ok) {
      toast(`接收文件夹已设为 ${res.path}`, 'success');
      await refresh({ silent: true });
      return;
    }
    if (res.cancelled) {
      if (res.reason) toast(res.reason, 'error', 7000);
      browseModal();
      return;
    }
    toast(res.reason || '没能打开文件夹选择窗口，请手动浏览', 'error', 7000);
    browseModal();
  } catch (err) {
    toast(errText(err), 'error', 8000);
    browseModal();
  }
}

async function browseModal() {
  let dir = s.state?.receiveRoot || '';
  const dlg = modal({
    title: '浏览并选择文件夹',
    wide: true,
    body: h('div', { id: 'browse-body' }, loading('正在读取文件夹…')),
    actions: [h('button', { class: 'btn', onClick: () => dlg.close() }, '关闭')],
  });
  await renderBrowse(dir, dlg);
}

async function renderBrowse(dir, dlg) {
  const box = qs('#browse-body');
  if (!box) return;
  mount(box, loading('正在读取文件夹…'));
  try {
    const data = await api.get(`/api/browse?dir=${encodeURIComponent(dir || '')}`);
    const crumbs = String(data.dir || '')
      .split(/[\\/]+/)
      .filter(Boolean);
    box.replaceChildren(
      h('div', { class: 'stack' },
        h('div', { class: 'path-trail' },
          h('button', { class: 'btn btn-sm btn-ghost', onClick: () => renderBrowse(crumbs.length > 1 ? data.parent : '', dlg) }, '↑ 上一级'),
          h('span', {}, data.dir),
        ),
        h('div', { class: 'row text-sm muted' }, h('span', {}, `${data.entries.filter((e) => !e.isDir).length} 个文件 · ${data.entries.filter((e) => e.isDir).length} 个文件夹`), data.free?.free ? h('span', {}, `· 剩余 ${fmtBytes(data.free.free)}`) : null),
        h(
          'div',
          { class: 'list scroll-y', style: { maxHeight: '46vh' } },
          ...(data.entries.length
            ? data.entries.map((e) =>
                h(
                  'div',
                  {
                    class: 'browse-row',
                    onClick: () => {
                      if (e.isDir) renderBrowse(e.path, dlg);
                    },
                  },
                  h('span', { class: 'file-icon' }, e.isDir ? '目' : (e.ext || '?').slice(0, 3)),
                  h('span', { class: 'grow truncate' }, e.name),
                  h('span', { class: 'text-xs muted nowrap' }, e.isDir ? '打开' : fmtBytes(e.size)),
                ),
              )
            : [h('div', { class: 'browse-row muted text-sm' }, '这个文件夹里没有子文件夹')]),
        ),
        h('div', { class: 'btn-group' },
          h('button', { class: 'btn btn-primary', onClick: async () => {
            try {
              await api.post('/api/receive-root/set', { path: data.dir });
              toast(`接收文件夹已设为 ${data.dir}`, 'success');
              dlg.close();
              await refresh({ silent: true });
            } catch (err) {
              toast(errText(err), 'error', 8000);
            }
          } }, '就保存在这个文件夹'),
          h('button', { class: 'btn', onClick: () => copyText(data.dir).then((ok) => toast(ok ? '路径已复制' : '复制失败，请手动选择', ok ? 'success' : 'error')) }, '复制路径'),
        ),
      ),
    );
  } catch (err) {
    box.replaceChildren(banner('error', '读取文件夹失败', h('div', { class: 'text-sm' }, errText(err))));
  }
}

async function reveal(target) {
  if (!target) return;
  try {
    const res = await api.post('/api/reveal', { path: target });
    if (!res.ok) toast('这台电脑不允许打开文件管理器，请手动前往该位置', 'error');
  } catch (err) {
    toast(errText(err), 'error', 7000);
  }
}

/* --------------------------------------------------------------- connected */

function connectedPanel(state) {
  const dev = state.device || {};
  const hostOk = state.host?.ok;
  return h(
    'section',
    { class: 'card stack' },
    h(
      'div',
      { class: 'row row-between wrap' },
      h('div', {},
        h('h2', {}, dev.approved ? '这台电脑已准备好接收交付' : '还差一步：让创作者点「允许」'),
        h('div', { class: 'text-sm muted' }, dev.approved
          ? `设备名「${state.name}」· 创作者电脑 ${state.hostUrl}`
          : '创作者电脑上会显示这台设备的名称，点允许后开始接收。'),
      ),
      h('div', { class: 'btn-group' },
        h('button', { class: 'btn btn-sm', onClick: () => runSelfTest() }, s.selfTesting ? '检测中…' : '检测连接'),
        h('button', { class: 'btn btn-sm btn-ghost', onClick: () => refresh() }, '刷新'),
      ),
    ),
    h(
      'div',
      { class: 'status-grid' },
      cell('创作者电脑', `${state.hostUrl}`, hostOk === false
        ? h('span', { class: 'pill pill-danger' }, '连不上')
        : hostOk
          ? h('span', { class: 'pill pill-ok' }, '可访问')
          : h('span', { class: 'pill' }, '尚未确认')),
      cell('这台设备名称', state.name || '-', h('button', { class: 'btn btn-sm btn-ghost', onClick: () => renameDevice() }, '改名')),
      cell('接收文件夹', state.receiveRoot || '尚未选择', h('div', { class: 'btn-group' },
        h('button', { class: 'btn btn-sm', onClick: () => pickFolder() }, '更改'),
        state.receiveRoot ? h('button', { class: 'btn btn-sm btn-ghost', onClick: () => reveal(state.receiveRoot) }, '打开') : null)),
      cell('授权状态', dev.approved ? '已允许' : dev.status === 'revoked' ? '已取消授权' : '等待允许',
        dev.approved ? statusPill('succeeded') : statusPill(dev.status || 'pending')),
    ),
    state.receiveRoot && state.receiveRootExists === false
      ? banner('warn', '接收文件夹当前不存在', '可能被移动或删除了，请重新选择一个文件夹。')
      : null,
    s.selfTest
      ? banner(s.selfTest.ok ? 'success' : 'error', s.selfTest.ok ? `连接正常（${s.selfTest.ms} 毫秒）` : '连接失败', h('div', { class: 'text-sm' }, s.selfTest.ok ? `已确认能访问 ${s.selfTest.host}` : `${s.selfTest.error || '无法访问'}；请确认创作者电脑开着、程序在运行，并且两台电脑连同一个网络。`))
      : null,
    !dev.approved && state.paired && dev.status !== 'revoked'
      ? h('div', { class: 'waiting-panel' }, h('span', { class: 'spinner' }), h('div', {}, h('div', { class: 'strong' }, '正在等待创作者确认'), h('div', { class: 'text-sm muted' }, '这个页面会自动刷新，无需手动操作。')))
      : null,
  );
}

function cell(label, value, right = null) {
  return h('div', { class: 'status-cell' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), right ? h('div', { class: 'row' }, right) : null);
}

async function runSelfTest() {
  s.selfTesting = true;
  render();
  try {
    s.selfTest = await api.post('/api/selftest', {});
  } catch (err) {
    s.selfTest = { ok: false, error: err.message };
  } finally {
    s.selfTesting = false;
    render();
  }
}

async function renameDevice() {
  const current = s.state?.name || '';
  let input = null;
  const dlg = modal({
    title: '修改这台电脑的名称',
    body: h('label', { class: 'field' }, h('span', { class: 'field-label' }, '名称会显示在创作者电脑的「设备连接」里'), (input = h('input', { class: 'input', value: current }))),
    actions: [
      h('button', { class: 'btn', onClick: () => dlg.close() }, '取消'),
      h('button', { class: 'btn btn-primary', onClick: async (e) => {
        const value = String(input.value || '').trim();
        if (!value) {
          toast('名称不能为空', 'error');
          return;
        }
        e.target.disabled = true;
        try {
          await api.post('/api/rename', { name: value });
          dlg.close();
          await refresh({ silent: true });
        } catch (err) {
          toast(errText(err), 'error');
          e.target.disabled = false;
        }
      } }, '保存'),
    ],
  });
}

/* -------------------------------------------------------------- deliveries */

function deliveriesSection(state) {
  const deliveries = [...(state.deliveries || [])].sort((a, b) => String(b.startedAt || b.finishedAt || '').localeCompare(String(a.startedAt || a.finishedAt || '')));
  const active = deliveries.filter((d) => ['offered', 'transferring', 'verifying', 'retrying'].includes(d.status));
  const lastDone = deliveries.find((d) => d.status === 'succeeded');
  const lastFailed = deliveries.find((d) => d.status === 'failed' || d.status === 'blocked');
  return h(
    'section',
    { class: 'stack' },
    h('div', { class: 'section-title' }, '交付记录'),
    lastDone && within(lastDone.finishedAt, 90_000)
      ? h(
          'div',
          { class: 'banner banner-success' },
          h('div', { class: 'grow' },
            h('div', { class: 'strong' }, `${lastDone.project?.name || '项目'} ${lastDone.version?.code || ''} 已接收完成`),
            h('div', { class: 'text-sm' }, `保存在 ${lastDone.targetDir} · ${lastDone.okCount}/${lastDone.fileCount} 个文件全部校验通过`),
          ),
          h('button', { class: 'btn btn-sm', onClick: () => reveal(lastDone.targetDir) }, '打开文件夹'),
        )
      : null,
    !lastDone && within(lastFailed?.finishedAt, 90_000) && lastFailed?.error
      ? banner('error', '上一次接收没有完成', h('div', { class: 'text-sm' }, lastFailed.error.message), h('button', { class: 'btn btn-sm', onClick: () => retry(lastFailed.deliveryId) }, '重试'))
      : null,
    active.length
      ? h('div', { class: 'card stack card-tight' }, ...active.map(deliveryRow))
      : null,
    deliveries.length
      ? h('div', { class: 'list' }, ...deliveries.filter((d) => !active.includes(d)).map(deliveryRow))
      : h('div', { class: 'card' }, emptyState('还没有收到任何交付文件', '创作者审核通过并点击「正式交付」后，文件会自动出现在这里。', h('button', { class: 'btn btn-sm', onClick: () => refresh() }, '刷新'))),
  );
}

function within(iso, ms) {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < ms;
}

function deliveryRow(d) {
  const active = ['offered', 'transferring', 'verifying', 'retrying'].includes(d.status);
  const percent = d.totalBytes ? (d.receivedBytes / d.totalBytes) * 100 : 0;
  const expanded = s.expanded === d.deliveryId;
  return h(
    'div',
    { class: 'list-item', style: { display: 'block' }, onClick: () => { s.expanded = expanded ? null : d.deliveryId; render(); } },
    h('div', { class: 'row row-between wrap' },
      h('div', { class: 'delivery-row-main' },
        h('div', { class: 'row wrap gap-sm' },
          h('span', { class: 'strong' }, `${d.project?.name || '项目'} · ${d.version?.code || ''}`),
          statusPill(d.status),
          d.error ? h('span', { class: 'pill pill-danger' }, '有问题') : null,
        ),
        h('div', { class: 'text-xs muted truncate', title: d.targetDir }, d.targetDir),
      ),
      h('div', { class: 'row gap-sm nowrap' },
        h('span', { class: 'text-xs muted' }, `${fmtBytes(d.receivedBytes)} / ${fmtBytes(d.totalBytes)}`),
        h('span', { class: 'text-xs muted' }, active ? '' : fmtTime(d.finishedAt || d.startedAt)),
      ),
    ),
    h('div', { class: 'delivery-bar' },
      progressBar(percent, d.status === 'succeeded' ? 'ok' : d.status === 'failed' || d.status === 'blocked' ? 'error' : ''),
      h('span', { class: 'text-xs muted' }, `${d.okCount}/${d.fileCount} 个文件`),
    ),
    d.error && expanded
      ? h('div', { class: 'text-sm', style: { color: 'var(--danger)', marginTop: '8px' } }, d.error.message)
      : null,
    expanded
      ? h('div', { class: 'stack', style: { marginTop: '12px' } },
          h('div', { class: 'item-list' }, ...(d.items || []).length
            ? (d.items || []).map((i) => h('div', { class: 'item-line' },
                h('span', { class: 'grow truncate', title: i.path || i.relPath }, i.name || i.relPath),
                h('span', { class: 'text-xs muted nowrap' }, fmtBytes(i.size)),
                i.sha256Ok ? h('span', { class: 'pill pill-ok' }, '校验通过') : h('span', { class: 'pill' }, '未完成'),
                i.resumed ? h('span', { class: 'pill pill-brand' }, '续传') : null,
              ))
            : [h('div', { class: 'text-sm muted' }, '还没有开始传输的文件')]),
          h('div', { class: 'btn-group' },
            h('button', { class: 'btn btn-sm', onClick: (e) => { e.stopPropagation(); reveal(d.targetDir); } }, '打开文件夹'),
            ['failed', 'stalled', 'blocked', 'retrying'].includes(d.status)
              ? h('button', { class: 'btn btn-sm btn-primary', onClick: (e) => { e.stopPropagation(); retry(d.deliveryId); } }, '重试接收')
              : null,
            h('button', { class: 'btn btn-sm btn-ghost', onClick: (e) => { e.stopPropagation(); copyText(d.targetDir).then(() => toast('路径已复制')); } }, '复制路径'),
          ),
        )
      : h('div', { class: 'text-xs muted', style: { marginTop: '6px' } }, expanded ? '收起详情' : '点击查看每个文件的校验结果'),
  );
}

async function retry(deliveryId) {
  try {
    await api.post(`/api/deliveries/${deliveryId}/retry`, {});
    toast('已通知创作者重新发起交付');
    setTimeout(() => refresh({ silent: true }), 1200);
    await refresh({ silent: true });
  } catch (err) {
    toast(errText(err), 'error', 9000);
  }
}

/* -------------------------------------------------------------------- about */

function aboutSection(state) {
  return h(
    'section',
    { class: 'card card-tight' },
    h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { s.showAdvanced = !s.showAdvanced; render(); } }, s.showAdvanced ? '收起本机信息 ▲' : '本机信息与排查 ▼'),
    s.showAdvanced
      ? h('div', { class: 'stack', style: { marginTop: '12px' } },
          h('dl', { class: 'kv' },
            h('dt', {}, '本机地址'), h('dd', {}, String(state.localUrl || `http://127.0.0.1:${BOOT.port || 8790}`)),
            h('dt', {}, '局域网地址'), h('dd', {}, String(state.lanUrl || '-')),
            h('dt', {}, '系统'), h('dd', {}, String(state.platform || navigator.platform || '-')),
            h('dt', {}, '本次启动'), h('dd', {}, fmtTime(state.startedAt)),
            h('dt', {}, '当前状态'), h('dd', {}, state?.device?.approved ? '等待交付' : state?.paired ? '等待创作者允许' : '尚未连接'),
          ),
          state.lastError ? h('div', {}, h('div', { class: 'strong text-sm' }, '最近一次错误'), h('div', { class: 'text-sm muted' }, `${fmtAgo(state.lastError.at)} · ${state.lastError.message}`)) : null,
          h('p', { class: 'text-xs muted' }, '排查建议：如果创作者电脑看不到这台设备，请确认两台电脑连的是同一个 Wi-Fi 或网线，并且这个页面保持打开（可以最小化）。'),
        )
      : null,
  );
}

/* --------------------------------------------------------------------- boot */

async function main() {
  setFavicon();
  try {
    await refresh();
  } catch {
    /* render() already shows the error */
  }
  s.live = live({
    url: '/api/events',
    onEvent: (kind) => {
      if (kind === 'delivery.progress' || kind === 'delivery.started' || kind === 'delivery.verifying') {
        refresh({ silent: true }).catch(() => {});
        return;
      }
      if (kind.startsWith('delivery.') || kind.startsWith('device.') || kind === 'receiveRoot.changed') {
        refresh({ silent: true }).catch(() => {});
      }
    },
    onPoll: async () => {
      await refresh({ silent: true }).catch(() => {});
    },
    intervalMs: 5000,
  });
}

main();
