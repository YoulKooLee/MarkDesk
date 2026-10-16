/**
 * 启动桌面应用。
 *   node run.mjs              → 后台启动窗口（日志写 .logs/app.log）
 *   node run.mjs --selftest   → 前台自检：截屏 + 度量 + 自动退出
 *   MARKDESK_DEBUG_PORT=9333 node run.mjs  → 附带远程调试端口，供无头交互实测
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, '.logs');
const RENDERER_ENTRY = path.join(HERE, 'dist', 'index.html');

function resolveElectron() {
  const distDir = path.join(HERE, 'node_modules', 'electron', 'dist');
  const candidates = [
    path.join(distDir, 'electron.exe'),
    path.join(distDir, 'electron'),
    path.join(distDir, 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  ];
  const hit = candidates.find((item) => fs.existsSync(item));
  if (hit) return hit;

  const pathTxt = path.join(HERE, 'node_modules', 'electron', 'path.txt');
  if (fs.existsSync(pathTxt)) {
    const rel = fs.readFileSync(pathTxt, 'utf8').trim();
    const abs = path.join(distDir, '..', rel);
    if (fs.existsSync(abs)) return abs;
  }
  throw new Error('未找到 Electron 可执行文件，请先在 desktop/ 下执行 npm install');
}

function main() {
  if (!fs.existsSync(RENDERER_ENTRY)) {
    throw new Error('渲染层产物缺失，请先执行：npm run build');
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const electron = resolveElectron();
  const extra = process.argv.slice(2);
  const args = [HERE, ...extra];
  const debugPort = process.env.MARKDESK_DEBUG_PORT;
  if (debugPort) args.push(`--remote-debugging-port=${debugPort}`);

  const env = {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  };
  // 宿主 shell（WorkBuddy/VS Code 这类 Electron 宿主）会注入 ELECTRON_RUN_AS_NODE=1，
  // 会让 electron.exe 退化成纯 Node，require('electron') 拿不到 app 等 API —— 必须清掉。
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  if (extra.includes('--selftest')) {
    const result = spawnSync(electron, args, { stdio: 'inherit', env, cwd: HERE });
    console.log(`[run] 自检退出码 ${result.status}`);
    return;
  }

  const logFile = path.join(LOG_DIR, 'app.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(electron, args, {
    detached: true,
    stdio: ['ignore', out, out],
    env,
    cwd: HERE,
  });
  child.unref();
  console.log(`[run] 已启动 MarkDesk（PID ${child.pid}）`);
  console.log(`[run] 可执行文件：${electron}`);
  console.log(`[run] 日志：${logFile}`);
  if (debugPort) console.log(`[run] 远程调试端口：${debugPort}`);
}

main();
