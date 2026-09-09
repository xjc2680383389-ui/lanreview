import {
  ApiError, BOOT, banner, confirmDialog, copyText, createApi, debounce, emptyState, fileIcon,
  fmtAgo, fmtBytes, fmtClock, fmtTime, h, KIND_NAME, loading, modal, mount, onlineDot, parseHashParams,
  progressBar, promptDialog, qs, setFavicon, statusMeta, statusPill, store, toast,
} from '/shared/ui.js';

const api = createApi({ label: '创作者', creatorToken: BOOT.creatorToken || store('creator-token').read() || null });
const root = qs('#app');

const state = {
  booted: false,
  system: null,
  ws: null,
  projects: [],
  projectId: null,
  project: null,
  devices: null,
  deliveries: [],
  activity: [],
  kit: null,
  diag: null,
  tab: 'submit',
  versionId: null,
  versionDetail: null,
  draft: null,
  busy: {},
  errors: {},
  note: '',
  reviewers: new Set(),
  pairRole: 'reviewer',
  activePairing: null,
  deliverTarget: null,
  tracking: null,
  showToken: false,
  needsToken: false,
  tick: 0,
};

/* -------------------------------------------------------------------- utils */

function errText(err) {
  if (err instanceof ApiError) {
    if (err.code === 'network') return '连不上创作者电脑上的程序。请确认它还在运行（浏览器标签可以刷新）。';
    return err.message || '操作没有成功';
  }
  return err?.message || '出现了未知错误';
}

function withCk(url) {
  if (!url || BOOT.loopback) return url;
  const token = api.getCreatorToken() || BOOT.creatorToken;
  if (!token) return url;
  return url + (url.includes('?') ? '&' : '?') + `ck=${encodeURIComponent(token)}`;
}

function setBusy(key, value) {
  state.busy[key] = value;
  render();
}

async function run(key, fn) {
  setBusy(key, true);
  try {
    return await fn();
  } finally {
    setBusy(key, false);
  }
}

function fail(area, err) {
  state.errors[area] = errText(err);
  render();
  toast(errText(err), 'error', 8000);
}

const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
const folderName = (p) => basename(String(p).replace(/[\\/]+$/, ''));

/* ------------------------------------------------------------------- loaders */

async function loadShell() {
  const [system, wsInfo] = await Promise.all([api.get('/api/system'), api.get('/api/workspace')]);
  state.system = system;
  state.ws = wsInfo;
  state.booted = true;
  state.needsToken = !system.creator.loopback && !BOOT.creatorToken && !store('creator-token').read();
  if (wsInfo.workspace && !wsInfo.needsSetup) {
    await Promise.all([loadProjects(), loadDevices(), loadDeliveries(), loadActivity(), loadKit()]);
    if (!state.projectId && state.projects.length) selectProject(state.projects[0].id);
  }
  render();
}

async function loadProjects({ keep = true } = {}) {
  const { projects } = await api.get('/api/projects');
  state.projects = projects;
  if (keep && state.projectId) {
    const found = projects.find((p) => p.id === state.projectId);
    if (!found && projects.length) state.projectId = projects[0].id;
    if (!projects.length) state.projectId = null;
  }
}

async function loadProject(id = state.projectId) {
  if (!id) {
    state.project = null;
    state.draft = null;
    return;
  }
  const data = await api.get(`/api/projects/${id}`);
  state.project = data.project;
  state.versions = data.versions.map((v, i) => ({ ...v, isLatest: i === 0 }));
  state.draft = data.draft;
  state.folderExists = data.folderExists;
}

async function loadDevices() {
  const data = await api.get('/api/devices');
  state.devices = data;
  const diag = await api.get('/api/devices/diagnostics').catch(() => null);
  state.diag = diag;
}

async function loadDeliveries() {
  const { deliveries } = await api.get('/api/deliveries');
  state.deliveries = deliveries;
}

async function loadActivity() {
  const { activity } = await api.get('/api/activity?limit=14');
  state.activity = activity;
}

async function loadKit() {
  state.kit = await api.get('/api/receiver-kit').catch(() => ({ available: false }));
}

async function loadVersion(id = state.versionId) {
  if (!id) {
    state.versionDetail = null;
    return;
  }
  state.versionDetail = await api.get(`/api/versions/${id}`);
}

async function refreshAll({ silent = false } = {}) {
  try {
    await Promise.all([loadProjects(), loadDevices(), loadDeliveries(), loadActivity()]);
    await loadProject();
    await loadVersion();
    render();
  } catch (err) {
    if (!silent) fail('refresh', err);
  }
}

function selectProject(id) {
  state.projectId = id;
  state.versionId = null;
  state.versionDetail = null;
  state.tab = state.tab === 'settings' ? 'submit' : state.tab;
  Promise.all([loadProject(id), loadVersion(null)]).then(render).catch((err) => fail('project', err));
}

function selectVersion(id) {
  state.versionId = id;
  state.tab = 'versions';
  loadVersion(id).then(render).catch((err) => fail('version', err));
}

/* -------------------------------------------------------------------- render */

let focusKey = null;

