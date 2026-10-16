/**
 * 渲染层构建：复用工程既有 esbuild，把原型 React 源码打成单入口资源。
 * 产物：desktop/dist/{index.html, renderer.js, renderer.css}
 *
 * 复用策略：渲染层源码全部来自 src/prototypes/markdesk/，桌面版只提供入口，
 * 保证「原型 = 桌面版内核」，不做代码分叉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(HERE, 'dist');
const ENTRY = path.join(HERE, 'renderer', 'main.tsx');

function resolveEsbuild() {
  // 共享仓库只有 desktop/ 一层，故同时在工程根与 desktop/ 两处查找 esbuild 二进制。
  const roots = [PROJECT_ROOT, HERE];
  const searched = [];
  for (const root of roots) {
    const base = path.join(root, 'node_modules', '@esbuild', `${process.platform}-${process.arch}`);
    searched.push(base);
    const candidates = [path.join(base, 'esbuild.exe'), path.join(base, 'esbuild')];
    const hit = candidates.find((item) => fs.existsSync(item));
    if (hit) return hit;
  }
  throw new Error(`未找到 esbuild 二进制（查找路径：${searched.join(' | ')}）`);
}

function main() {
  if (!fs.existsSync(ENTRY)) throw new Error(`渲染层入口不存在：${ENTRY}`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const args = [
    ENTRY,
    '--bundle',
    `--outfile=${path.join(OUT_DIR, 'renderer.js')}`,
    '--format=iife',
    '--jsx=automatic',
    '--target=chrome130',
    '--minify',
    '--legal-comments=none',
    '--define:process.env.NODE_ENV="production"',
    // 渲染层源码位于 ../src/，而依赖装在 desktop/node_modules/。
    // esbuild 的 node 解析跟随源文件向上查找，跨不出仓库结构，故显式别名到
    // desktop/node_modules 下真实安装位置（esbuild 0.21 无 --node-paths）。
    ...['react', 'react-dom', 'lucide-react', 'katex', 'mermaid'].flatMap((name) => [
      `--alias:${name}=${path.join(HERE, 'node_modules', name)}`,
    ]),
    // 阶段二：KaTeX 字体随包离线内置。
    // woff2 内联为 data URL（Chromium 130 只需这一档），woff / ttf 置空，
    // 避免同一字体三份重复进包（实测 1.46MB → 370KB）。
    '--loader:.woff2=dataurl',
    '--loader:.woff=empty',
    '--loader:.ttf=empty',
    '--log-level=warning',
  ];

  const result = spawnSync(resolveEsbuild(), args, {
    cwd: HERE,
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (result.status !== 0) throw new Error(`esbuild 构建失败，退出码 ${result.status}`);

  const html = fs.readFileSync(path.join(HERE, 'renderer', 'index.html'), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html, 'utf8');

  const files = fs.readdirSync(OUT_DIR).map((name) => `  ${name}  ${fs.statSync(path.join(OUT_DIR, name)).size}B`);
  console.log('[build] 渲染层构建完成');
  files.forEach((line) => console.log(line));
}

main();
