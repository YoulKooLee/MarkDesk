/**
 * 打包：@electron/packager 产出免安装目录版（可直接双击 MarkDesk.exe 运行）。
 * 目标平台跟随本机：Windows / ARM64。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'release');

process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';

const TARGET_PLATFORM = process.env.MARKDESK_TARGET_PLATFORM || 'win32';
const TARGET_ARCH = process.env.MARKDESK_TARGET_ARCH || 'arm64';

/**
 * 只摘除「软链」，绝不触碰真实目录。
 * 判定：lstat 报告 isSymbolicLink() 才动手。
 */
function removeSymlink(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) return false;
  try {
    fs.unlinkSync(target);
    return true;
  } catch {
    try {
      fs.rmdirSync(target);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * npm 会在 node_modules 下建「指向工程根」的自引用软链（node_modules/<自身包名>）。
 * 它不是运行时依赖，但打包器的依赖遍历会顺着它走进整个工程根，最终报
 * "Failed to locate module ..."。打包前先摘掉。
 */
function stripSelfLinks() {
  const nm = path.join(HERE, 'node_modules');
  if (!fs.existsSync(nm)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(nm)) {
    const full = path.join(nm, entry);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      if (removeSymlink(full)) removed.push(entry);
      continue;
    }
    if (entry.startsWith('@') && stat.isDirectory()) {
      for (const sub of fs.readdirSync(full)) {
        const scoped = path.join(full, sub);
        if (removeSymlink(scoped)) removed.push(`${entry}/${sub}`);
      }
      try {
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      } catch {
        /* 非空则保留 */
      }
    }
  }
  return removed;
}

async function main() {
  if (!fs.existsSync(path.join(HERE, 'dist', 'index.html'))) {
    throw new Error('渲染层产物缺失，请先执行：npm run build');
  }

  const stripped = stripSelfLinks();
  console.log('[pack] 摘除自引用软链：' + (stripped.length ? stripped.join(', ') : '（无）'));

  const [appPath] = await packager({
    dir: HERE,
    out: OUT_DIR,
    name: 'MarkDesk',
    platform: TARGET_PLATFORM,
    arch: TARGET_ARCH,
    overwrite: true,
    asar: true,
    prune: true,
    appVersion: '0.1.0',
    ignore: [
      /^\/\.logs/,
      /^\/release/,
      /^\/renderer/,
      /^\/build-renderer\.mjs$/,
      /^\/run\.mjs$/,
      /^\/pack\.mjs$/,
      // 实测台全部产物（UI 实测台 verify-ui.mjs / 动作脚本 verify-actions-*.json /
      // 对话框实测台 verify-dialogs-stub.cjs 与其配置）一律不进包：
      // 它们只在开发期跑，进包只会白占体积且暴露内部断言。
      /^\/verify-[^/]*\.(mjs|cjs|json)$/,
      /^\/README\.md$/,
      /^\/package-lock\.json$/,
      // npm 会在 node_modules 下建「指向工程根」的自引用软链，打包器会顺着它走进整个工程根，
      // 必须排除，否则 prune 阶段报 Failed to locate module。
      /^\/node_modules\/\.package-lock\.json$/,
      /^\/node_modules\/@axhub/,
    ],
    win32metadata: {
      CompanyName: 'MarkDesk',
      FileDescription: 'MarkDesk 本地离线 Markdown 编辑器',
      ProductName: 'MarkDesk',
      InternalName: 'MarkDesk',
    },
  });

  const exeName = TARGET_PLATFORM === 'win32' ? 'MarkDesk.exe' : 'MarkDesk';
  const exe = path.join(appPath, exeName);
  console.log('[pack] 打包完成');
  console.log(`  产物目录：${appPath}`);
  console.log(`  可执行文件：${exe}（${fs.existsSync(exe) ? Math.round(fs.statSync(exe).size / 1024) + ' KB' : '缺失'})`);
}

main().catch((error) => {
  console.error('[pack] 失败：' + error.message);
  process.exitCode = 1;
});
