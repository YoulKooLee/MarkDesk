/**
 * MarkDesk 桌面版 · 预加载桥（contextBridge）
 * 规格真源：docs/02-架构与设计/MarkDesk-详细设计.md §八 对内接口契约
 *
 * 安全基线：contextIsolation=true / nodeIntegration=false / sandbox=false（ESM preload 要求）
 * 渲染层只能看到本文件显式暴露的方法，拿不到 Node 与 ipcRenderer 本体。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const MENU_CHANNEL = 'menu:command';
const OPEN_CHANNEL = 'files:open';

contextBridge.exposeInMainWorld('markdesk', {
  isDesktop: true,

  /** 应用与运行环境信息 */
  info: () => ipcRenderer.invoke('app:info'),

  /* ---- 文件：打开 / 导入 / 保存 / 导出 ---- */
  openFile: (startDir) => ipcRenderer.invoke('file:open', { startDir }),
  openPath: (filePath) => ipcRenderer.invoke('file:openPath', filePath),
  openImport: (startDir) => ipcRenderer.invoke('file:openImport', { startDir }),
  saveAs: (options) => ipcRenderer.invoke('file:saveAs', options),
  writeFile: (payload) => ipcRenderer.invoke('file:write', payload),
  exportFile: (payload) => ipcRenderer.invoke('file:export', payload),

  /* ---- 阶段二：便携文档 / 图片导出（宿主渲染能力） ---- */
  exportPdf: (payload) => ipcRenderer.invoke('file:exportPdf', payload),
  exportImage: (payload) => ipcRenderer.invoke('file:exportImage', payload),

  /* ---- 阶段二：图片插入与资源夹落盘 ---- */
  pickImage: (startDir) => ipcRenderer.invoke('asset:pick', { startDir }),
  writeAssets: (payload) => ipcRenderer.invoke('asset:write', payload),
  readAssets: (docPath, docName) => ipcRenderer.invoke('asset:read', { docPath, docName }),

  /** 取拖入文件的真实磁盘路径（Electron 32+ 移除了 File.path，改用 webUtils） */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  /* ---- 窗口状态 ---- */
  setDirty: (dirty) => ipcRenderer.send('app:dirty', Boolean(dirty)),
  quitReady: () => ipcRenderer.invoke('quit:ready'),
  quitCancel: () => ipcRenderer.invoke('quit:cancel'),
  reveal: (filePath) => ipcRenderer.invoke('shell:reveal', filePath),

  /* ---- 主进程 → 渲染层 ---- */
  onMenuCommand: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(MENU_CHANNEL, listener);
    return () => ipcRenderer.removeListener(MENU_CHANNEL, listener);
  },
  onOpenFiles: (handler) => {
    const listener = (_event, paths) => handler(paths);
    ipcRenderer.on(OPEN_CHANNEL, listener);
    return () => ipcRenderer.removeListener(OPEN_CHANNEL, listener);
  },
});