function render() {
  const active = document.activeElement;
  focusKey = active && active.dataset ? active.dataset.key || null : null;
  const selStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;

  document.title = state.ws?.workspace ? `创作者 · ${folderName(state.ws.workspace.path)} · LAN Review` : '创作者 · LAN Review 提审与交付';

  let node;
  if (!state.booted) node = bootScreen();
  else if (state.needsToken) node = tokenGate();
  else if (!state.ws || state.ws.needsSetup || !state.ws.workspace) node = onboarding();
  else node = consoleView();

  mount(root, node);

  if (focusKey) {
    const el = qs(`[data-key="${focusKey}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (selStart !== null && typeof el.setSelectionRange === 'function') {
        try {
          el.setSelectionRange(selStart, selStart);
        } catch {
          /* input type may not support selection */
        }
      }
    }
  }
}

function bootScreen() {
  return h('div', { class: 'page' }, loading('正在连接本机服务…'));
}

function tokenGate() {
  let input = null;
  const submit = async () => {
    const value = String(input?.value || '').trim();
    if (!value) {
      toast('请输入创作者口令', 'error');
      return;
    }
    api.setCreatorToken(value);
    store('creator-token').write(value);
    state.needsToken = false;
    try {
      await loadShell();
      toast('口令正确，已连接', 'success');
    } catch (err) {
      store('creator-token').clear();
      api.setCreatorToken(null);
      state.needsToken = true;
      fail('token', err);
    }
  };
  return h(
    'div',
    { class: 'page page-narrow stack' },
    appHeader(),
    h(
      'div',
      { class: 'card stack' },
      h('h1', {}, '这是创作者页面'),
      h('p', { class: 'muted' }, '你正在从另一台设备访问创作者电脑的管控页面。为了不冲突，需要输入创作者口令。只是审核文件或接收交付文件的话，不需要这一步：请使用创作者电脑上显示的审核链接或接收端程序。'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '创作者口令'), (input = h('input', { class: 'input input-mono', type: 'password', 'data-key': 'token', placeholder: '在创作者电脑「设置」页可以看到', onKeydown: (e) => { if (e.key === 'Enter') submit(); } }))),
      h('button', { class: 'btn btn-primary', onClick: submit }, '进入'),
    ),
  );
}

/* ---------------------------------------------------------------- onboarding */

function onboarding() {
  const recent = state.ws?.recent || [];
  return h(
    'div',
    { class: 'page page-narrow stack' },
    appHeader(),
    h(
      'section',
      { class: 'card stack', style: { padding: '28px' } },
      h('span', { class: 'pill pill-brand' }, '第一次使用'),
      h('h1', {}, '选一个文件夹作为你的工作区'),
      h('p', { class: 'muted' }, '工作区就是你放项目文件的地方。之后每个项目都会在这里新建一个文件夹，提审记录、版本快照和交付历史也都跟着这个文件夹走，换一台电脑只要把工作区文件夹一起带走就行。'),
      h(
        'div',
        { class: 'btn-group' },
        h('button', { class: 'btn btn-primary btn-lg', disabled: state.busy.pick, onClick: () => pickWorkspace() }, state.busy.pick ? '等待选择…' : '选择工作区文件夹'),
        h('button', { class: 'btn btn-lg', disabled: state.busy.browse, onClick: () => browseModal({ title: '选择工作区文件夹', onPick: (path) => applyWorkspace(path) }) }, '手动浏览'),
      ),
      recent.length
        ? h(
            'div',
            { class: 'stack', style: { marginTop: '6px' } },
            h('div', { class: 'section-title', style: { margin: '10px 0 0' } }, '上次用过'),
            h('div', { class: 'list' }, ...recent.map((path) => h('div', { class: 'list-item', onClick: () => applyWorkspace(path) }, h('span', { class: 'grow truncate', title: path }, folderName(path)), h('span', { class: 'text-xs muted truncate' }, path), h('span', { class: 'pill' }, '打开')))),
          )
        : null,
      banner(
        'info',
        '这些不会被改动',
        h('ul', { class: 'hint-list' }, h('li', {}, '不会上传任何文件到互联网，也不需要账号。'), h('li', {}, '程序只在工作区里新建一个 .lanreview 文件夹，用来存记录和审核快照。'), h('li', {}, '你原有的文件不会被改名、移动或删除。')),
      ),
    ),
  );
}

async function pickWorkspace() {
  await run('pick', async () => {
    let res;
    try {
      res = await api.post('/api/workspace/pick', {});
    } catch (err) {
      toast(errText(err), 'error');
      browseModal({ title: '选择工作区文件夹', onPick: (path) => applyWorkspace(path) });
      return;
    }
    if (!res.ok) {
      toast(res.reason || '没有选择文件夹，请用页面里的文件夹浏览器选择', 'error', 7000);
      browseModal({ title: '选择工作区文件夹', onPick: (path) => applyWorkspace(path) });
      return;
    }
    await applyWorkspace(res.path);
  });
}

async function applyWorkspace(path) {
  await run('setWs', async () => {
    try {
      const info = await api.post('/api/workspace/set', { path });
      toast(`工作区已设为 ${folderName(info.workspace)}`, 'success');
      state.ws = { needsSetup: false, workspace: { path: info.workspace, exists: true } };
      await loadShell();
    } catch (err) {
      fail('workspace', err);
    }
  });
}

/* -------------------------------------------------------------------- header */

function appHeader() {
  const right = [];
  if (state.ws?.workspace) {
    right.push(
      h(
        'div',
        { class: 'ws-chip' },
        h('div', { class: 'col', style: { gap: '0' } }, h('span', { class: 'ws-name truncate', title: state.ws.workspace.path }, folderName(state.ws.workspace.path)), h('span', { class: 'ws-path', title: state.ws.workspace.path }, state.ws.workspace.path)),
        h('button', { class: 'btn btn-sm btn-ghost', title: '在文件管理器中打开工作区', onClick: () => api.post('/api/workspace/reveal', { path: state.ws.workspace.path }).catch((err) => toast(errText(err), 'error')) }, '打开'),
        h('button', { class: 'btn btn-sm', onClick: () => workspaceMenu() }, '更换'),
      ),
    );
  }
  const onlineCount = state.devices?.devices?.filter((d) => d.online).length || 0;
  right.push(
    h('div', { class: 'row gap-sm text-sm muted nowrap' }, onlineDot(onlineCount > 0), h('span', {}, `${onlineCount} 台设备在线`)),
  );
  return h(
    'header',
    { class: 'app-header' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'LR'), h('div', {}, h('div', {}, 'LAN Review 创作者'), h('div', { class: 'header-meta' }, `${state.system?.host?.name || BOOT.hostName || '创作者电脑'} · ${state.system?.host?.baseUrl || ''}`))),
    h('div', { class: 'header-spacer' }),
    ...right,
  );
}

function workspaceMenu() {
  let box = null;
  const dlg = modal({
    title: '工作区',
    body: (box = h('div', { class: 'stack' },
      h('div', { class: 'text-sm muted' }, '当前工作区'),
      h('code', { class: 'path-chip' }, state.ws.workspace.path),
      h('div', { class: 'btn-group' },
        h('button', { class: 'btn', onClick: () => { api.post('/api/workspace/reveal', { path: state.ws.workspace.path }).catch((e) => toast(errText(e), 'error')); } }, '打开工作区文件夹'),
        h('button', { class: 'btn', onClick: () => { copyText(state.ws.workspace.path).then(() => toast('路径已复制')); } }, '复制路径'),
      ),
      h('div', { class: 'divider' }),
      h('p', { class: 'text-sm muted' }, '工作区里的 .lanreview 文件夹存放：项目记录数据库、每次提审的不可变快照。请不要手动删除它；换电脑时把整个工作区一起拷贝即可。'),
      h('div', { class: 'btn-group' },
        h('button', { class: 'btn btn-primary', onClick: async () => { dlg.close(); await pickWorkspace(); } }, '选择别的工作区'),
        h('button', { class: 'btn', onClick: () => { dlg.close(); browseModal({ title: '选择工作区文件夹', onPick: (path) => applyWorkspace(path) }); } }, '手动浏览'),
      ),
    )),
    actions: [h('button', { class: 'btn', onClick: () => dlg.close() }, '关闭')],
  });
}

function browseModal({ title = '选择文件夹', startDir = '', onPick, onlyFolders = true }) {
  let current = startDir || state.ws?.workspace?.path || '';
  let box = null;
  const dlg = modal({
    title,
    wide: true,
    body: (box = h('div', { id: 'browse-host' }, loading('读取文件夹…'))),
    actions: [
      h('button', { class: 'btn', onClick: () => dlg.close() }, '取消'),
      h('button', { class: 'btn btn-primary', onClick: () => { dlg.close(); onPick(current); } }, '选择这个文件夹'),
    ],
  });
  const show = async (dir) => {
    box.replaceChildren(loading('读取文件夹…'));
    try {
      const data = await api.get(`/api/workspace/browse?dir=${encodeURIComponent(dir || '')}`);
      current = data.dir;
      box.replaceChildren(
        h('div', { class: 'stack' },
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn btn-sm', disabled: !data.parent, onClick: () => show(data.parent) }, '↑ 上一级'),
            h('code', { class: 'path-chip grow' }, data.dir),
            data.free?.free ? h('span', { class: 'text-xs muted nowrap' }, `剩余 ${fmtBytes(data.free.free)}`) : null,
          ),
          h('div', { class: 'row wrap gap-sm' }, ...(data.shortcuts || []).map((s) => h('button', { class: 'btn btn-sm btn-ghost', onClick: () => show(s.path) }, s.label))),
          h('div', { class: 'list scroll-y', style: { maxHeight: '48vh' } },
            ...(data.entries.length
              ? data.entries
                  .filter((e) => (onlyFolders ? e.isDir : true))
                  .map((e) => h('div', { class: 'browse-row', onDblclick: () => (e.isDir ? show(e.path) : null), onClick: () => { if (e.isDir) show(e.path); } },
                    h('span', { class: 'file-icon' }, e.isDir ? '目' : (e.ext || '?').slice(0, 3)),
                    h('span', { class: 'grow truncate' }, e.name),
                    h('span', { class: 'text-xs muted nowrap' }, e.isDir ? '' : fmtBytes(e.size))))
              : [h('div', { class: 'browse-row muted text-sm' }, '这个文件夹里没有可选的子文件夹')]),
            data.truncated ? h('div', { class: 'browse-row text-xs muted' }, '条目太多，仅显示前 800 个') : null,
          ),
        ),
      );
    } catch (err) {
      box.replaceChildren(banner('error', '读取失败', h('div', { class: 'text-sm' }, errText(err))));
    }
  };
  show(current);
}

/* ------------------------------------------------------------------ console */

function consoleView() {
  const tabs = [
    ['submit', '本次提审'],
    ['versions', `版本与反馈${state.versions?.length ? ` (${state.versions.length})` : ''}`],
    ['devices', `设备连接${state.devices?.pending?.length ? ` · ${state.devices.pending.length} 待允许` : ''}`],
    ['deliveries', '交付记录'],
    ['settings', '设置'],
  ];
  const main = h('div', { class: 'console-main stack' });
  main.appendChild(flowStrip());
  main.appendChild(
    h(
      'div',
      { class: 'tabs' },
      ...tabs.map(([key, label]) => h('button', { class: `tab${state.tab === key ? ' active' : ''}`, onClick: () => { state.tab = key; render(); } }, label)),
    ),
  );
  main.appendChild(h('div', { class: 'tab-panels' }, ...tabContent()));

  return h('div', { style: { padding: '0 20px 60px' } }, appHeader(), h('div', { class: 'console' }, sidePanel(), main));
}

function sidePanel() {
  const projects = state.projects || [];
  return h(
    'aside',
    { class: 'console-side' },
    h(
      'div',
      { class: 'card card-tight stack' },
      h('div', { class: 'row row-between' }, h('span', { class: 'card-title' }, '项目'), h('button', { class: 'btn btn-sm btn-primary', onClick: () => newProjectModal() }, '＋ 新建')),
      projects.length
        ? h('div', { class: 'side-scroll' }, ...projects.map((p) => projectItem(p)))
        : h('div', { class: 'text-sm muted' }, '还没有项目。新建一个项目文件夹，或选择已有的继续工作。'),
      h('button', { class: 'btn btn-sm btn-ghost', onClick: () => importProjectModal() }, '选择已有项目文件夹'),
    ),
    activityCard(),
  );
}

function projectItem(p) {
  const latest = p.latestVersion;
  return h(
    'button',
    { class: `project-item${state.projectId === p.id ? ' active' : ''}`, onClick: () => selectProject(p.id) },
    h('span', { class: 'p-name truncate' }, p.name),
    h('span', { class: 'p-meta truncate' }, [p.brand, p.project_date].filter(Boolean).join(' · ') || '未填品牌/日期'),
    h('span', { class: 'row wrap gap-sm' },
      h('span', { class: 'pill' }, `${p.versionCount} 个版本`),
      latest ? statusPill(latest.status) : h('span', { class: 'pill pill-outline' }, '未提审'),
      p.openComments ? h('span', { class: 'pill pill-warn' }, `${p.openComments} 条待处理`) : null,
      p.exists ? null : h('span', { class: 'pill pill-danger' }, '文件夹丢失'),
    ),
  );
}

function activityCard() {
  const items = (state.activity || []).slice(0, 9);
  return h(
    'div',
    { class: 'card card-tight' },
    h('div', { class: 'row row-between' }, h('span', { class: 'card-title' }, '动态'), h('button', { class: 'btn btn-sm btn-ghost', onClick: () => refreshAll() }, '刷新')),
    items.length
      ? h('div', { class: 'stack', style: { gap: '0' } }, ...items.map((a) => h('div', { class: 'activity-line' }, h('span', { class: 'activity-time' }, fmtAgo(a.ts)), h('span', { class: 'grow' }, a.message))))
      : h('div', { class: 'text-sm muted' }, '暂无操作记录'),
  );
}

function flowStrip() {
  const d = state.devices?.devices || [];
  const reviewers = d.filter((x) => x.status === 'approved' && ['reviewer', 'both'].includes(x.role));
  const receivers = d.filter((x) => x.status === 'approved' && (x.can_receive || ['receiver', 'both'].includes(x.role)));
  const versions = state.versions || [];
  const doneDelivery = state.deliveries.some((x) => x.status === 'succeeded');
  const steps = [
    { label: '选择工作区', done: true },
    { label: '新建或选择项目', done: !!state.projectId },
    { label: '选择待审文件', done: (state.draft?.count || 0) > 0 },
    { label: '连接审核设备', done: reviewers.length > 0 },
    { label: '提交 V01', done: versions.length > 0 },
    { label: '查看反馈', done: versions.some((v) => v.comments.length > 0) },
    { label: '修改后提交新版本', done: versions.length > 1 },
    { label: '等待审核通过', done: versions.some((v) => ['approved', 'delivered'].includes(v.status)) },
    { label: '选择接收电脑', done: receivers.length > 0 },
    { label: '正式交付', done: doneDelivery },
  ];
  const current = steps.findIndex((x) => !x.done);
  return h(
    'div',
    { class: 'flow-strip' },
    ...steps.flatMap((x, i) => [
      h('span', { class: `flow-step${x.done ? ' done' : i === current ? ' current' : ''}` }, x.done ? '✓' : i === current ? '●' : '○', ' ', x.label),
      i < steps.length - 1 ? h('span', { class: 'flow-arrow' }, '›') : null,
    ]),
  );
}

function tabContent() {
  if (!state.projectId) {
    return [h('div', { class: 'card' }, emptyState('还没有选择项目', '在左侧新建项目，或选择已有的项目文件夹继续工作。', h('button', { class: 'btn btn-primary', onClick: () => newProjectModal() }, '新建项目')))];
  }
  switch (state.tab) {
    case 'devices':
      return [devicesTab()];
    case 'deliveries':
      return [deliveriesTab()];
    case 'settings':
      return [settingsTab()];
    case 'versions':
      return [versionsTab()];
    default:
      return [submitTab()];
  }
}

/* --------------------------------------------------------------- submit tab */

function submitTab() {
  const draft = state.draft || { items: [], count: 0, totalBytes: 0, problems: [] };
  const reviewers = (state.devices?.devices || []).filter((x) => x.status === 'approved' && ['reviewer', 'both'].includes(x.role));
  const versions = state.versions || [];
  const nextCode = `V${String(versions.length + 1).padStart(2, '0')}`;
  const free = state.system?.workspace?.free?.free || 0;
  const spaceTight = free && draft.totalBytes > free * 0.6;

  return h(
    'div',
    { class: 'stack' },
    projectHeader(),
    h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'card-head' },
        h('span', { class: 'card-title' }, `本次待审清单（${draft.count} 个文件 · ${fmtBytes(draft.totalBytes)}）`),
        h('div', { class: 'header-spacer' }),
        h('button', { class: 'btn btn-sm', disabled: state.busy.addFile, onClick: () => addFromPicker() }, state.busy.addFile ? '等待选择…' : '＋ 添加文件或文件夹'),
        h('button', { class: 'btn btn-sm btn-ghost', onClick: () => addFromBrowser() }, '浏览选择'),
        draft.count ? h('button', { class: 'btn btn-sm btn-ghost', onClick: () => clearDraft() }, '清空') : null,
      ),
      draft.problems?.length
        ? banner('warn', `${draft.problems.length} 个文件已经不在原来的位置`, '提交前请先移除这些条目，或把文件放回去。')
        : null,
      spaceTight ? banner('warn', '工作区所在磁盘剩余空间不多', `本次要复制 ${fmtBytes(draft.totalBytes)}，剩余 ${fmtBytes(free)}。提交会为版本保存一份完整快照。`) : null,
      draft.count
        ? h('div', { class: 'stack', style: { gap: '6px' } }, ...draft.items.map((item) => draftRow(item)))
        : emptyState('还没有选择要审核的文件', '可以选整个项目文件夹，也可以只选几个文件。选好后提交，就会生成不可变的 V01 快照。'),
    ),
    h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, '选择审核设备'), h('div', { class: 'header-spacer' }), h('button', { class: 'btn btn-sm btn-ghost', onClick: () => { state.tab = 'devices'; render(); } }, '设备连接')),
      reviewers.length
        ? h('div', { class: 'grid-auto' }, ...reviewers.map((dev) => reviewerCheck(dev)))
        : banner('info', '还没有已授权的审核设备', h('div', { class: 'text-sm' }, '在「设备连接」里生成配对码，让对方用手机浏览器或电脑浏览器扫码连接，你点允许后即可提审。')),
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, `本次版本说明（会显示给审核者，${nextCode}）`),
        h('textarea', { class: 'textarea', 'data-key': 'note', placeholder: '例如：按上次的意见调整了主视觉亮度，文案见 PDF', value: state.note, onInput: (e) => { state.note = e.target.value; } }),
      ),
      h('div', { class: 'row row-between wrap' },
        h('span', { class: 'text-sm muted' }, versions.length ? `这是第 ${versions.length + 1} 次提审，旧版本和旧意见都会保留。` : '提交后文件会复制一份作为 V01 快照，之后修改工作文件不会影响它。'),
        h('button', {
          class: 'btn btn-primary btn-lg',
          disabled: !draft.count || !state.reviewers.size || state.busy.submit,
          onClick: () => doSubmit(),
        }, state.busy.submit ? '正在生成快照…' : `提交 ${nextCode} 进行审核`),
      ),
      (!draft.count || !state.reviewers.size) ? h('div', { class: 'text-xs muted' }, '需要：至少 1 个文件 + 至少 1 台已授权的审核设备。') : null,
    ),
  );
}

function projectHeader() {
  const p = state.project;
  if (!p) return null;
  return h(
    'div',
    { class: 'card card-tight row row-between wrap' },
    h('div', { class: 'col', style: { gap: '2px' } },
      h('div', { class: 'row gap-sm wrap' }, h('h2', {}, p.name), p.brand ? h('span', { class: 'pill' }, p.brand) : null, p.project_date ? h('span', { class: 'pill pill-outline' }, p.project_date) : null),
      h('code', { class: 'path-chip', title: p.folder_path }, p.folder_path),
      state.folderExists === false ? h('span', { class: 'text-xs', style: { color: 'var(--danger)' } }, '这个项目文件夹当前不在工作区里，可能被移动或删除了。') : null,
    ),
    h('div', { class: 'btn-group' },
      h('button', { class: 'btn btn-sm', onClick: () => api.post('/api/workspace/reveal', { path: p.folder_path }).catch((e) => toast(errText(e), 'error')) }, '打开项目文件夹'),
      h('button', { class: 'btn btn-sm btn-ghost', onClick: () => editProjectModal(p) }, '项目信息'),
    ),
  );
}

function draftRow(item) {
  const cls = !item.exists ? 'file-row missing' : '';
  return h('div', { class: cls },
    fileIcon(item.kind, item.ext || item.name.split('.').pop()),
    h('div', { class: 'grow', style: { minWidth: 0 } },
      h('div', { class: 'f-name truncate', title: item.relPath }, item.name),
      h('div', { class: 'f-meta truncate' }, `${item.relPath} · ${KIND_NAME[item.kind] || '文件'} · ${item.exists ? fmtBytes(item.size) : '文件不见了'}`),
    ),
    item.preview === 'inline' ? h('span', { class: 'pill pill-ok' }, '可预览') : item.preview === 'maybe' ? h('span', { class: 'pill pill-warn' }, '部分可播') : h('span', { class: 'pill pill-outline' }, '需下载'),
    h('button', { class: 'btn btn-sm btn-ghost', title: '从本次清单移除', onClick: () => removeFromDraft(item) }, '移除'),
  );
}

function reviewerCheck(dev) {
  const checked = state.reviewers.has(dev.id);
  return h('label', { class: `checkbox${checked ? ' selected' : ''}` },
    h('input', { type: 'checkbox', checked, onChange: (e) => { if (e.target.checked) state.reviewers.add(dev.id); else state.reviewers.delete(dev.id); render(); } }),
    h('span', { class: 'grow' },
      h('span', { class: 'strong' }, dev.name),
      h('span', { class: 'row gap-sm text-xs muted wrap' }, onlineDot(dev.online), h('span', {}, dev.online ? '在线' : `最近在线 ${fmtAgo(dev.last_seen_at)}`)),
    ),
  );
}

async function addFromPicker() {
  await run('addFile', async () => {
    try {
      const res = await api.post(`/api/projects/${state.projectId}/draft/pick`, { startDir: state.project?.folder_path });
      if (!res.ok) {
        toast(res.reason || '没有选择文件夹，可用「浏览选择」', 'error', 6000);
        return;
      }
      state.draft = { ...res };
      toast(`已加入清单：${res.count} 个文件`, 'success');
      render();
    } catch (err) {
      const message = err instanceof ApiError && (err.code === 'source_missing' || err.code === 'not_a_folder') ? err.message : `系统选择窗口不可用（${errText(err)}），请改用「浏览选择」`;
      toast(message, 'error', 7000);
      addFromBrowser();
    }
  });
}

function addFromBrowser() {
  browseModal({
    title: '把整个文件夹加入本次待审清单',
    startDir: state.project?.folder_path || state.ws?.workspace?.path,
    onPick: async (path) => {
      try {
        const draft = await api.post(`/api/projects/${state.projectId}/draft/add`, { dir: path });
        state.draft = draft;
        toast(`清单现在共 ${draft.count} 个文件 · ${fmtBytes(draft.totalBytes)}`, 'success');
        render();
      } catch (err) {
        fail('draft', err);
      }
    },
  });
}

async function removeFromDraft(item) {
  try {
    state.draft = await api.post(`/api/projects/${state.projectId}/draft/remove`, { sourcePath: item.sourcePath });
    render();
  } catch (err) {
    fail('draft', err);
  }
}

async function clearDraft() {
  const yes = await confirmDialog({ title: '清空本次待审清单？', message: ['只是清空清单，不会删除任何文件。已经提交过的版本不受影响。'], confirmText: '清空' });
  if (!yes) return;
  try {
    state.draft = await api.post(`/api/projects/${state.projectId}/draft/remove`, { clearAll: true });
    render();
  } catch (err) {
    fail('draft', err);
  }
}

async function doSubmit() {
  const reviewers = [...state.reviewers];
  await run('submit', async () => {
    try {
      const version = await api.post(`/api/projects/${state.projectId}/submit`, { deviceIds: reviewers, note: state.note });
      state.note = '';
      toast(`${version.code} 已提交，${version.assignments.length} 台审核设备会立刻收到任务`, 'success', 7000);
      await loadProject();
      selectVersion(version.id);
      await Promise.all([loadActivity(), loadDevices()]);
      render();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'no_reviewers') toast('请先选择至少一台审核设备', 'error');
      else if (err instanceof ApiError && err.code === 'files_missing') toast('清单里有文件不见了，请先移除或放回原位', 'error', 8000);
      else fail('submit', err);
    }
  });
}

/* -------------------------------------------------------------- versions tab */

function versionsTab() {
  const versions = state.versions || [];
  if (!versions.length) {
    return h('div', { class: 'card' }, emptyState('还没有提交过审核版本', '在「本次提审」里选好文件和设备，提交后就会生成 V01。', h('button', { class: 'btn btn-primary', onClick: () => { state.tab = 'submit'; render(); } }, '去做第一次提审')));
  }
  const detail = state.versionDetail;
  return h('div', { class: 'two-col' },
    h('div', { class: 'stack' }, ...versions.map((v) => versionCard(v, detail?.id === v.id))),
    detail ? versionDetail(detail) : h('div', { class: 'card' }, emptyState('选择左侧的版本', '可以看到文件、意见、审核结论，以及正式交付入口。')),
  );
}

function versionCard(v, selected) {
  const pending = v.stats.pendingReviewerCount;
  return h('div', { class: `version-card${v.isLatest ? ' latest' : ''}${selected ? ' selected' : ''}`, onClick: () => selectVersion(v.id) },
    h('div', { class: 'row row-between wrap' },
      h('div', { class: 'row gap-sm wrap' }, h('span', { class: 'version-code' }, v.code), statusPill(v.status), v.isLatest ? h('span', { class: 'pill pill-brand' }, '最新') : null),
      h('span', { class: 'text-xs muted' }, fmtTime(v.submitted_at)),
    ),
    v.note ? h('div', { class: 'version-note' }, v.note) : null,
    h('div', { class: 'row wrap gap-sm text-xs muted' },
      h('span', {}, `${v.stats.fileCount} 个文件 · ${fmtBytes(v.stats.totalBytes)}`),
      h('span', { class: 'dot-sep' }, '·'),
      h('span', {}, `${v.stats.commentCount} 条意见${v.stats.openCommentCount ? `（${v.stats.openCommentCount} 条未处理）` : ''}`),
      h('span', { class: 'dot-sep' }, '·'),
      h('span', {}, pending ? `还有 ${pending} 位审核人未回复` : `${v.stats.reviewerCount} 位审核人已回复`),
    ),
    v.deliveries.length ? h('div', { class: 'row wrap gap-sm' }, ...v.deliveries.slice(0, 3).map((d) => h('span', { class: 'pill pill-outline' }, `${d.device_name} ${statusMeta(d.status).label}`))) : null,
  );
}

function versionDetail(v) {
  const open = v.comments.filter((c) => !c.resolved_at);
  const canDeliver = ['approved', 'delivered'].includes(v.status);
  const receivers = (state.devices?.devices || []).filter((d) => d.status === 'approved' && (d.can_receive || ['receiver', 'both'].includes(d.role)));
  const detail = parseDetailIntegrity(v);
  return h('div', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('div', { class: 'row row-between wrap' },
        h('div', { class: 'row gap-sm wrap' }, h('h2', {}, `${v.code} 版本详情`), statusPill(v.status)),
        h('div', { class: 'btn-group' },
          h('button', { class: 'btn btn-sm', onClick: () => reuseForNext(v) }, '沿用这版文件重新提审'),
          h('button', { class: 'btn btn-sm btn-ghost', disabled: state.busy.verify, onClick: () => verifyVersion(v) }, state.busy.verify ? '校验中…' : '校验快照'),
        ),
      ),
      v.note ? h('div', { class: 'version-note' }, v.note) : null,
      h('dl', { class: 'kv' },
        h('dt', {}, '提交时间'), h('dd', {}, fmtTime(v.submitted_at)),
        h('dt', {}, '文件'), h('dd', {}, `${v.stats.fileCount} 个 · ${fmtBytes(v.stats.totalBytes)}`),
        h('dt', {}, '审核人'), h('dd', {}, v.assignments.map((a) => `${a.device_name}${a.device_status !== 'approved' ? '（未授权）' : ''}`).join('、') || '未指定'),
        h('dt', {}, '结论'), h('dd', {}, v.reviews.length ? v.reviews.map((r) => `${r.device_name || '审核者'}：${r.decision === 'pass' ? '通过' : '需要修改'}`).join('；') : '等待审核'),
        h('dt', {}, '快照位置'), h('dd', {}, h('code', { class: 'path-chip' }, v.snapshot_dir)),
        detail.sourceChanged ? h('dt', {}, '工作文件') : null,
        detail.sourceChanged ? h('dd', {}, h('span', { style: { color: 'var(--warn)' } }, `${detail.sourceChanged} 个源文件在提交之后又被修改过 —— 交付时仍使用这个版本的快照，不会误交最新版`)) : null,
      ),
      v.integrity === 'broken'
        ? banner('error', '这个版本的快照校验不通过', h('div', { class: 'text-sm' }, '文件内容与提交时记录的校验值不一致，交付会被阻止。请检查 .lanreview/submissions 是否被移动或清理。'), h('button', { class: 'btn btn-sm', onClick: () => verifyVersion(v) }, '重新校验'))
        : v.integrity === 'ok'
          ? banner('success', '快照校验通过', h('div', { class: 'text-sm' }, '这个版本的内容与提交时完全一致，可以放心交付。'))
          : null,
      v.status === 'changes_requested'
        ? banner('warn', '审核者要求修改', h('div', { class: 'text-sm' }, open.length ? `还有 ${open.length} 条意见没标记处理。改完工作文件后，点上方「沿用这版文件重新提审」提交新版本。` : '意见都已处理，改完可以提交新版本。'))
        : null,
      v.status === 'reviewing' && v.stats.pendingReviewerCount
        ? banner('info', `等待 ${v.stats.pendingReviewerCount} 位审核人回复`, h('div', { class: 'text-sm' }, '所有被指派的审核人都给出结论后，这个版本才会变成「审核通过」。'), h('button', { class: 'btn btn-sm', onClick: () => reassignModal(v) }, '调整审核人'))
        : null,
    ),
    filesCard(v),
    commentsCard(v),
    canDeliver ? deliverCard(v, receivers) : null,
    v.deliveries.length ? deliveriesCard(v.deliveries, v) : null,
  );
}

function parseDetailIntegrity(v) {
  try {
    return JSON.parse(v.integrity_detail || '{}');
  } catch {
    return {};
  }
}

function filesCard(v) {
  return h('div', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, `文件（${v.files.length}）`)),
    ...v.files.map((f) => {
      const cs = v.comments.filter((c) => c.file_id === f.id);
      return h('div', { class: 'file-row' },
        fileIcon(f.kind, f.ext),
        h('div', { class: 'grow', style: { minWidth: 0 } },
          h('div', { class: 'f-name truncate', title: f.rel_path }, f.rel_path),
          h('div', { class: 'f-meta' }, `${fmtBytes(f.size)} · ${KIND_NAME[f.kind] || '文件'}${cs.length ? ` · ${cs.length} 条意见` : ''}`),
        ),
        f.preview !== 'none' ? h('button', { class: 'btn btn-sm', onClick: () => viewerModal(v, f) }, '预览') : h('span', { class: 'pill pill-outline', title: f.preview_note || '' }, '不可预览'),
        h('button', { class: 'btn btn-sm btn-ghost', onClick: () => downloadCreatorFile(v, f) }, '下载'),
      );
    }),
  );
}

function commentsCard(v) {
  const groups = new Map();
  for (const c of v.comments) {
    const key = c.file_id || '__overall__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const label = (fileId) => (fileId === '__overall__' ? '整体意见' : v.files.find((f) => f.id === fileId)?.rel_path || '文件');
  return h('div', { class: 'card stack' },
    h('div', { class: 'card-head' },
      h('span', { class: 'card-title' }, `意见（${v.comments.length}）`),
      v.stats.openCommentCount ? h('span', { class: 'pill pill-warn' }, `${v.stats.openCommentCount} 条未处理`) : null,
    ),
    v.comments.length
      ? h('div', { class: 'stack' }, ...[...groups.entries()].map(([fileId, list]) => h('div', { class: 'stack', style: { gap: '8px' } },
          h('div', { class: 'text-xs strong muted' }, label(fileId)),
          ...list.map((c) => h('div', { class: `comment-card${c.resolved_at ? ' resolved' : ''}` },
            h('div', { class: 'comment-head' },
              h('span', { class: 'strong' }, c.device_name || '审核者'),
              h('span', {}, fmtTime(c.created_at)),
              c.timecode !== null && c.timecode !== undefined ? h('button', { class: 'timecode-chip', onClick: () => jumpToTimecode(v, c) }, `▶ ${fmtClock(c.timecode)}`) : null,
              h('span', { class: 'header-spacer' }),
              h('button', { class: 'btn btn-sm btn-ghost', onClick: () => resolveComment(c) }, c.resolved_at ? '取消标记' : '标记已处理'),
            ),
            h('div', { class: 'comment-body' }, c.body),
          )))))
      : emptyState('还没有收到意见', '审核者在手机或笔记本上写的意见会实时出现在这里。'),
  );
}

function jumpToTimecode(v, c) {
  const f = v.files.find((x) => x.id === c.file_id);
  if (!f) {
    toast('这个意见对应的文件已经不在这个版本里了', 'error');
    return;
  }
  viewerModal(v, f, c.timecode);
}

function deliverCard(v, receivers) {
  return h('div', { class: 'card stack', style: { borderColor: '#bfe6d2' } },
    h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, '正式交付'), statusPill(v.status)),
    h('p', { class: 'text-sm muted' }, '交付的是这个版本提交时的快照文件，不会带上之后又改动的工作文件。'),
    h('div', { class: 'row row-between wrap' },
      h('span', { class: 'text-sm' }, `${v.stats.fileCount} 个文件 · ${fmtBytes(v.stats.totalBytes)}`),
      h('button', {
        class: 'btn btn-primary',
        disabled: !receivers.length || state.busy.deliver,
        onClick: () => deliverModal(v, receivers),
      }, state.busy.deliver ? '正在发起…' : '选择接收电脑并交付'),
    ),
    !receivers.length ? banner('info', '还没有可接收文件的电脑', '请在「设备连接」里生成「接收设备」配对码，让笔记本打开接收端程序连接。') : null,
  );
}

function deliveriesCard(list, v) {
  const rows = (list || []).map((d) => ({ ...d, project_name: state.project?.name || '项目', version_code: v.code }));
  return h('div', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, '这个版本的交付记录')),
    ...rows.map((d) => deliveryRow(d, true)),
  );
}

async function verifyVersion(v) {
  await run('verify', async () => {
    try {
      const res = await api.post(`/api/versions/${v.id}/verify`, { touchSources: true });
      if (res.integrity === 'ok' && !res.sourceChanged) toast('快照校验通过，工作文件也没有变化', 'success');
      else if (res.integrity === 'ok') toast(`快照没问题，但 ${res.sourceChanged} 个源文件在提交后又改过`, 'info', 8000);
      else toast('快照校验不通过，详情见版本卡片', 'error', 9000);
      await loadVersion(v.id);
      render();
    } catch (err) {
      fail('verify', err);
    }
  });
}

async function reuseForNext(v) {
  try {
    const draft = await api.post(`/api/projects/${state.projectId}/draft/add`, { paths: v.files.map((f) => f.source_path) });
    state.draft = draft;
    state.tab = 'submit';
    toast(`已把这 ${v.files.length} 个文件放进本次清单，改完直接提交新版本`, 'success', 7000);
    render();
  } catch (err) {
    fail('reuse', err);
  }
}

async function resolveComment(c) {
  try {
    await api.post(`/api/comments/${c.id}/resolve`, { resolved: !c.resolved_at });
    await loadVersion(state.versionId);
    render();
  } catch (err) {
    fail('comment', err);
  }
}

function downloadCreatorFile(v, f) {
  const url = withCk(`/api/creator/media/${v.id}/${f.id}?download=1`);
  const a = h('a', { href: url, download: f.display_name });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* -------------------------------------------------------------- viewer modal */

function viewerModal(v, f, startTime = null) {
  const mediaUrl = withCk(`/api/creator/media/${v.id}/${f.id}`);
  let body = null;
  const info = h('div', { class: 'row wrap gap-sm text-xs muted' }, h('span', {}, f.rel_path), h('span', {}, fmtBytes(f.size)), h('span', {}, f.sha256.slice(0, 12)));
  switch (f.kind) {
    case 'image':
      body = h('div', { class: 'modal-file-viewer' }, h('img', { src: mediaUrl, alt: f.display_name }));
      break;
    case 'video':
      body = h('div', { class: 'modal-file-viewer' }, h('video', {
        src: mediaUrl,
        controls: true,
        playsinline: true,
        preload: 'metadata',
        onLoadedmetadata: (e) => { if (startTime) e.target.currentTime = Number(startTime); },
      }));
      break;
    case 'audio':
      body = h('div', { class: 'modal-file-viewer' }, h('audio', {
        src: mediaUrl,
        controls: true,
        style: { width: '100%' },
        onLoadedmetadata: (e) => { if (startTime) e.target.currentTime = Number(startTime); },
      }));
      break;
    case 'pdf':
      body = h('div', { class: 'modal-file-viewer' }, h('iframe', { src: mediaUrl, title: f.display_name }));
      break;
    default:
      body = h('div', { class: 'stack' }, h('div', { id: 'text-slot' }, loading('读取内容…')), info);
  }
  const dlg = modal({
    title: `${f.display_name}（${v.code}）`,
    wide: true,
    body: h('div', { class: 'stack' },
      f.preview === 'none' ? banner('warn', '这个文件类型无法在浏览器里预览', h('div', { class: 'text-sm' }, f.preview_note || '请下载后用对应的软件打开。')) : null,
      body,
      info,
    ),
    actions: [
      h('button', { class: 'btn', onClick: () => downloadCreatorFile(v, f) }, '下载这个文件'),
      h('button', { class: 'btn btn-primary', onClick: () => dlg.close() }, '关闭'),
    ],
  });
  if (f.kind === 'text' || ['csv', 'tsv'].includes(f.ext)) {
    api.get(`/api/creator/text/${v.id}/${f.id}`).then((data) => {
      const slot = qs('#text-slot');
      if (!slot) return;
      slot.replaceChildren(data.binary
        ? h('div', { class: 'text-sm muted' }, '这是一个二进制文件，无法按文本显示，请下载后查看。')
        : h('pre', { class: 'modal-file-viewer', style: { padding: '12px' } }, data.text || '（空文件）'));
    }).catch((err) => {
      const slot = qs('#text-slot');
      if (slot) slot.replaceChildren(banner('error', '读取失败', h('div', { class: 'text-sm' }, errText(err))));
    });
  }
}

/* ---------------------------------------------------------------- devices tab */

function devicesTab() {
  const devices = state.devices?.devices || [];
  const pending = state.devices?.pending || [];
  const approved = devices.filter((d) => d.status === 'approved');
  return h('div', { class: 'stack' },
    pairPanel(),
    pending.length
      ? h('div', { class: 'card stack', style: { borderColor: '#f2dcae' } },
          h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, `等待允许的设备（${pending.length}）`)),
          ...pending.map((d) => deviceCard(d, true)),
        )
      : null,
    h('div', { class: 'card stack' },
      h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, `已连接设备（${approved.length}）`), h('div', { class: 'header-spacer' }), h('button', { class: 'btn btn-sm btn-ghost', onClick: () => refreshAll() }, '刷新')),
      approved.length ? h('div', { class: 'stack' }, ...approved.map((d) => deviceCard(d, false))) : emptyState('还没有已授权的设备', '手机用浏览器扫码即可参与审核；要接收成片的那台电脑需要先安装接收端（下面有安装包）。'),
    ),
    diagnosticsCard(),
    receiverKitCard(),
  );
}

function pairPanel() {
  const pairing = state.activePairing;
  const remaining = pairing ? Math.max(0, Math.floor((Date.parse(pairing.expiresAt) - Date.now()) / 1000)) : 0;
  return h('div', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, '连接新设备'), h('div', { class: 'header-spacer' }),
      h('div', { class: 'row gap-sm' },
        h('button', { class: `btn btn-sm${state.pairRole === 'reviewer' ? ' btn-primary' : ''}`, onClick: () => { state.pairRole = 'reviewer'; render(); } }, '审核设备（手机/电脑浏览器）'),
        h('button', { class: `btn btn-sm${state.pairRole === 'receiver' ? ' btn-primary' : ''}`, onClick: () => { state.pairRole = 'receiver'; render(); } }, '接收设备（笔记本）'),
      )),
    !pairing
      ? h('div', { class: 'stack' },
          h('p', { class: 'text-sm muted' }, state.pairRole === 'reviewer'
            ? '让对方用手机或笔记本的浏览器扫码，输入这个名字后点连接，你在这里点允许即可。不需要安装任何东西。'
            : '这台笔记本需要先运行「接收端」程序（下面有安装包和说明）。打开接收端后输入地址和配对码，再回到这里点允许。'),
          h('div', { class: 'btn-group' }, h('button', { class: 'btn btn-primary', disabled: state.busy.pair, onClick: () => createPairing() }, state.busy.pair ? '正在生成…' : '生成配对码和二维码')),
        )
      : h('div', { class: 'pair-panel' },
          h('div', { class: 'qr-frame' }, h('img', { src: withCk(pairing.qrPath), alt: '配对二维码', width: 190, height: 190 })),
          h('div', { class: 'stack', style: { gap: '8px' } },
            h('div', { class: 'text-sm muted' }, state.pairRole === 'reviewer' ? '用手机相机或任意扫码工具扫这个二维码' : '让笔记本浏览器打开下面的地址'),
            h('div', { class: 'code-display' }, pairing.code),
            h('div', { class: 'text-xs muted' }, remaining > 0 ? `${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒后过期 · 用一次即失效` : '已过期，请重新生成'),
            h('code', { class: 'path-chip', style: { maxWidth: '100%' }, title: pairing.url }, pairing.url),
            h('div', { class: 'btn-group' },
              h('button', { class: 'btn btn-sm', onClick: () => copyText(pairing.url).then((ok) => toast(ok ? '地址已复制' : '复制失败，请手动输入', ok ? 'success' : 'error')) }, '复制连接地址'),
              h('button', { class: 'btn btn-sm btn-ghost', onClick: () => createPairing() }, '换一个'),
              h('button', { class: 'btn btn-sm btn-ghost', onClick: () => cancelPairing() }, '取消配对码'),
            ),
            h('div', { class: 'text-xs muted' }, '没有扫码条件？让对方在浏览器地址栏输入下面地址，再把页面上的 6 位配对码填进去即可。'),
            remaining > 0 ? null : banner('warn', '这个配对码已经过期', '点「换一个」重新生成。'),
          ),
        ),
  );
}

async function createPairing() {
  await run('pair', async () => {
    try {
      const created = await api.post('/api/devices/pairing', { role: state.pairRole, canReceive: state.pairRole === 'receiver', label: state.pairRole === 'reviewer' ? '审核' : '接收' });
      state.activePairing = created;
      startPairingTicker();
      render();
    } catch (err) {
      fail('pair', err);
    }
  });
}

async function cancelPairing() {
  if (!state.activePairing) return;
  try {
    await api.post('/api/devices/pairing/cancel', { code: state.activePairing.code });
  } catch {
    /* already consumed */
  }
  state.activePairing = null;
  await loadDevices().catch(() => {});
  render();
}

let pairTicker = null;
function startPairingTicker() {
  if (pairTicker) clearInterval(pairTicker);
  pairTicker = setInterval(() => {
    if (!state.activePairing) {
      clearInterval(pairTicker);
      pairTicker = null;
      return;
    }
    const left = Date.parse(state.activePairing.expiresAt) - Date.now();
    if (left <= 0) {
      state.activePairing = null;
      loadDevices().catch(() => {});
    }
    render();
  }, 1000);
}

function deviceCard(d, isPending) {
  const tasks = (d.assignedVersions || []).slice(0, 2);
  return h('div', { class: `device-card${isPending ? ' pending' : ''}${!d.online && !isPending ? ' offline' : ''}` },
    h('span', { class: `device-avatar ${d.role === 'receiver' ? 'receive' : 'review'}` }, d.role === 'receiver' ? '接收' : '审核'),
    h('div', { class: 'grow', style: { minWidth: 0 } },
      h('div', { class: 'row gap-sm wrap' },
        h('span', { class: 'strong' }, d.name),
        isPending
          ? h('span', { class: 'pill pill-warn' }, '等待允许')
          : d.status === 'revoked'
            ? h('span', { class: 'pill pill-outline' }, '已取消授权')
            : h('span', { class: `pill ${d.online ? 'pill-ok' : 'pill-outline'}` }, d.online ? '在线' : '离线'),
        h('span', { class: 'pill' }, d.role === 'both' ? '审核+接收' : d.role === 'receiver' ? '接收' : '审核'),
        d.can_receive && d.role !== 'receiver' ? h('span', { class: 'pill' }, '可接收文件') : null,
      ),
      h('div', { class: 'text-xs muted truncate' }, [d.platform, d.address, d.online ? '在线' : d.last_seen_at ? `最近在线 ${fmtAgo(d.last_seen_at)}` : '还没上线过'].filter(Boolean).join(' · ')),
      tasks.length ? h('div', { class: 'text-xs muted' }, `当前审核对象：${tasks.map((t) => `${t.code}（${statusMeta(t.status).label}）`).join('、')}`) : null,
      d.pendingTasks ? h('div', { class: 'text-xs', style: { color: 'var(--brand-ink)' } }, `${d.pendingTasks} 个任务还没给结论`) : null,
      d.lastDelivery ? h('div', { class: 'text-xs muted' }, `最近一次交付：${fmtAgo(d.lastDelivery.created_at)} · ${statusMeta(d.lastDelivery.status).label}`) : null,
    ),
    h('div', { class: 'col gap-sm' },
      isPending
        ? h('button', { class: 'btn btn-sm btn-primary', onClick: () => approveModal(d) }, '允许')
        : null,
      isPending ? h('button', { class: 'btn btn-sm btn-ghost', onClick: () => revokeDevice(d, true) }, '拒绝') : null,
      !isPending ? h('button', { class: 'btn btn-sm btn-ghost', onClick: () => renameDeviceModal(d) }, '改名') : null,
      !isPending && d.status === 'approved' ? h('button', { class: 'btn btn-sm btn-ghost', onClick: () => revokeDevice(d, false) }, '取消授权') : null,
      !isPending && d.status !== 'approved' ? h('button', { class: 'btn btn-sm btn-ghost', onClick: () => forgetDevice(d) }, '移除记录') : null,
    ),
  );
}

async function approveModal(d) {
  let roleSelect = null;
  let receiveCheck = null;
  const dlg = modal({
    title: `允许「${d.name}」连接`,
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted text-sm' }, `平台：${d.platform || '未知'} · 地址：${d.address || '未知'} · 申请时间：${fmtTime(d.paired_at)}`),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '这台设备的用途'),
        (roleSelect = h('select', { class: 'select' },
          h('option', { value: 'reviewer', selected: d.role === 'reviewer' }, '只审核（看文件、写意见、给结论）'),
          h('option', { value: 'receiver', selected: d.role === 'receiver' }, '只接收交付文件'),
          h('option', { value: 'both' }, '既审核也接收')))),
      h('label', { class: 'checkbox' }, (receiveCheck = h('input', { type: 'checkbox', checked: d.role !== 'reviewer' })), h('span', {}, '允许这台电脑接收正式交付的文件')),
      h('p', { class: 'text-xs muted' }, '只有被允许的设备才能看到审核任务和收到文件。取消授权会立刻生效。'),
    ),
    actions: [
      h('button', { class: 'btn', onClick: () => dlg.close() }, '取消'),
      h('button', { class: 'btn btn-primary', onClick: async () => {
        try {
          await api.post(`/api/devices/${d.id}/approve`, { role: roleSelect.value, canReceive: receiveCheck.checked });
          dlg.close();
          toast(`${d.name} 已连接`, 'success');
          await loadDevices();
          render();
        } catch (err) {
          fail('approve', err);
        }
      } }, '允许'),
    ],
  });
}

async function renameDeviceModal(d) {
  const name = await promptDialog({ title: '设备名称', label: '显示在设备列表里的名字', value: d.name, message: `例如「设计部笔记本」「小林的手机」` });
  if (!name) return;
  try {
    await api.post(`/api/devices/${d.id}/update`, { name });
    await loadDevices();
    render();
  } catch (err) {
    fail('rename', err);
  }
}

async function revokeDevice(d, isPending) {
  const yes = await confirmDialog({
    title: isPending ? '拒绝这台设备？' : `取消「${d.name}」的授权？`,
    message: ['取消后这台设备立刻看不到审核任务，也不能再接收文件。已经保存到它本地的文件不会被删除。'],
    confirmText: isPending ? '拒绝' : '取消授权',
    danger: true,
  });
  if (!yes) return;
  try {
    await api.post(`/api/devices/${d.id}/revoke`, {});
    await loadDevices();
    toast(isPending ? '已拒绝该设备' : '已取消授权', 'success');
    render();
  } catch (err) {
    fail('revoke', err);
  }
}

async function forgetDevice(d) {
  const yes = await confirmDialog({ title: '移除这台设备的记录？', message: ['历史记录里的名字仍会保留，只是不再出现在设备列表。'], confirmText: '移除', danger: true });
  if (!yes) return;
  try {
    await api.post(`/api/devices/${d.id}/forget`, {});
    await loadDevices();
    render();
  } catch (err) {
    fail('forget', err);
  }
}

function diagnosticsCard() {
  const diag = state.diag;
  if (!diag) return h('div', { class: 'card' }, loading('读取连接诊断…'));
  const st = diag.selfTest;
  return h('div', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, '连接诊断'), h('div', { class: 'header-spacer' }), h('button', { class: 'btn btn-sm btn-ghost', onClick: () => loadDevices().then(render) }, '重新检测')),
    h('dl', { class: 'kv' },
      h('dt', {}, '本机地址'), h('dd', {}, diag.localUrl),
      h('dt', {}, '局域网地址'), h('dd', {}, diag.lanUrl),
      h('dt', {}, '监听端口'), h('dd', {}, String(diag.port)),
      h('dt', {}, '网卡'), h('dd', {}, (diag.ips || []).map((i) => `${i.name} ${i.address}`).join('，') || '未检测到'),
      h('dt', {}, '自检'), h('dd', {}, st ? `${st.ok ? '通过' : '失败'} · ${st.ms || 0}ms${st.error ? ` · ${st.error}` : ''}` : '检测中…'),
    ),
    diag.primaryIp ? null : banner('warn', '没有检测到局域网 IP', '这台电脑可能还没连上 Wi-Fi 或网线，连上后刷新页面即可。'),
    h('details', {}, h('summary', { class: 'text-sm muted' }, `对方打不开页面时怎么办（最近失败 ${diag.recentFailures.length} 条）`),
      h('ul', { class: 'hint-list', style: { marginTop: '8px' } },
        h('li', {}, '确认两台电脑连的是同一个 Wi-Fi / 同一个路由器，且路由器没开「客户端隔离」。'),
        h('li', {}, diag.platform === 'win32' ? 'Windows 第一次运行时，请在防火墙弹窗里点「允许访问」；已取消过的话，到「设置 → 隐私和安全性 → Windows Defender 防火墙 → 允许应用通过防火墙」里勾选 Node.js。' : 'macOS 弹出「是否允许接收传入连接」时点允许；已拒绝过的话，到「系统设置 → 网络 → 防火墙」里放行。'),
        h('li', {}, '在手机浏览器地址栏手动输入上面的局域网地址（包含 http:// 和端口号），不要输入 127.0.0.1。'),
        h('li', {}, '页面打不开时看下面的失败请求记录，可以判断是没连上还是被拒绝。'),
      ),
      diag.recentFailures.length
        ? h('div', { class: 'stack', style: { marginTop: '8px', gap: '4px' } }, ...diag.recentFailures.slice(0, 8).map((f) => h('div', { class: 'text-xs muted' }, `${fmtAgo(f.ts)} · ${f.ip} · ${f.status} ${f.code} ${f.message}`)))
        : null),
  );
}

function receiverKitCard() {
  const kit = state.kit || { available: false };
  const landing = `${state.system?.host?.baseUrl || ''}/get-receiver`;
  return h('div', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, '接收端安装包（给收文件的笔记本）')),
    h('p', { class: 'text-sm muted' }, '接收端只需要放在收文件的那台电脑上：下载 → 解压 → 双击启动 → 输入地址和配对码。创作者电脑不需要复制任何东西给它。'),
    kit.available
      ? h('div', { class: 'row wrap gap-sm' },
          h('span', { class: 'pill pill-ok' }, `已准备 · ${kit.sizeLabel}`),
          h('a', { class: 'btn btn-sm btn-primary', href: '/download/receiver-kit.zip', download: true }, '下载接收端安装包'),
          h('button', { class: 'btn btn-sm', onClick: async () => { await run('kit', async () => { const r = await api.post('/api/receiver-kit/build', {}); state.kit = r; toast('安装包已重新生成', 'success'); render(); }); } }, '重新生成'),
        )
      : h('button', { class: 'btn btn-primary', disabled: state.busy.kit, onClick: async () => { await run('kit', async () => { try { state.kit = await api.post('/api/receiver-kit/build', {}); render(); } catch (err) { fail('kit', err); } }); } }, state.busy.kit ? '正在生成…' : '生成接收端安装包'),
    h('div', { class: 'row wrap gap-sm' },
      h('code', { class: 'path-chip', title: landing }, landing),
      h('button', { class: 'btn btn-sm', onClick: () => copyText(landing).then(() => toast('已在笔记本浏览器打开这个地址即可')) }, '复制安装页地址'),
      h('a', { class: 'btn btn-sm btn-ghost', href: landing, target: '_blank', rel: 'noreferrer' }, '预览安装页'),
    ),
  );
}

/* ------------------------------------------------------------ deliveries tab */

function deliveriesTab() {
  const list = state.deliveries || [];
  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('span', { class: 'card-title' }, '交付记录'),
        h('div', { class: 'header-spacer' }),
        h('span', { class: 'text-sm muted' }, `${list.filter((d) => d.status === 'succeeded').length} 次成功 · ${list.filter((d) => ['failed', 'stalled'].includes(d.status)).length} 次异常`),
        h('button', { class: 'btn btn-sm btn-ghost', onClick: () => refreshAll() }, '刷新'),
      ),
      list.length ? h('div', { class: 'stack', style: { gap: '10px' } }, ...list.map((d) => deliveryRow(d, false))) : emptyState('还没有交付记录', '审核通过并选择接收电脑后，这里会显示每一次交付的进度、保存位置和校验结果。'),
    ),
  );
}

function deliveryRow(d, compact) {
  const percent = d.total_bytes ? (d.transferred_bytes / d.total_bytes) * 100 : 0;
  const active = ['queued', 'transferring', 'verifying'].includes(d.status);
  const variant = d.status === 'succeeded' ? 'ok' : ['failed', 'cancelled'].includes(d.status) ? 'error' : '';
  return h('div', { class: 'card card-tight stack' },
    h('div', { class: 'row row-between wrap' },
      h('div', { class: 'row gap-sm wrap' },
        h('span', { class: 'strong' }, `${d.project_name} · ${d.version_code}`),
        statusPill(d.status),
        h('span', { class: 'text-xs muted' }, `→ ${d.device_name || '未知设备'}`),
      ),
      h('div', { class: 'row gap-sm' },
        h('span', { class: 'text-xs muted nowrap' }, fmtTime(d.created_at)),
        active ? h('button', { class: 'btn btn-sm btn-ghost', onClick: () => cancelDelivery(d) }, '取消') : null,
        ['failed', 'stalled', 'cancelled'].includes(d.status) ? h('button', { class: 'btn btn-sm', onClick: () => retryDelivery(d) }, '重试') : null,
        d.status === 'succeeded' ? h('button', { class: 'btn btn-sm', onClick: () => revealPath(d.target_dir) }, '打开文件夹') : null,
      ),
    ),
    h('div', { class: 'stack', style: { gap: '5px' } },
      progressBar(percent, variant),
      h('div', { class: 'row row-between text-xs muted' },
        h('span', {}, `${fmtBytes(d.transferred_bytes)} / ${fmtBytes(d.total_bytes)} · ${d.ok_count}/${d.file_count} 个文件校验通过`),
        h('span', { class: 'truncate', title: d.target_dir }, d.target_dir),
      ),
    ),
    d.error_message ? banner(d.status === 'succeeded' ? 'info' : 'error', d.status === 'succeeded' ? '完成后记录' : '这次交付没有成功', h('div', { class: 'text-sm' }, d.error_message)) : null,
    !compact && d.result?.items?.length ? h('details', {}, h('summary', { class: 'text-sm muted' }, '查看每个文件的接收结果'),
      h('div', { class: 'stack', style: { marginTop: '8px', gap: '4px' } }, ...d.result.items.map((i) => h('div', { class: 'text-xs mono' }, `${i.name || i.fileId} · ${i.sha256 ? `${i.sha256Ok === false ? '校验失败' : '已校验 ' + String(i.sha256).slice(0, 10)}` : '未完成'} · ${fmtBytes(i.size)}`)))) : null,
  );
}

async function cancelDelivery(d) {
  const yes = await confirmDialog({ title: '取消这次交付？', message: ['接收端会停止下载，已经传完的文件保留在它本地，但你可以在它那里重新发起。'], confirmText: '取消交付', danger: true });
  if (!yes) return;
  try {
    await api.post(`/api/deliveries/${d.id}/cancel`, {});
    await loadDeliveries();
    await loadVersion(state.versionId);
    render();
  } catch (err) {
    fail('cancel', err);
  }
}

async function retryDelivery(d) {
  try {
    await api.post(`/api/deliveries/${d.id}/retry`, {});
    toast('已重新排队，等待接收端上线继续', 'success');
    await loadDeliveries();
    render();
  } catch (err) {
    fail('retry', err);
  }
}

async function revealPath(path) {
  try {
    await api.post('/api/fs/reveal', { path });
  } catch (err) {
    toast(errText(err), 'error', 7000);
  }
}

function deliverModal(v, receivers) {
  let selectEl = null;
  const online = receivers.filter((r) => r.online);
  const dlg = modal({
    title: `正式交付 ${v.code}`,
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted text-sm' }, `交付的是 ${v.code} 提交时的快照：${v.stats.fileCount} 个文件 · ${fmtBytes(v.stats.totalBytes)}。之后你继续修改工作文件不会影响这次交付内容。`),
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label' }, '接收电脑'),
        (selectEl = h(
          'select',
          { class: 'select' },
          ...receivers.map((r) => h('option', { value: r.id }, r.online ? `${r.name}（在线）` : `${r.name}（离线 · 最近在线 ${fmtAgo(r.last_seen_at)}）`)),
        )),
      ),
      online.length === 0 ? banner('warn', '这些接收设备现在都不在线', '请让对方打开接收端页面（保持浏览器开着），或先在接收电脑上运行接收端程序。也可以先点交付，对方上线后会自动继续。') : null,
      h('div', { class: 'text-xs muted' }, '交付过程会显示进度；每个文件传完后接收端会做一次完整性校验，不一致会明确报错而不会假装成功。'),
    ),
    actions: [
      h('button', { class: 'btn', onClick: () => dlg.close() }, '先不交付'),
      h('button', { class: 'btn btn-primary', disabled: state.busy.deliver, onClick: async () => {
        await run('deliver', async () => {
          try {
            const offer = await api.post(`/api/versions/${v.id}/deliver`, { deviceId: selectEl.value });
            dlg.close();
            state.tracking = offer.deliveryId;
            toast('已通知接收电脑，开始传输', 'success');
            await Promise.all([loadDeliveries(), loadVersion(v.id), loadDevices()]);
            render();
            startDeliveryTicker();
          } catch (err) {
            fail('deliver', err);
          }
        });
      } }, '开始交付'),
    ],
  });
}

let deliverTicker = null;
function startDeliveryTicker() {
  if (deliverTicker) clearInterval(deliverTicker);
  deliverTicker = setInterval(async () => {
    if (!state.tracking) {
      clearInterval(deliverTicker);
      deliverTicker = null;
      return;
    }
    try {
      const { delivery } = await api.get(`/api/deliveries/${state.tracking}`);
      const idx = state.deliveries.findIndex((d) => d.id === delivery.id);
      if (idx >= 0) state.deliveries[idx] = { ...state.deliveries[idx], ...delivery };
      if (['succeeded', 'failed', 'cancelled', 'stalled'].includes(delivery.status)) {
        clearInterval(deliverTicker);
        deliverTicker = null;
        state.tracking = null;
        toast(delivery.status === 'succeeded' ? `交付完成，已保存在 ${delivery.target_dir}` : `交付${statusMeta(delivery.status).label}：${delivery.error_message || ''}`, delivery.status === 'succeeded' ? 'success' : 'error', 10000);
        await loadVersion(state.versionId).catch(() => {});
      }
      render();
    } catch {
      /* transient */
    }
  }, 1500);
}

/* --------------------------------------------------------------- settings tab */

function settingsTab() {
  const ws = state.ws?.workspace;
  const sys = state.system;
  const token = BOOT.creatorToken || store('creator-token').read() || '';
  return h('div', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, '工作区')),
      h('dl', { class: 'kv' },
        h('dt', {}, '位置'), h('dd', {}, ws?.path || '-'),
        h('dt', {}, '状态'), h('dd', {}, ws?.exists ? '正常' : '文件夹当前不存在'),
        h('dt', {}, '剩余空间'), h('dd', {}, sys?.workspace?.free?.free ? fmtBytes(sys.workspace.free.free) : '-'),
        h('dt', {}, '内部数据'), h('dd', {}, h('code', { class: 'path-chip' }, `${ws?.path || ''}/.lanreview`)),
      ),
      h('div', { class: 'btn-group' },
        h('button', { class: 'btn', onClick: () => api.post('/api/workspace/reveal', { path: ws.path }).catch((e) => toast(errText(e), 'error')) }, '打开工作区'),
        h('button', { class: 'btn', onClick: () => pickWorkspace() }, '更换工作区'),
      ),
      h('p', { class: 'text-xs muted' }, '换工作区只是换一组项目记录；旧工作区里的 .lanreview 文件夹仍然保存着当时的版本快照，把整个文件夹拷走即可迁移。'),
    ),
    h('div', { class: 'card stack' },
      h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, '创作者口令')),
      h('p', { class: 'text-sm muted' }, '在创作者电脑上打开页面不需要口令。如果想在别的电脑上打开这个管控页面，需要输入它。审核和接收都不需要。'),
      h('div', { class: 'row wrap gap-sm' },
        h('code', { class: 'path-chip' }, state.showToken ? token || '（本机打开时不显示）' : '••••••••••••'),
        h('button', { class: 'btn btn-sm', onClick: () => { state.showToken = !state.showToken; render(); } }, state.showToken ? '隐藏' : '显示'),
        token ? h('button', { class: 'btn btn-sm btn-ghost', onClick: () => copyText(token).then(() => toast('口令已复制')) }, '复制') : null,
      ),
    ),
    h('div', { class: 'card stack' },
      h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, '关于')),
      h('dl', { class: 'kv' },
        h('dt', {}, '程序'), h('dd', {}, `${sys?.app?.name || 'LAN Review'} ${sys?.app?.version || ''} · ${sys?.app?.label || ''}`),
        h('dt', {}, '这台电脑'), h('dd', {}, `${sys?.host?.name || ''} · ${sys?.host?.platform || navigator.platform || ''}`),
        h('dt', {}, '运行地址'), h('dd', {}, sys?.host?.baseUrl || BOOT.baseUrl || ''),
        h('dt', {}, '已运行'), h('dd', {}, sys?.host?.startedAt ? fmtAgo(sys.host.startedAt) : '-'),
      ),
      h('p', { class: 'text-xs muted' }, '所有文件都只在这个局域网内传输，不经过任何公网服务。想停止，直接关掉这个程序的窗口即可（下次双击启动，一切记录都还在）。'),
    ),
  );
}

/* ------------------------------------------------------------- project modals */

function newProjectModal() {
  const form = { date: new Date().toISOString().slice(0, 10), brand: '', name: '' };
  let previewEl = null;
  const refreshPreview = debounce(async () => {
    if (!form.name.trim()) {
      previewEl.replaceChildren(h('span', { class: 'text-sm muted' }, '填好名称后，这里会显示项目文件夹将保存在哪里。'));
      return;
    }
    try {
      const res = await api.post('/api/projects/preview', form);
      previewEl.replaceChildren(
        h('div', { class: 'stack', style: { gap: '6px' } },
          h('code', { class: 'path-chip', title: res.folder }, res.folder),
          res.registered
            ? h('span', { class: 'pill pill-warn' }, '这个位置已经是一个项目')
            : res.exists && res.hasFiles
              ? h('span', { class: 'pill pill-warn' }, '这个位置已有同名文件夹，里面还有文件')
              : h('span', { class: 'pill pill-ok' }, '位置可用'),
        ),
      );
      previewEl.dataset.folder = res.folder;
      previewEl.dataset.conflict = res.registered || (res.exists && res.hasFiles) ? '1' : '';
    } catch (err) {
      previewEl.replaceChildren(h('span', { class: 'text-sm', style: { color: 'var(--danger)' } }, errText(err)));
    }
  }, 260);

  const input = (key, label, placeholder) => h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label),
    h('input', { class: 'input', 'data-key': `pf-${key}`, value: form[key], placeholder, onInput: (e) => { form[key] = e.target.value; refreshPreview(); } }),
  );

  const dlg = modal({
    title: '新建项目',
    body: h('div', { class: 'stack' },
      h('p', { class: 'text-sm muted' }, '会在你的工作区里新建一个项目文件夹，命名规则是「日期_品牌_项目名」。'),
      input('date', '日期', '2026-09-09'),
      input('brand', '品牌（可留空）', '例如：悦活'),
      input('name', '项目名称', '例如：春季新品'),
      h('div', { id: 'proj-preview' }),
    ),
    actions: [
      h('button', { class: 'btn', onClick: () => dlg.close() }, '取消'),
      h('button', { class: 'btn btn-primary', onClick: () => createProject({ dlg, form, previewEl }) }, '创建项目'),
    ],
  });
  previewEl = qs('#proj-preview');
  refreshPreview();
}

async function createProject({ dlg, form, previewEl }) {
  if (!form.name.trim()) {
    toast('请填写项目名称', 'error');
    return;
  }
  try {
    const { project } = await api.post('/api/projects', form);
    dlg.close();
    toast(`项目「${project.name}」已创建`, 'success');
    await loadProjects();
    selectProject(project.id);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'project_exists') {
      const decision = await handleConflict(err.detail, form);
      if (decision === 'open') {
        dlg.close();
        await loadProjects({ keep: false });
        const match = state.projects.find((p) => p.folder_path === (err.detail?.project?.folder_path || err.detail?.folderPath));
        if (match) selectProject(match.id);
        else importExisting(err.detail?.folderPath);
      } else if (decision === 'rename') {
        try {
          const { project } = await api.post('/api/projects', { ...form, forceNewName: true });
          dlg.close();
          toast(`已用新名字创建：${project.name}`, 'success');
          await loadProjects();
          selectProject(project.id);
        } catch (err2) {
          fail('project', err2);
        }
      }
      return;
    }
    fail('project', err);
  }
}

async function handleConflict(detail, form) {
  const folder = detail?.project?.folder_path || detail?.folderPath || '';
  const existing = detail?.project;
  const box = h('div', { class: 'stack' },
    h('p', {}, '工作区里已经有一个同名的项目：'),
    h('div', { class: 'card card-tight stack' },
      h('div', { class: 'strong' }, existing ? existing.name : folderName(folder)),
      h('code', { class: 'path-chip', title: folder }, folder),
      detail?.existingFiles ? h('div', { class: 'text-xs muted' }, `里面已有 ${detail.existingFiles} 个文件`) : null,
      existing ? h('div', { class: 'text-xs muted' }, `已提审 ${existing.versionCount ?? '?'} 次，最近一次 ${fmtAgo(existing.updated_at)}`) : null,
    ),
    h('p', { class: 'text-sm muted' }, '继续之前请先选一种处理方式，程序不会静默覆盖或混用旧项目。'),
  );
  return new Promise((resolve) => {
    const close = () => dlg.close();
    const dlg = modal({
      title: '同名项目已存在',
      body: box,
      dismissible: false,
      actions: [
        h('button', { class: 'btn', onClick: () => { close(); resolve(null); } }, '返回修改'),
        h('button', { class: 'btn', onClick: () => { close(); resolve('open'); } }, '打开这个旧项目'),
        h('button', { class: 'btn btn-primary', onClick: () => { close(); resolve('rename'); } }, `新建「${folderName(folder)}-2」`),
      ],
    });
  });
}

function importProjectModal() {
  browseModal({
    title: '选择已有的项目文件夹',
    startDir: state.ws?.workspace?.path,
    onPick: (path) => importExisting(path),
  });
}

async function importExisting(path) {
  try {
    const { project, reused } = await api.post('/api/projects/import', { path });
    toast(reused ? `已打开项目「${project.name}」` : `已导入项目「${project.name}」`, 'success');
    await loadProjects({ keep: false });
    selectProject(project.id);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'outside_workspace') toast('请选择工作区里的文件夹。如果项目在别处，先把它拷进工作区，或更换工作区。', 'error', 9000);
    else fail('import', err);
  }
}

function editProjectModal(p) {
  let name = null;
  let brand = null;
  let date = null;
  const dlg = modal({
    title: '项目信息',
    body: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '项目名称'), (name = h('input', { class: 'input', value: p.name }))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '品牌'), (brand = h('input', { class: 'input', value: p.brand || '' }))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '日期'), (date = h('input', { class: 'input', value: p.project_date || '' }))),
      h('p', { class: 'text-xs muted' }, '只修改显示名称，不会重命名磁盘上的项目文件夹。'),
    ),
    actions: [
      h('button', { class: 'btn', onClick: () => dlg.close() }, '取消'),
      h('button', { class: 'btn btn-primary', onClick: async () => {
        try {
          await api.post(`/api/projects/${p.id}/update`, { name: name.value, brand: brand.value, date: date.value });
          dlg.close();
          await Promise.all([loadProjects(), loadProject(p.id)]);
          render();
        } catch (err) {
          fail('projectUpdate', err);
        }
      } }, '保存'),
    ],
  });
}

function reassignModal(v) {
  const reviewers = (state.devices?.devices || []).filter((d) => d.status === 'approved' && ['reviewer', 'both'].includes(d.role));
  const chosen = new Set(v.assignments.map((a) => a.device_id));
  const box = h('div', { class: 'stack' },
    reviewers.length ? h('div', { class: 'stack' }, ...reviewers.map((d) => h('label', { class: `checkbox${chosen.has(d.id) ? ' selected' : ''}` },
      h('input', { type: 'checkbox', checked: chosen.has(d.id), onChange: (e) => { if (e.target.checked) chosen.add(d.id); else chosen.delete(d.id); } }),
      h('span', {}, d.name)))) : h('div', { class: 'text-sm muted' }, '没有可选的审核设备。'),
    h('p', { class: 'text-xs muted' }, '减少的人不再看到该任务；已给出的结论保留在版本记录里。'),
  );
  const dlg = modal({
    title: `调整 ${v.code} 的审核人`,
    body: box,
    actions: [
      h('button', { class: 'btn', onClick: () => dlg.close() }, '取消'),
      h('button', { class: 'btn btn-primary', onClick: async () => {
        try {
          await api.post(`/api/versions/${v.id}/reassign`, { deviceIds: [...chosen] });
          dlg.close();
          await Promise.all([loadVersion(v.id), loadDevices()]);
          render();
        } catch (err) {
          fail('reassign', err);
        }
      } }, '保存'),
    ],
  });
}

/* ---------------------------------------------------------------------- boot */

let liveSource = null;
let livePoll = null;
let liveRetry = null;
let liveDebounce = null;

function teardownLive() {
  clearTimeout(liveRetry);
  clearInterval(livePoll);
  clearTimeout(liveDebounce);
  livePoll = null;
  liveDebounce = null;
  try {
    liveSource?.close();
  } catch {
    /* already closed */
  }
  liveSource = null;
}

function startLive() {
  teardownLive();
  const schedule = () => {
    clearTimeout(liveDebounce);
    liveDebounce = setTimeout(() => refreshAll({ silent: true }).catch(() => {}), 600);
  };
  const es = new EventSource(withCk('/api/events'));
  liveSource = es;
  es.onmessage = (e) => {
    let envelope = {};
    try {
      envelope = JSON.parse(e.data);
    } catch {
      return;
    }
    const kind = envelope.kind || '';
    const data = envelope.data || {};
    if (kind === 'device.pending') toast(`${data.name || '新设备'} 请求连接，请在「设备连接」里确认`, 'info', 9000);
    if (kind === 'device.online') toast(`${data.name || '设备'} 已上线`, 'success', 4000);
    if (kind === 'comment.created') toast(`收到新意见：${(data.body || '').slice(0, 28)}…`, 'info', 7000);
    if (kind === 'decision.created') toast(`${data.device || '审核者'} 给出了结论：${statusMeta(data.status).label}`, 'success', 8000);
    if (kind === 'delivery.updated' && data.status === 'succeeded') toast('交付完成', 'success', 8000);
    if (kind === 'delivery.updated' && ['failed', 'stalled'].includes(data.status)) toast(`交付${statusMeta(data.status).label}`, 'error', 9000);
    clearInterval(livePoll);
    livePoll = null;
    schedule();
  };
  es.onerror = () => {
    teardownLive();
    livePoll = setInterval(() => refreshAll({ silent: true }).catch(() => {}), 9000);
    liveRetry = setTimeout(startLive, 15000);
  };
}

async function main() {
  setFavicon();
  const hash = parseHashParams();
  if (hash.tab && ['submit', 'versions', 'devices', 'deliveries', 'settings'].includes(hash.tab)) state.tab = hash.tab;
  try {
    await loadShell();
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      state.needsToken = true;
      render();
    } else {
      mount(root, h('div', { class: 'page' }, banner('error', '启动失败', h('div', { class: 'text-sm' }, errText(err)), h('button', { class: 'btn btn-sm', onClick: () => location.reload() }, '重新加载'))));
      return;
    }
  }
  startLive();
  setInterval(() => {
    if (state.tab === 'devices' || state.deliveries.some((d) => ['queued', 'transferring'].includes(d.status))) loadDevices().catch(() => {});
  }, 12000);
}

main();
