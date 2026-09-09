import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api, assert, equals, makeTmpDir, resetResults, sha256FileSync, step, summary } from './helpers.mjs';
import { writeSampleProject } from './fixtures.mjs';
import { primaryLanAddress } from '../server/lib/net.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TMP = makeTmpDir('flow');
const DATA = path.join(TMP, 'data');
const WS = path.join(TMP, 'workspace');
const HOST_PORT = 8890;
const AGENT_PORT = 8895;
const LAN_IP = primaryLanAddress() || '127.0.0.1';
const HOST_URL = `http://${LAN_IP}:${HOST_PORT}`;

process.env.LANREVIEW_DATA_DIR = DATA;
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(WS, { recursive: true });

const children = [];

function spawnNode(args, env, label) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (c) => {
    log.push(c.toString());
  });
  child.stderr.on('data', (c) => {
    log.push(`[stderr] ${c.toString()}`);
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log(`\n[${label} 异常退出 code=${code}]\n${log.join('')}`);
  });
  children.push({ child, log, label });
  return { child, log };
}

function waitFile(file, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待 ${path.basename(file)} 超时`));
      }
    }, 200);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHost(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`创作者服务未在 :${port} 启动`);
}

async function waitForAgent(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`接收端未在 :${port} 启动`);
}

let host = null;
let agent = null;
let creator = null; // loopback creator client
let lan = null; // LAN creator client (with token)
let phone = null; // reviewer device client
let laptopToken = null;
let agentReceiverToken = null;
let projectId = null;
let projectDir = null;
let v1 = null;
let v2 = null;
let deliveryId = null;
const snapshots = {};

function killAll() {
  for (const { child } of children) {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

process.on('exit', killAll);

async function main() {
  console.log(`\n局域网提审/审核/交付 · 全流程测试`);
  console.log(`创作者服务 ${HOST_URL}   临时目录 ${TMP}\n`);
  host = spawnNode(['server/index.js', '--no-open'], { LANREVIEW_PORT: String(HOST_PORT), LANREVIEW_DATA_DIR: DATA, LANREVIEW_NO_OPEN: '1' }, 'host');
  await waitForHost(HOST_PORT);
  await waitFile(path.join(DATA, 'running.json'));

  creator = new Api(`http://127.0.0.1:${HOST_PORT}`, { creator: true, label: '本机创作者' });
  lan = new Api(HOST_URL, { creator: true, label: '局域网创作者' });

  await step('未选择工作区时，业务接口明确拒绝而不是崩溃', async () => {
    const r = await lan.raw('GET', '/api/projects');
    equals(r.status, 409, '应返回 409');
    equals(r.data.error.code, 'workspace_missing', '错误码应为 workspace_missing');
  });

  await step('局域网设备无创作者口令不能调用创作者接口', async () => {
    const anon = new Api(HOST_URL, { label: '局域网匿名' });
    const r = await anon.raw('GET', '/api/devices');
    equals(r.status, 403, '应返回 403');
    equals(r.data.error.code, 'creator_required', '错误码应为 creator_required');
  });

  await step('手机在配对前看不到任何审核任务', async () => {
    const anon = new Api(HOST_URL, { label: '未配对手机' });
    const r = await anon.raw('GET', '/api/me/tasks');
    assert(r.status >= 400 && r.status !== 404, `应被拒绝，实际 ${r.status}`);
    assert(!Array.isArray(r.data?.tasks), '不应返回任何任务数据');
    // 工作区就绪后的 401 device_unpaired 检查在“配对”一步里验证
  });

  await step('选择并记住工作区', async () => {
    const { data } = await creator.post('/api/workspace/set', { path: WS });
    equals(data.workspace, WS, '工作区路径应一致');
    equals(data.projectCount, 0, '新工作区没有项目');
  });

  await step('创建项目前能看到保存位置，同名项目不会被静默覆盖', async () => {
    const { data: preview } = await creator.post('/api/projects/preview', { date: '2026-09-09', brand: '悦活', name: '春季新品' });
    equals(preview.folder, path.join(WS, '2026-09-09_悦活_春季新品'), '预览路径应落在工作区内');
    const { data: created } = await creator.post('/api/projects', { date: '2026-09-09', brand: '悦活', name: '春季新品' });
    projectId = created.project.id;
    projectDir = created.project.folder_path;
    assert(fs.existsSync(created.project.folder_path), '项目文件夹应已创建');
    const conflict = await creator.raw('POST', '/api/projects', { date: '2026-09-09', brand: '悦活', name: '春季新品' });
    equals(conflict.status, 409, '同名项目应要求用户选择');
    equals(conflict.data.error.code, 'project_exists', '错误码 project_exists');
    assert(conflict.data.error.detail?.project, '冲突信息应带上已有项目');
    const { data: renamed } = await creator.post('/api/projects', { date: '2026-09-09', brand: '悦活', name: '春季新品', forceNewName: true });
    assert(renamed.project.folder_path !== created.project.folder_path, '换名后应使用新文件夹');
    const { data: list } = await creator.get('/api/projects');
    equals(list.projects.length, 2, '应列出两个项目');
    await creator.post('/api/projects/import', { path: created.project.folder_path }).then((r) => equals(r.data.reused, true, '重复导入应复用已登记项目'));
  });

  await step('选择待审文件：支持整个文件夹与单个文件，并保留目录结构', async () => {
    writeSampleProject(projectDir);
    const { data: dirAdd } = await creator.post(`/api/projects/${projectId}/draft/add`, { dir: path.join(projectDir, '素材') });
    equals(dirAdd.count, 4, '素材文件夹应带来 4 个文件');
    assert(dirAdd.items.some((i) => i.relPath === '素材/图片/主视觉.png'), `应保留目录结构：${dirAdd.items.map((i) => i.relPath).join(', ')}`);
    const { data: full } = await creator.post(`/api/projects/${projectId}/draft/add`, {
      paths: [
        path.join(projectDir, '交付说明', '文案终稿.pdf'),
        path.join(projectDir, '交付说明', '排期表.csv'),
        path.join(projectDir, '交付说明', '修改说明.md'),
        path.join(projectDir, '交付说明', '工程文件.psd'),
      ],
    });
    equals(full.count, 8, `应共 8 个文件，实际 ${full.count}`);
    assert(full.totalBytes > 200000, '应统计总大小');
    const again = await creator.post(`/api/projects/${projectId}/draft/add`, { dir: path.join(projectDir, '素材') });
    equals(again.data.count, 8, '重复选择同一文件夹不应产生重复条目');
    const kinds = full.items.map((i) => `${i.name}:${i.kind}`).sort();
    assert(kinds.some((k) => k.endsWith(':video')), '应识别视频');
    assert(kinds.some((k) => k.endsWith(':pdf')), '应识别 PDF');
    assert(kinds.some((k) => k.endsWith(':image')), '应识别图片');
    assert(kinds.some((k) => k.endsWith(':audio')), '应识别音频');
    assert(kinds.some((k) => k.endsWith(':sheet')), '应识别表格');
  });

  let phoneDevice = null;
  await step('手机扫码配对 → 创作者授权 → 设备在线', async () => {
    const anon = new Api(HOST_URL, { label: '未配对设备' });
    const anonTasks = await anon.raw('GET', '/api/me/tasks');
    equals(anonTasks.status, 401, '未配对设备应返回 401');
    equals(anonTasks.data.error.code, 'device_unpaired', '错误码 device_unpaired');
    const { data: pairing } = await creator.post('/api/devices/pairing', { role: 'reviewer', label: '手机' });
    assert(/^[A-Z0-9]{6}$/.test(pairing.code), '配对码格式');
    assert(pairing.url.startsWith(HOST_URL), '配对链接应使用局域网地址');
    const redeemed = await new Api(HOST_URL, { label: '手机' }).post('/api/pair/redeem', {
      code: pairing.code,
      name: '小林的 iPhone',
      platform: 'iPhone iOS 19',
    });
    phoneDevice = redeemed.data;
    phone = new Api(HOST_URL, { token: phoneDevice.token, label: '手机审核端' });
    const before = await phone.raw('GET', '/api/me/tasks');
    equals(before.status, 403, '未授权前不能读取任务');
    equals(before.data.error.code, 'device_pending', '应提示等待授权');
    const { data: devices } = await creator.get('/api/devices');
    const pending = devices.pending.find((d) => d.id === phoneDevice.deviceId);
    assert(pending, '创作者应看到待授权设备');
    await creator.post(`/api/devices/${phoneDevice.deviceId}/approve`, { role: 'reviewer' });
    await phone.post('/api/me/heartbeat', {});
    const after = await phone.get('/api/me/tasks');
    equals(after.data.tasks.length, 0, '刚授权还没有任务');
    const { data: d2 } = await creator.get('/api/devices');
    assert(d2.devices.find((d) => d.id === phoneDevice.deviceId).online, '设备应显示在线');
  });

  await step('提交 V01 形成不可变版本快照', async () => {
    const { data } = await creator.post(`/api/projects/${projectId}/submit`, {
      deviceIds: [phoneDevice.deviceId],
      note: '第一版：主视觉 + 视频小样 + 文案',
    });
    v1 = data;
    equals(v1.code, 'V01', '第一个版本编号');
    equals(v1.status, 'reviewing', '提交后状态是审核中');
    equals(v1.files.length, 8, '版本应包含清单里的全部文件');
    snapshots.V01 = v1.files.map((f) => f.sha256);
    const manifest = path.join(v1.snapshot_dir, 'manifest.json');
    assert(fs.existsSync(manifest), '应写入 manifest.json');
    assert(v1.snapshot_dir.startsWith(path.join(WS, '.lanreview')), '快照应保存在工作区内部');
  });

  await step('审核端在浏览器里真的能打开文件（图片/视频 Range/PDF/文本）', async () => {
    const { data: tasks } = await phone.get('/api/me/tasks');
    equals(tasks.tasks.length, 1, '手机应看到 1 个任务');
    const { data: detail } = await phone.get(`/api/me/versions/${v1.id}`);
    const img = detail.files.find((f) => f.kind === 'image');
    const vid = detail.files.find((f) => f.kind === 'video');
    const pdf = detail.files.find((f) => f.kind === 'pdf');
    const md = detail.files.find((f) => f.ext === 'md');
    const psd = detail.files.find((f) => f.ext === 'psd');
    assert(img && vid && pdf && md && psd, '文件类型覆盖不全');
    const imgRes = await fetch(HOST_URL + img.mediaUrl);
    equals(imgRes.status, 200, '图片应可预览');
    equals(imgRes.headers.get('content-type'), 'image/png', '图片 MIME 类型');
    const rangeRes = await fetch(HOST_URL + vid.mediaUrl, { headers: { Range: 'bytes=1000-2000' } });
    equals(rangeRes.status, 206, '视频应支持 Range（拖动进度条）');
    assert(String(rangeRes.headers.get('content-range')).startsWith('bytes 1000-2000/'), `Range 头部：${rangeRes.headers.get('content-range')}`);
    equals(Number(String(rangeRes.headers.get('content-range')).split('/')[1]), vid.size, 'Range 报告的总大小应与版本记录一致');
    const buf = Buffer.from(await rangeRes.arrayBuffer());
    equals(buf.length, 1001, 'Range 分片长度');
    const pdfRes = await fetch(HOST_URL + pdf.mediaUrl);
    equals(pdfRes.headers.get('content-type'), 'application/pdf', 'PDF 应内联预览');
    equals(pdfRes.headers.get('content-disposition'), 'inline', 'PDF 不应强制下载');
    const text = await (await fetch(HOST_URL + md.textUrl)).json();
    assert(text.text.includes('V01 初稿'), '文本内容应可读');
    equals(psd.preview, 'none', 'PSD 应标记为不可预览');
    const dl = await fetch(HOST_URL + psd.downloadUrl);
    equals(dl.headers.get('content-disposition').startsWith('attachment'), true, '不可预览文件应能下载');
  });

  await step('鉴权边界：换用别人的链接 / 未分配版本都被拒绝', async () => {
    const { data: detail } = await phone.get(`/api/me/versions/${v1.id}`);
    const target = detail.files.find((f) => f.kind === 'image');
    const url = new URL(target.mediaUrl, HOST_URL);
    const tampered = `${url.pathname}?${new URLSearchParams({ d: url.searchParams.get('d'), e: url.searchParams.get('e'), s: 'zzzzzzzzzzzz' })}`;
    const r = await fetch(HOST_URL + tampered);
    equals(r.status, 403, '签名被改应 403');
    const other = new Api(HOST_URL, { token: 'not-a-real-token', label: '伪造设备' });
    const fake = await other.raw('GET', '/api/me/tasks');
    equals(fake.status, 401, '无效 token 应 401');
    const direct = await fetch(`${HOST_URL}/api/me/media/${v1.id}/${target.id}?d=${url.searchParams.get('d')}&e=${url.searchParams.get('e')}&s=${url.searchParams.get('s')}`);
    equals(direct.status, 200, '合法签名链接可访问');
    const bogus = await fetch(`${HOST_URL}/api/me/media/${v1.id}/${'fil_nope'}`);
    assert(bogus.status >= 400, '缺少签名参数应被拒绝');
  });

  await step('评论（含视频时间码）实时回到创作者页面', async () => {
    const { data: detail } = await phone.get(`/api/me/versions/${v1.id}`);
    const img = detail.files.find((f) => f.kind === 'image');
    const vid = detail.files.find((f) => f.kind === 'video');
    await phone.post('/api/me/comments', { versionId: v1.id, fileId: img.id, body: '主视觉蓝色偏暗，建议提亮一档' });
    await phone.post('/api/me/comments', { versionId: v1.id, fileId: vid.id, body: '0:03 处 logo 出现太晚', timecode: 3.5 });
    const empty = await phone.raw('POST', '/api/me/comments', { versionId: v1.id, fileId: img.id, body: '   ' });
    equals(empty.status, 400, '空评论应被拒绝');
    const { data: seen } = await creator.get(`/api/versions/${v1.id}`);
    equals(seen.comments.length, 2, '创作者应看到 2 条评论');
    const tc = seen.comments.find((c) => c.timecode !== null);
    equals(tc.timecode, 3.5, '时间码应保存');
    equals(tc.file_id, vid.id, '时间码应绑定到视频文件');
    equals(seen.stats.openCommentCount, 2, '未处理意见计数');
  });

  await step('未通过的版本不能正式交付', async () => {
    const r = await creator.raw('POST', `/api/versions/${v1.id}/deliver`, { deviceId: 'none' });
    equals(r.status, 409, '未通过版本交付应被拒绝');
    equals(r.data.error.code, 'not_approved', '错误码 not_approved');
  });

  await step('要求修改 → 工作文件继续改 → V02 不影响 V01', async () => {
    const { data: detail } = await phone.get(`/api/me/versions/${v1.id}`);
    await phone.post('/api/me/decision', { versionId: v1.id, decision: 'changes', note: '整体色调需要调整' });
    const { data: after } = await creator.get(`/api/versions/${v1.id}`);
    equals(after.status, 'changes_requested', '版本应变为需要修改');
    fs.writeFileSync(path.join(projectDir, '交付说明', '修改说明.md'), '# 修改说明\n\n这是用于测试的文案文件。\n\n- 版本：V02 已改\n- 联系人：品牌方\n');
    fs.writeFileSync(path.join(projectDir, '素材', '图片', '主视觉.png'), (await import('./fixtures.mjs')).makePng(240, 160, [14, 165, 233]));
    const { data: draft } = await creator.get(`/api/projects/${projectId}/draft`);
    equals(draft.count, 8, '提交后清单应保留，重新提审不必再选一遍');
    const { data: submitted } = await creator.post(`/api/projects/${projectId}/submit`, { deviceIds: [phoneDevice.deviceId], note: '按意见调整了主视觉与文案' });
    v2 = submitted;
    equals(v2.code, 'V02', '新版本编号 V02');
    equals(v2.files.length, 8, 'V02 文件数');
    const { data: keepV1 } = await creator.get(`/api/versions/${v1.id}`);
    equals(JSON.stringify(keepV1.files.map((f) => f.sha256)), JSON.stringify(snapshots.V01), 'V01 快照哈希不能因为工作文件被改而改变');
    equals(keepV1.comments.length, 2, 'V01 的旧评论应保留');
    equals(keepV1.status, 'changes_requested', 'V01 的旧结论应保留');
    equals(keepV1.files.find((f) => f.ext === 'md').source_path.includes('修改说明'), true, '旧版本仍能追溯到源文件');
    const mdV2 = v2.files.find((f) => f.ext === 'md');
    const pngV2 = v2.files.find((f) => f.display_name === '主视觉.png');
    assert(mdV2.sha256 !== keepV1.files.find((f) => f.ext === 'md').sha256, 'V02 文本文件应体现修改');
    assert(pngV2.sha256 !== keepV1.files.find((f) => f.display_name === '主视觉.png').sha256, 'V02 图片应体现修改');
    const { data: tasks } = await phone.get('/api/me/tasks');
    equals(tasks.tasks.length, 2, '手机应看到两个版本');
    assert(tasks.tasks.find((t) => t.code === 'V02').open, 'V02 应是待处理');
  });

  await step('版本完整性校验能发现快照损坏', async () => {
    const target = path.join(v1.snapshot_dir, v1.files.find((f) => f.ext === 'csv').snapshot_rel);
    const original = fs.readFileSync(target);
    fs.writeFileSync(target, '被外部改动了');
    const { data: bad } = await creator.post(`/api/versions/${v1.id}/verify`, {});
    equals(bad.integrity, 'broken', '应检出损坏');
    fs.writeFileSync(target, original);
    const { data: good } = await creator.post(`/api/versions/${v1.id}/verify`, {});
    equals(good.integrity, 'ok', '恢复后应校验通过');
  });

  await step('笔记本接收端配对并等待授权', async () => {
    agent = spawnNode(['agent/index.js', '--no-open'], {
      LANREVIEW_RECEIVER_DIR: path.join(TMP, 'receiver'),
      LANREVIEW_AGENT_PORT: String(AGENT_PORT),
    }, 'agent');
    await waitForAgent(AGENT_PORT);
    const agentApi = new Api(`http://127.0.0.1:${AGENT_PORT}`, { label: '接收端本机' });
    const { data: recvDir } = await agentApi.post('/api/receive-root/set', { path: path.join(TMP, 'received') });
    equals(recvDir.ok, true, '应能设置接收文件夹');
    const { data: pairing } = await creator.post('/api/devices/pairing', { role: 'receiver', label: '笔记本' });
    const badCode = await agentApi.raw('POST', '/api/pair', { hostUrl: HOST_URL, code: 'ZZZZZZ' });
    equals(badCode.status, 400, '错误配对码应被拒绝');
    const { data: paired } = await agentApi.post('/api/pair', { hostUrl: HOST_URL, code: pairing.code, name: '审核笔记本' });
    equals(paired.approved, false, '配对后仍需创作者授权');
    agentReceiverToken = null;
    const { data: devices } = await creator.get('/api/devices');
    const pendingLaptop = devices.pending.find((d) => d.role === 'receiver');
    laptopToken = pendingLaptop.id;
    await creator.post(`/api/devices/${pendingLaptop.id}/approve`, { role: 'receiver', canReceive: true });
    const st = await waitForCondition(async () => {
      const s = await agentApi.get('/api/state');
      return s.data.device?.approved ? s.data : null;
    }, 20000, '接收端等到授权');
    equals(st.device.canReceive, true, '应获得接收能力');
  });

  await step('审核通过后才能交付，且交付的是批准的 V02', async () => {
    const { data: detail } = await phone.get(`/api/me/versions/${v2.id}`);
    await phone.post('/api/me/decision', { versionId: v2.id, decision: 'pass', note: '这版可以' });
    const { data: approved } = await creator.get(`/api/versions/${v2.id}`);
    equals(approved.status, 'approved', 'V02 应为审核通过');
    const unapproved = await creator.raw('POST', `/api/versions/${v1.id}/deliver`, { deviceId: laptopToken });
    equals(unapproved.status, 409, 'V01 未通过不能交付');
    equals(unapproved.data.error.code, 'not_approved', '错误码 not_approved');
    const { data: offer } = await creator.post(`/api/versions/${v2.id}/deliver`, { deviceId: laptopToken });
    deliveryId = offer.deliveryId;
    equals(offer.fileCount, 8, '交付文件数');
    equals(offer.versionCode, 'V02', '交付版本号');
  });

  await step('接收端自动拉取、校验并落盘，两端结果一致', async () => {
    const agentApi = new Api(`http://127.0.0.1:${AGENT_PORT}`, { label: '接收端' });
    const done = await waitForCondition(async () => {
      const { data } = await agentApi.get('/api/state');
      const entry = data.deliveries.find((d) => d.deliveryId === deliveryId);
      return entry && (entry.status === 'succeeded' || entry.status === 'failed') ? entry : null;
    }, 60000, '等待接收端完成交付');
    equals(done.status, 'succeeded', `接收端结果：${done.error?.message || done.status}`);
    assert(fs.existsSync(path.join(done.targetDir, '交付说明', '文案终稿.pdf')), 'PDF 应按目录结构保存');
    assert(fs.existsSync(path.join(done.targetDir, '素材', '图片', '主视觉.png')), '图片应按目录结构保存');
    const received = path.join(done.targetDir, '素材', '图片', '主视觉.png');
    equals(sha256FileSync(received), v2.files.find((f) => f.display_name === '主视觉.png').sha256, '接收端文件哈希应与批准版本一致');
    const parts = fs.readdirSync(done.targetDir, { recursive: true }).filter((p) => String(p).endsWith('.part'));
    equals(parts.length, 0, '不应留下 .part 临时文件');
    const hostSide = await waitForCondition(async () => {
      const { data } = await creator.get(`/api/deliveries/${deliveryId}`);
      return data.delivery.status === 'succeeded' ? data.delivery : null;
    }, 15000, '等待创作者端确认');
    equals(hostSide.ok_count, 8, '创作者端记录的成功数');
    equals(hostSide.version_code, 'V02', '记录对应批准版本');
    const { data: v2After } = await creator.get(`/api/versions/${v2.id}`);
    equals(v2After.status, 'delivered', '版本状态应变为已交付');
  });

  await step('接收端磁盘空间不足时，交付明确失败并给出原因', async () => {
    const { data: approved } = await creator.get(`/api/versions/${v2.id}`);
    equals(approved.status, 'delivered', '已交付过的批准版本仍可再次交付给别的电脑');
    const { data: pairing } = await creator.post('/api/devices/pairing', { role: 'receiver', label: '备用笔记本' });
    const redeemed = await new Api(HOST_URL, { label: '备用接收设备' }).post('/api/pair/redeem', {
      code: pairing.code,
      name: '备用笔记本',
      platform: 'Windows 11',
    });
    await creator.post(`/api/devices/${redeemed.data.deviceId}/approve`, { role: 'receiver', canReceive: true });
    const { data: offer } = await creator.post(`/api/versions/${v2.id}/deliver`, { deviceId: redeemed.data.deviceId });
    // 该设备没有真正运行接收端，用它的凭据模拟“剩余空间不足”的回报
    const probe = new Api(HOST_URL, { token: redeemed.data.token, label: '模拟接收端' });
    const r = await probe.raw('POST', `/api/me/deliveries/${offer.deliveryId}/accept`, { targetDir: offer.targetDir, freeBytes: 128 });
    equals(r.status, 507, '空间不足应返回 507');
    equals(r.data.error.code, 'receiver_no_space', '错误码 receiver_no_space');
    const { data: got } = await creator.get(`/api/deliveries/${offer.deliveryId}`);
    const dl = got.delivery;
    equals(dl.status, 'failed', '交付记录应停留在失败而不是成功');
    assert(dl.error_message.includes('空间不足'), `失败原因应可读：${dl.error_message}`);
  });

  await step('接收端离线时交付标记为中断，上线后可继续', async () => {
    agent.child.kill('SIGKILL');
    await sleep(500);
    const { data: offer } = await creator.post(`/api/versions/${v2.id}/deliver`, { deviceId: laptopToken });
    const secondDelivery = offer.deliveryId;
    await sleep(1500);
    const stalled = await waitForCondition(
      async () => {
        const { data } = await creator.get(`/api/deliveries/${secondDelivery}`);
        return ['stalled', 'failed'].includes(data.delivery.status) ? data.delivery : null;
      },
      90000,
      '等待被判定为中断',
      4000,
    );
    assert(stalled.error_message.length > 5, '应给出中断原因');
    agent = spawnNode(['agent/index.js', '--no-open'], {
      LANREVIEW_RECEIVER_DIR: path.join(TMP, 'receiver'),
      LANREVIEW_AGENT_PORT: String(AGENT_PORT),
    }, 'agent2');
    await waitForAgent(AGENT_PORT);
    await creator.post(`/api/deliveries/${secondDelivery}/retry`, {});
    const agentApi = new Api(`http://127.0.0.1:${AGENT_PORT}`, { label: '接收端2' });
    const recovered = await waitForCondition(async () => {
      const { data } = await agentApi.get('/api/state');
      const entry = data.deliveries.find((d) => d.deliveryId === secondDelivery);
      return entry?.status === 'succeeded' ? entry : null;
    }, 60000, '接收端上线后自动续传');
    equals(recovered.status, 'succeeded', '恢复后应完成交付');
    const hostSide = await waitForCondition(async () => {
      const { data } = await creator.get(`/api/deliveries/${secondDelivery}`);
      return data.delivery.status === 'succeeded' ? data.delivery : null;
    }, 20000, '创作者端确认恢复');
    equals(hostSide.attempts >= 1, true, '应记录接收端接受次数');
    equals(hostSide.status, 'succeeded', '创作者端应显示交付成功');
  });

  await step('创作者取消授权后，设备立刻失去访问', async () => {
    await creator.post(`/api/devices/${phoneDevice.deviceId}/revoke`, {});
    const r = await phone.raw('GET', '/api/me/tasks');
    equals(r.status, 403, '被吊销设备应被拒绝');
    equals(r.data.error.code, 'device_revoked', '错误码 device_revoked');
    const media = await phone.raw('GET', `/api/me/versions/${v2.id}`);
    equals(media.status, 403, '被吊销设备也不能读取版本');
  });

  await step('取消的交付不会被接收端接收', async () => {
    const { data: offer } = await creator.post(`/api/versions/${v2.id}/deliver`, { deviceId: laptopToken });
    const { data: cancelRes } = await creator.post(`/api/deliveries/${offer.deliveryId}/cancel`, {});
    equals(cancelRes.delivery.status, 'cancelled', '应标记为已取消');
    const agentApi = new Api(`http://127.0.0.1:${AGENT_PORT}`, { label: '接收端' });
    const { data: st } = await agentApi.get('/api/state');
    assert(!st.deliveries.find((d) => d.deliveryId === offer.deliveryId && d.status === 'succeeded'), '取消的任务不应成功');
  });

  await step('重启后项目、版本、评论、交付记录都还在', async () => {
    const snapshotBefore = await creator.get('/api/activity');
    host.child.kill('SIGKILL');
    await sleep(700);
    host = spawnNode(['server/index.js', '--no-open'], {
      LANREVIEW_PORT: String(HOST_PORT),
      LANREVIEW_DATA_DIR: DATA,
    }, 'host2');
    await waitForHost(HOST_PORT);
    creator = new Api(`http://127.0.0.1:${HOST_PORT}`, { creator: true, label: '重启后创作者' });
    const { data: ws } = await creator.get('/api/workspace');
    equals(ws.workspace.path, WS, '应记住上次的选择');
    const { data: projects } = await creator.get('/api/projects');
    equals(projects.projects.length, 2, '项目数量');
    const { data: detail } = await creator.get(`/api/versions/${v2.id}`);
    equals(detail.files.length, 8, 'V02 文件仍在');
    equals(detail.deliveries.length >= 3, true, '交付记录仍在');
    equals(detail.comments.length, 0, 'V02 本身没有意见');
    const { data: v1After } = await creator.get(`/api/versions/${v1.id}`);
    equals(v1After.comments.length, 2, 'V01 的评论重启后仍在');
    equals(v1After.reviews.length, 1, 'V01 的审核结论重启后仍在');
    equals(detail.status, 'delivered', '状态仍在');
    assert(snapshotBefore.data.activity.length > 10, '应有操作历史');
    const { data: stats } = await creator.get('/api/system');
    assert(stats.stats.delivered >= 2, `交付统计：${JSON.stringify(stats.stats)}`);
  });

  const ok = summary('全流程');
  if (!ok) {
    for (const { label, log } of children) {
      const tail = log.join('').split('\n').slice(-25).join('\n');
      if (tail.trim()) console.log(`\n--- ${label} 输出 ---\n${tail}`);
    }
  }
  console.log(`\n临时目录：${TMP}`);
  console.log(`保留供浏览器验证：workspace=${WS}`);
  fs.writeFileSync(path.join(TMP, 'flow-info.json'), JSON.stringify({ TMP, WS, HOST_URL, HOST_PORT, projectId, v1: v1?.id, v2: v2?.id }, null, 2));
  killAll();
  process.exit(ok ? 0 : 1);
}

async function waitForCondition(fn, timeoutMs, label, intervalMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      if (Date.now() - started > timeoutMs - 2000) throw err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label}：等待 ${timeoutMs}ms 后仍未满足条件`);
}

async function deviceToken(deviceId) {
  const dbFile = path.join(WS, '.lanreview', 'review.db');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare('SELECT token FROM devices WHERE id = ?').get(deviceId);
  } finally {
    db.close();
  }
}

main().catch(async (err) => {
  console.error('\n测试异常终止：', err.message);
  for (const { label, log } of children) {
    const tail = log.join('').split('\n').slice(-30).join('\n');
    if (tail.trim()) console.log(`\n--- ${label} 输出 ---\n${tail}`);
  }
  resetResults();
  summary('全流程（异常终止）');
  killAll();
  process.exit(1);
});
