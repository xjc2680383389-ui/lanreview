import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SUITES = [
  ['单元与打包测试', ['test/unit.mjs']],
  ['二维码自检', ['test/qr.test.mjs']],
  ['全流程端到端测试（真实双进程 + 局域网地址）', ['test/api-flow.mjs']],
];

function run(label, args) {
  return new Promise((resolve) => {
    console.log(`\n=== ${label} ===`);
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
  });
}

const results = [];
for (const [label, args] of SUITES) {
  // eslint-disable-next-line no-await-in-loop
  results.push({ label, ok: await run(label, args) });
}

console.log('\n================ 测试汇总 ================');
for (const r of results) console.log(`  ${r.ok ? '通过' : '失败'}  ${r.label}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`==========================================`);
if (failed) process.exit(1);
