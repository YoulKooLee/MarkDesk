# MarkDesk 桌面版

本地离线 Markdown 轻量编辑器的桌面应用（Electron）。渲染层与原型层**同源**，不维护第二套界面代码。

| 项 | 值 |
|---|---|
| 运行时 | Electron 44.4.3 / Chromium / Node 24 |
| 目标平台 | Windows ARM64（本机 Qualcomm ARMv8） |
| 界面来源 | `../src/prototypes/markdesk/`（原型层源码，零分叉） |
| 规格真源 | `../docs/01-需求与规划/MarkDesk-SRS需求规格说明书-V1.0.md` |
| 载体适配 | `../docs/02-架构与设计/MarkDesk-详细设计.md` |

## 目录

```
desktop/
  main.cjs              主进程：窗口与生命周期 / 原生菜单 / 系统对话框 / 磁盘读写 / 最近文件
  preload.cjs           预加载桥：contextBridge 暴露 window.markdesk（渲染层唯一外部入口）
  renderer/
    index.html          渲染层宿主页（含 CSP）
    main.tsx            渲染层入口：挂载 MarkDeskApp
  build-renderer.mjs    用工程既有 esbuild 构建渲染层 → dist/
  run.mjs               启动（后台窗口 / --selftest 自检）
  verify-ui.mjs         桌面版 UI 实测台：自起 Electron + 连 CDP 驱动交互 + 截图断言
  verify-actions.json   实测动作脚本（默认）
  pack.mjs              打包免安装目录版 → release/
```

## 常用命令

```bash
node build-renderer.mjs     # 构建渲染层（产物 dist/）
node run.mjs                # 启动窗口（日志写 .logs/app.log）
node run.mjs --selftest     # 端到端自检：截屏 + IPC 全链路 + 原生菜单 + 磁盘回读
node verify-ui.mjs          # UI 交互实测（截图与断言进 .logs/ui/）
node pack.mjs               # 打包 → release/MarkDesk-win32-arm64/MarkDesk.exe
```

## 桌面版相对原型版的能力差异

| 能力 | 原型版（浏览器宿主） | 桌面版（Electron 宿主） |
|---|---|---|
| 打开文件 | File System Access API，降级为 `<input type=file>` | 系统文件对话框，拿到**真实磁盘路径** |
| 写回同一文件 | 需句柄，浏览器可能不支持 → 降级为下载 | 原路径原子写入（临时文件 + 改名） |
| 最近文件 | 只有文件名，点开要重新选一次 | 存绝对路径，**直接打开** |
| 编码 | 读取回退 GBK；写入恒 UTF-8 | 读取识别 GBK/BOM，**回写保持原编码** |
| 菜单 | 页面内按钮 | 原生菜单（含快捷键） |
| 关闭拦截 | `beforeunload` 原生提示 | 三选项对话框，保存成功才退出 |
| 外部打开 | 不支持 | 拖到 exe、命令行、二次实例均可 |
| 窗口状态 | 无 | 记忆大小与位置 |

## 宿主自适应机制

渲染层通过 `lib/fileBridge.ts` 自动判定宿主：存在 `window.markdesk` 即走主进程 IPC，否则走浏览器链路。
组件层（TopBar / Sidebar / FormatToolbar / EditorPane / PreviewPane）**不感知宿主差异**，因此原型与桌面版共用同一份源码。

## 已知边界

- 系统文件对话框（打开/另存为/导出位置）无法无头自动化，属**人工验收项**；同源的写盘/读取接口由 `--selftest` 覆盖。
- 打包产出为免安装目录版；安装包（NSIS）与文件关联未做，需要时再补。
- 未做签名，首次运行可能触发 SmartScreen 提示。
