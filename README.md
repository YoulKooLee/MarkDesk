# MarkDesk

本地离线 Markdown 轻量编辑器的桌面版（Electron）。数据全部留在本机，不联网、不上传。

| 项 | 值 |
|---|---|
| 运行时 | Electron 44.4.3 / Chromium 130 / Node 24 |
| 目标平台 | Windows ARM64（已在 Qualcomm ARMv8 实测）；其他平台需自行换arch 重打包 |
| 界面来源 | `src/prototypes/markdesk/`（渲染层与原型层同源，零分叉） |

## 直接下载运行（无需构建）

不想装 Node、只想直接用：**Releases → [v0.1.0](https://github.com/YoulKooLee/MarkDesk-app/releases/tag/v0.1.0)**
下载 `MarkDesk-0.1.0-win-arm64.zip`（约 153MB），解压后双击 `MarkDesk.exe` 即可，**免安装**。

> 注意：该 zip 是**绿色版**（解压即用），不是安装包。当前 Windows ARM64 下的
> NSIS 安装包存在解压缺失问题，暂不提供。

## 目录结构

```
.
  desktop/                     桌面端（Electron）
    main.cjs                   主进程：窗口与生命周期 / 原生菜单 / 系统对话框 / 磁盘读写 / 最近文件
    preload.cjs                预加载桥：contextBridge 暴露 window.markdesk
    renderer/
      index.html               渲染层宿主页（含 CSP）
      main.tsx                渲染层入口，挂载 MarkDeskApp
    build-renderer.mjs         渲染层构建（esbuild 单入口打包 → dist/）
    run.mjs                    开发启动（node run.mjs，日志写 .logs/）
    pack.mjs                   免安装绿色版打包
    dist/                      渲染层构建产物（由 npm run build 生成）
  src/prototypes/markdesk/渲染层源码（与桌面版同源，不做第二套界面）
```

## 环境要求

- Node.js ≥ 20
- Windows ARM64（其他平台见下方「换平台打包」）

## 快速开始

```bash
cd desktop
npm install
npm run build     # 构建渲染层 → dist/
npm start         # 启动应用
```

自检（截屏 + 度量 + 自动退出）：

```bash
npm run selftest
```

## 打包

```bash
# 免安装绿色版（推荐，产物为 zip）
npm run zip

# NSIS 安装包
npm run installer
```

> **已知问题**：在 Windows ARM64 环境下，NSIS 安装包静默安装后可能缺失
> `MarkDesk.exe` 及 Electron 运行时 DLL（安装目录仅约 100MB，应为 390MB）。
> 包体本身完整（`7za` 可正常解开全部 7 个 PE），缺陷在 NSIS 安装器运行时解压环节。
> **请优先使用 `npm run zip` 绿色版**：解压即用，已实测 7 个 PE 全部正常落盘、
> `MarkDesk.exe --version` 正常返回。

### 换平台打包

`win.target` 目前固定 `arm64`。换平台时改 `desktop/package.json`：

```json
"win": { "target": [{ "target": "nsis", "arch": ["x64"] }] }
```

并把 `--win --arm64` 换成 `--win --x64`。

## 技术要点

- **零分叉**：桌面版渲染层直接复用 `src/prototypes/markdesk/`，`build-renderer.mjs`
  只做打包，不维护第二套界面代码。
- **依赖解析**：源文件在 `../src/`，依赖装在 `desktop/node_modules/`，
  esbuild 的 node 解析跨不出仓库结构，故 `build-renderer.mjs` 显式
  `--alias` 到真实安装位置（esbuild 0.21 无 `--node-paths`）。
- **离线字体**：KaTeX 的 woff2 内联为 data URL（Chromium 130 只需这一档），
  woff / ttf 置空，避免同一字体三份重复进包（实测 1.46MB → 370KB）。

## License

MIT
