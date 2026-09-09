import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip, walkFiles } from './zip.js';
import { formatBytes } from '../server/lib/util.js';

const INCLUDE_DIRS = ['server', 'agent', 'web'];
const EXCLUDE = [`${path.sep}dist${path.sep}`, `${path.sep}.lanreview${path.sep}`, `${path.sep}node_modules${path.sep}`, '.DS_Store'];

const LAUNCH_MAC = `#!/bin/bash
# 双击启动「接收端」（macOS）
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装：https://nodejs.org/zh-cn/ （LTS 版本）"
  read -r -p "按回车键关闭..." _
  exit 1
fi
node agent/index.js --agent
`;

const LAUNCH_LINUX = `#!/bin/bash
# 双击启动「接收端」（Linux）
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js，请先安装 Node.js 18 以上版本。"
  read -r -p "按回车键关闭..." _
  exit 1
fi
node agent/index.js --agent
`;

const LAUNCH_WIN = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==1 (
  echo 没有找到 Node.js。请先安装 LTS 版本： https://nodejs.org/zh-cn/
  pause
  exit /b 1
)
node agent\\index.js --agent
`;

const README = `# 接收端（装在收文件的电脑上）

这个压缩包只需要放在**用来接收成片的那台电脑**上。创作者电脑不需要复制任何东西。

## 使用步骤

1. 确认这台电脑装了 Node.js（LTS 版本，https://nodejs.org/zh-cn/ ）。
2. 解压本压缩包，双击运行：
   - macOS：\`启动接收端.command\`（若提示无法打开，请在文件上右键选择“打开”）
   - Windows：\`启动接收端.bat\`
   - Linux：\`启动接收端.sh\`
3. 浏览器会自动打开接收端页面。第一次使用时：
   - 输入创作者电脑上显示的局域网地址（例如 \`http://192.168.1.20:8780\`）
   - 输入创作者页面上生成的 6 位配对码
   - 选择这台电脑保存交付文件的文件夹
4. 回到创作者电脑，在「设备连接」里点“允许”，之后交付会自动进入这台电脑。

接收端页面保持打开即可（可以最小化），交付时页面会显示进度、保存位置和校验结果。

## 数据放在哪里

- 交付的文件：你选择的接收文件夹（例如 \`桌面/客户交付\/\`）
- 接收端的记录和设置：解压目录里的 \`.lanreview-receiver/\`
`;

export function buildReceiverKit({ repoRoot, quiet = false } = {}) {
  const root = path.resolve(repoRoot || process.cwd());
  const outDir = path.join(root, 'dist');
  const outFile = path.join(outDir, 'lanreview-receiver-kit.zip');
  const prefix = 'lanreview/';
  const entries = [];

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  entries.push({ name: `${prefix}package.json`, data: JSON.stringify({ ...pkg, name: 'lanreview-receiver' }, null, 2) });
  entries.push({ name: `${prefix}README-接收端.md`, data: README });
  entries.push({ name: `${prefix}启动接收端.command`, data: LAUNCH_MAC, mode: 0o755 });
  entries.push({ name: `${prefix}启动接收端.sh`, data: LAUNCH_LINUX, mode: 0o755 });
  entries.push({ name: `${prefix}启动接收端.bat`, data: LAUNCH_WIN.replace(/\n/g, '\r\n') });

  for (const dir of INCLUDE_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walkFiles(abs, { filter: (p) => !EXCLUDE.some((bad) => p.includes(bad)) })) {
      entries.push({
        name: `${prefix}${dir}/${file.name.split(path.sep).join('/')}`,
        data: fs.readFileSync(file.abs),
        mode: file.name.endsWith('.command') || file.name.endsWith('.sh') ? 0o755 : 0o644,
      });
    }
  }

  const zip = createZip(entries);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, zip);
  const info = {
    available: true,
    file: outFile,
    size: zip.length,
    sizeLabel: formatBytes(zip.length),
    entries: entries.length,
    buildAt: fs.statSync(outFile).mtime.toISOString(),
  };
  if (!quiet) console.log(`接收端安装包已生成：${outFile}（${info.sizeLabel}，${entries.length} 个文件）`);
  return info;
}

function newestSourceMtime(root) {
  let newest = 0;
  for (const dir of INCLUDE_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walkFiles(abs, { filter: (p) => !EXCLUDE.some((bad) => p.includes(bad)) })) {
      const m = fs.statSync(file.abs).mtimeMs;
      if (m > newest) newest = m;
    }
  }
  const pkg = path.join(root, 'package.json');
  if (fs.existsSync(pkg)) newest = Math.max(newest, fs.statSync(pkg).mtimeMs);
  return newest;
}

export async function ensureReceiverKit(root, { force = false } = {}) {
  const repoRoot = path.resolve(root);
  const outFile = path.join(repoRoot, 'dist', 'lanreview-receiver-kit.zip');
  if (!force && fs.existsSync(outFile)) {
    const zipMtime = fs.statSync(outFile).mtimeMs;
    if (zipMtime >= newestSourceMtime(repoRoot)) {
      const size = fs.statSync(outFile).size;
      return { available: true, file: outFile, size, sizeLabel: formatBytes(size), reused: true, buildAt: new Date(zipMtime).toISOString() };
    }
  }
  return buildReceiverKit({ repoRoot, quiet: true });
}

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  buildReceiverKit({ repoRoot: REPO_ROOT });
}
