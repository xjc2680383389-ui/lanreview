import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extOf, fileKind, formatBytes, previewSupport, sanitizeSegment, uniqueName } from '../server/lib/util.js';
import { parseRange } from '../server/lib/http.js';
import { safeJoin } from '../server/lib/fsx.js';
import { buildReceiverKit } from '../packaging/build-receiver-kit.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let passed = 0;
let failed = 0;
let chain = Promise.resolve();

function test(name, fn) {
  chain = chain.then(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`  ✗ ${name}\n      ${err.message}`);
    }
  });
}

function spawnNode(args, env) {
  return spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function waitForJson(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`等待 ${url} 超时`);
}

console.log('\n单元测试');

test('文件类型识别覆盖常见素材格式', () => {
  assert.equal(fileKind('主视觉.png'), 'image');
  assert.equal(fileKind('视频小样.MP4'), 'video');
  assert.equal(fileKind('文案终稿.pdf'), 'pdf');
  assert.equal(fileKind('排期表.csv'), 'sheet');
  assert.equal(fileKind('演示.pptx'), 'slides');
  assert.equal(fileKind('工程文件.psd'), 'other');
  assert.equal(extOf('a.tar.gz'), 'gz');
});

test('预览能力判定区分可播/可能不可播/不可预览', () => {
  assert.equal(previewSupport('a.png').preview, 'inline');
  assert.equal(previewSupport('a.mp4').preview, 'inline');
  assert.equal(previewSupport('a.mkv').preview, 'none');
  assert.equal(previewSupport('a.mov').preview, 'maybe');
  assert.equal(previewSupport('a.heic').preview, 'none');
  assert.equal(previewSupport('a.psd').preview, 'none');
  assert.ok(previewSupport('a.psd').reason.length > 4, '不可预览必须给出原因');
});

test('项目名清洗保留中文并拒绝路径穿越', () => {
  assert.equal(sanitizeSegment('春季/新品:*?'), '春季_新品___');
  const s = sanitizeSegment('../../etc');
  assert.ok(!/[\\/]/.test(s) && s !== '.' && s !== '..', `清洗后应是一个安全片段，实际 ${s}`);
  assert.equal(sanitizeSegment('   '), '未命名');
  assert.equal(sanitizeSegment('悦活 春季'), '悦活 春季');
});

test('同名文件自动加序号而不是互相覆盖', () => {
  const used = new Set(['a.png']);
  assert.equal(uniqueName('a.png', used), 'a-2.png');
  assert.equal(uniqueName('素材/b.png', used), '素材/b.png');
  assert.equal(uniqueName('素材/a.png', new Set(['素材/a.png'])), '素材/a-2.png');
});

test('字节数显示可读', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
});

test('HTTP Range 解析支持视频拖动所需语义', () => {
  assert.deepEqual(parseRange('bytes=0-499', 1000), { start: 0, end: 499 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  assert.equal(parseRange('bytes=abc', 1000), null);
  assert.equal(parseRange('bytes=1200-', 1000), null);
});

test('快照路径不允许跳出所在目录', () => {
  const root = path.join(os.tmpdir(), 'lr-unit');
  assert.equal(safeJoin(root, '../../etc/passwd'), path.join(path.resolve(root), 'etc', 'passwd'));
  assert.ok(!safeJoin(root, 'a/../../b.txt').includes(`${path.sep}..`), '不得出现上级穿越');
});

test('接收端安装包解压后可以直接运行（真用户路径）', async () => {
  const info = buildReceiverKit({ repoRoot: ROOT, quiet: true });
  assert.ok(fs.existsSync(info.file), '安装包应已生成');
  assert.ok(info.size > 20_000, `安装包不应为空（${info.size}）`);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-kit-'));
  const names = extractWithSystemTool(info.file, out);
  for (const need of ['lanreview/agent/index.js', 'lanreview/server/index.js', 'lanreview/web/creator/app.js', 'lanreview/web/shared/ui.js', 'lanreview/启动接收端.command', 'lanreview/启动接收端.bat', 'lanreview/README-接收端.md']) {
    assert.ok(names.includes(need), `安装包缺少 ${need}（实际 ${names.length} 项）`);
  }
  assert.ok(!names.some((n) => n.includes('node_modules') || n.includes('/dist/')), '不应打包依赖与产物');
  const pkg = JSON.parse(fs.readFileSync(path.join(out, 'lanreview', 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'lanreview-receiver');
  const launcher = fs.readFileSync(path.join(out, 'lanreview', '启动接收端.command'), 'utf8');
  assert.ok(launcher.includes('agent/index.js'), '启动脚本应运行接收端');

  const port = 8896;
  const child = spawnNode([path.join(out, 'lanreview', 'agent', 'index.js'), '--no-open'], {
    LANREVIEW_RECEIVER_DIR: path.join(out, 'receiver-state'),
    LANREVIEW_AGENT_PORT: String(port),
  });
  try {
    const state = await waitForJson(`http://127.0.0.1:${port}/api/state`, 20000);
    assert.equal(state.app.role, 'receiver', '解压后的接收端应能启动并回答状态');
    assert.ok(state.localUrl.includes(String(port)), '应报告本机地址');
    console.log(`      （安装包 ${info.sizeLabel} · ${info.entries} 个文件 · 解压后可直接启动）`);
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    fs.rmSync(out, { recursive: true, force: true });
  }
});

/** Unzip using whatever the host OS provides, so we test the real user path. */
function extractWithSystemTool(zipFile, destDir) {
  const rel = path.relative(process.cwd(), zipFile).split(path.sep).join('/');
  const relOut = path.relative(process.cwd(), destDir).split(path.sep).join('/');
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force`,
    ], { encoding: 'utf8' });
  } else {
    try {
      execFileSync('unzip', ['-o', '-q', rel, '-d', relOut], { cwd: process.cwd(), stdio: 'ignore' });
    } catch {
      execFileSync('tar', ['-xf', rel, '-C', relOut], { cwd: process.cwd() });
    }
  }
  const names = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else names.push(path.relative(destDir, abs).split(path.sep).join('/'));
    }
  };
  walk(destDir);
  return names;
}

await chain;
console.log(`\n单元测试：${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
