/**
 * MarkDesk 桌面版 · 主进程
 * 规格真源：docs/01-需求与规划/MarkDesk-SRS需求规格说明书-V1.0.md
 * 载体适配：docs/02-架构与设计/MarkDesk-详细设计.md §七 本地持久化 / §八 对内接口契约
 *
 * 职责边界：窗口与生命周期 / 原生菜单 / 系统文件对话框 / 磁盘读写（含编码保持）/ 最近文件
 * 不承担：Markdown 解析、界面渲染、偏好存储（由渲染层负责，见 LLD §七）
 */
const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const iconv = require('iconv-lite');

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeImage } = electron;

const HERE = __dirname;
const IS_SELFTEST = process.argv.includes('--selftest');
const RENDERER_HTML = path.join(HERE, 'dist', 'index.html');
const LOG_DIR = path.join(HERE, '.logs');

const MD_EXT = ['.md', '.markdown', '.txt'];
const HTML_EXT = ['.html', '.htm'];
const RECENT_LIMIT = 10;

// 阶段二：图片插入与资源夹（SRS 3.5.5.1 / 3.5.5.2）
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
// 单张图片上限 10MB（SRS 3.5.5.1 业务规则）
const IMAGE_SIZE_LIMIT = 10 * 1024 * 1024;
// 隐藏窗口截图的分段高度与段数上限（PNG 整篇导出）
const CAPTURE_SEGMENT = 12000;
const CAPTURE_MAX_SEGMENTS = 12;

// 语言子菜单（SRS 3.5.6.5 十种；内语自称，与渲染层 lang.ts LANG_OPTIONS 对齐）
const LANG_MENU = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ru', label: 'Русский' },
  { code: 'pt', label: 'Português' },
];

const state = {
  win: null,
  dirty: false,
  quitting: false,
  recent: [],
  dirs: { open: null, save: null },
  lang: 'zh-CN',
};

/* ------------------------------------------------------------------ *
 * 记住目录（SRS 3.5.3.7）：上次打开 / 上次写入两条，落盘于 userData
 * ------------------------------------------------------------------ */

function dirsStorePath() {
  return path.join(app.getPath('userData'), 'dir-memory.json');
}

function loadDirs() {
  try {
    const raw = JSON.parse(fs.readFileSync(dirsStorePath(), 'utf8'));
    state.dirs = { open: raw.open || null, save: raw.save || null };
  } catch {
    state.dirs = { open: null, save: null };
  }
}

/** 起点的优先级：显式传入 → 本机记录 → 系统默认（对话框返回后据此回写） */
function resolveStartDir(kind, explicit) {
  const candidate = explicit || state.dirs[kind];
  if (!candidate) return undefined;
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    /* 记录失效：静默退系统默认（SRS 3.5.3.7 边界） */
  }
  return undefined;
}

function rememberDir(kind, filePath) {
  if (!filePath || !state.dirs) return;
  const dir = path.dirname(filePath);
  if (state.dirs[kind] === dir) return;
  state.dirs[kind] = dir;
  try {
    fs.writeFileSync(dirsStorePath(), JSON.stringify(state.dirs, null, 2), 'utf8');
  } catch {
    /* 记住目录失败不影响读写 */
  }
}

/* ------------------------------------------------------------------ *
 * 磁盘读写：编码识别与保持
 * ------------------------------------------------------------------ */

/**
 * 解码：UTF-8 → （含替换字符时）GBK 回退；识别并剥离 BOM。
 * 追踪：SRS F-3.4（编码兼容）
 */
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8-bom' };
  }
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf8' };
  try {
    const gbk = iconv.decode(buf, 'gbk');
    if (gbk && !gbk.includes('\uFFFD')) return { text: gbk, encoding: 'gbk' };
  } catch {
    /* 解码失败保持 utf8 原文 */
  }
  return { text: utf8, encoding: 'utf8' };
}

/** 按原编码回写，避免把用户的 GBK 文档悄悄改成 UTF-8 */
function encodeText(text, encoding) {
  if (encoding === 'gbk') return iconv.encode(text, 'gbk');
  if (encoding === 'utf8-bom') {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  }
  return Buffer.from(text, 'utf8');
}

/** 原子写入：先写同目录临时文件再改名，目标被占用时回退直写 */
function saveToDisk(target, text, encoding) {
  const buf = encodeText(text, encoding);
  const tmp = path.join(path.dirname(target), `.markdesk-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
    return { ok: true };
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不影响主流程 */
    }
    try {
      fs.writeFileSync(target, buf);
      return { ok: true };
    } catch (error) {
      const busy = error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES';
      return { ok: false, error: busy ? '文件被占用，请关闭后重试' : `写入失败：${error.message}` };
    }
  }
}

function readFromDisk(target, exts) {
  const allowed = exts || MD_EXT;
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return { ok: false, error: '不支持打开文件夹' };
    if (!stat.isFile()) return { ok: false, error: '读取失败' };
    const ext = path.extname(target).toLowerCase();
    if (!allowed.includes(ext)) return { ok: false, error: '不支持的文件类型' };
    const { text, encoding } = decodeText(fs.readFileSync(target));
    return { ok: true, data: { name: path.basename(target), path: target, text, encoding } };
  } catch (error) {
    return { ok: false, error: error.code === 'ENOENT' ? '文件不存在或已被移动' : '文件读取失败' };
  }
}

/* ------------------------------------------------------------------ *
 * 最近文件（供原生菜单使用，落盘于 userData）
 * ------------------------------------------------------------------ */

function recentStorePath() {
  return path.join(app.getPath('userData'), 'recent-files.json');
}

function loadRecent() {
  try {
    const raw = fs.readFileSync(recentStorePath(), 'utf8');
    const list = JSON.parse(raw);
    state.recent = Array.isArray(list) ? list.filter((item) => item && item.path) : [];
  } catch {
    state.recent = [];
  }
}

function touchRecent(filePath) {
  const name = path.basename(filePath);
  state.recent = [{ name, path: filePath }, ...state.recent.filter((item) => item.path !== filePath)]
    .slice(0, RECENT_LIMIT);
  try {
    fs.writeFileSync(recentStorePath(), JSON.stringify(state.recent, null, 2), 'utf8');
  } catch {
    /* 最近文件写失败不影响编辑 */
  }
  refreshMenu();
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    const width = Number(raw.width);
    const height = Number(raw.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 640 && height > 400) {
      return { width, height, x: Number.isFinite(raw.x) ? raw.x : undefined, y: Number.isFinite(raw.y) ? raw.y : undefined };
    }
  } catch {
    /* 首次启动无状态文件 */
  }
  return { width: 1280, height: 820, x: undefined, y: undefined };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(windowStatePath(), JSON.stringify(bounds, null, 2), 'utf8');
  } catch {
    /* 忽略 */
  }
}

function createWindow() {
  const bounds = loadWindowState();
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#f6f7f9',
    title: 'MarkDesk',
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  state.win = win;

  win.once('ready-to-show', () => {
    win.show();
    if (IS_SELFTEST) runSelfTest(win);
  });

  win.on('close', (event) => {
    if (state.quitting || !state.dirty) {
      saveWindowState(win);
      return;
    }
    event.preventDefault();
    void askBeforeClose(win);
  });

  win.on('closed', () => {
    state.win = null;
  });

  // 外部链接交给系统浏览器，不在应用窗口内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  win.loadFile(RENDERER_HTML);

  const pending = pendingFileFromArgv();
  if (pending) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => sendOpenPaths([pending]), 300);
    });
  }
  return win;
}

/** 关闭前拦截：三选项，未保存内容另有草稿兜底（SRS 3.5.3.5） */
async function askBeforeClose(win) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['保存并退出', '不保存退出', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: 'MarkDesk',
    message: '当前文档尚未保存',
    detail: '选择「不保存退出」也不会丢内容：编辑器会把未保存内容留存为草稿，下次启动自动恢复。',
  });
  if (response === 2) return;
  if (response === 1) {
    state.quitting = true;
    win.destroy();
    return;
  }
  state.quitting = true;
  win.webContents.send('menu:command', { cmd: 'save', forQuit: true });
}

/* ------------------------------------------------------------------ *
 * 原生菜单
 * ------------------------------------------------------------------ */

const send = (cmd, payload) => {
  if (state.win && !state.win.isDestroyed()) state.win.webContents.send('menu:command', { cmd, ...payload });
};

function buildMenuTemplate() {
  const recentItems = state.recent.length
    ? state.recent.map((item) => ({
        label: item.name,
        toolTip: item.path,
        click: () => send('openPath', { path: item.path }),
      }))
    : [{ label: '（暂无记录）', enabled: false }];  return [
    {
      label: '文件',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: '打开最近', submenu: recentItems },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('saveAs') },
        { label: '导入…', click: () => send('import') },
        { type: 'separator' },
        {
          // 导出五项与顺序对齐线上（SRS 3.5.4 / 差异清单 C1）；PNG/Word/PDF 随阶段二
          label: '导出',
          submenu: [
            { label: '导出 HTML (.html)', click: () => send('export', { format: 'html' }) },
            { label: '导出图片 (.png)', click: () => send('export', { format: 'png' }) },
            { label: '导出 Word (.doc)', click: () => send('export', { format: 'word' }) },
            { label: '导出 PDF (.pdf)', click: () => send('export', { format: 'pdf' }) },
            { label: '导出 Markdown (.md)', click: () => send('export', { format: 'markdown' }) },
          ],
        },
        { label: '在文件夹中显示', click: () => send('reveal') },
        { type: 'separator' },
        { label: '退出', accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        // 撤销/重做走渲染层统一编辑栈（LLD §2.2），不用原生 role，避免与自实现栈打架
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Y', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '查找…', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
        { label: '替换…', accelerator: 'CmdOrCtrl+H', click: () => send('find') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '双栏', accelerator: 'CmdOrCtrl+1', click: () => send('viewMode', { mode: 'both' }) },
        { label: '仅编辑', accelerator: 'CmdOrCtrl+2', click: () => send('viewMode', { mode: 'edit' }) },
        { label: '仅预览', accelerator: 'CmdOrCtrl+3', click: () => send('viewMode', { mode: 'preview' }) },
        { type: 'separator' },
        { label: '目录', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('outline') },
        { label: '全屏', accelerator: 'F11', click: () => send('fullscreen') },
        { type: 'separator' },
        { label: '切换主题', accelerator: 'CmdOrCtrl+D', click: () => send('theme') },
        { label: '显示/隐藏侧栏', accelerator: 'CmdOrCtrl+B', click: () => send('sidebar') },
        {
          label: '语言',
          submenu: LANG_MENU.map((item) => ({
            label: item.label,
            type: 'checkbox',
            checked: item.code === state.lang,
            click: () => { state.lang = item.code; send('lang', { code: item.code }); refreshMenu(); },
          })),
        },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '使用帮助', accelerator: 'F1', click: () => send('help') },
        { label: '全部快捷键', click: () => send('shortcuts') },
        {
          label: '关于 MarkDesk',
          click: () => {
            void dialog.showMessageBox(state.win, {
              type: 'info',
              title: '关于 MarkDesk',
              message: `MarkDesk ${app.getVersion()}`,
              // 注意：这里只写产品自述，不放本机路径（会带出用户名），也不提对标 / 复刻来源
              detail: [
                '专注写作的本地 Markdown 编辑器：双栏实时预览，还能直接在预览里改字。',
                '公式、图表、表格、图片一应俱全，可导出 HTML / Word / PDF / 图片 / Markdown。',
                '全程离线运行，文档与偏好只保存在本机，不联网、不上传。',
                `Electron ${process.versions.electron} ｜ Chromium ${process.versions.chrome} ｜ Node ${process.versions.node}`,
              ].join('\n'),
            });
          },
        },
      ],
    },
  ];
}

function refreshMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 阶段二：导出与资源夹的宿主侧辅助
 * ------------------------------------------------------------------ */

/** 二进制导出目标选择（PDF / PNG 共用） */
async function pickBinaryTarget(payload, title, filterName, ext) {
  const defaultName = String(payload.defaultName || `未命名文档.${ext}`);
  const startDir = resolveStartDir('save', payload.startDir);
  const result = await dialog.showSaveDialog(state.win, {
    title,
    defaultPath: path.join(startDir || path.dirname(defaultName), path.basename(defaultName)),
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, error: '已取消', cancelled: true };
  return { ok: true, path: result.filePath };
}

/** 把待渲染文档写到临时文件：数据量可达 MB 级，写文件比 data URL 稳 */
function writeScratchHtml(html) {
  try {
    const dir = path.join(app.getPath('temp'), 'markdesk-export');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `render-${process.pid}-${Date.now()}.html`);
    fs.writeFileSync(file, html, 'utf8');
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, error: `导出失败：${error.message}` };
  }
}

function removeScratch(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 临时文件清理失败不影响导出结果 */
  }
}

/**
 * 离屏渲染窗口。
 * needPaint=true 时窗口必须真实绘制（截图链路），故置于屏幕外并关闭边框；
 * false 时完全隐藏（打印链路走 printToPDF，不依赖可见性）。
 */
function createRenderWindow(width, height, needPaint) {
  const options = {
    width,
    height,
    frame: false,
    skipTaskbar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 导出文档中的公式与图表已在导出前固化，PDF 链路不需要页面脚本；截图链路需要量尺寸
      javascript: Boolean(needPaint),
      paintWhenInitiallyHidden: true,
      backgroundThrottling: false,
    },
  };
  if (needPaint) {
    options.show = true;
    options.x = -24000;
    options.y = -24000;
  } else {
    options.show = false;
  }
  return new BrowserWindow(options);
}

function settle(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 在截图窗口内量取整篇尺寸（宽取视口宽、高取文档滚动高） */
const MEASURE_SCRIPT = `(() => {
  const root = document.documentElement;
  return { width: Math.ceil(root.scrollWidth), height: Math.ceil(root.scrollHeight) };
})()`;

/** 拼接分段截图：nativeImage 只做逐行拷贝，避免引入图像处理依赖 */
function stitchImages(parts) {
  try {
    const sizes = parts.map((image) => image.getSize());
    const width = sizes[0].width;
    if (!width || sizes.some((size) => size.width !== width)) return null;
    const totalHeight = sizes.reduce((sum, size) => sum + size.height, 0);
    const merged = Buffer.alloc(width * totalHeight * 4);
    let offsetY = 0;
    for (const image of parts) {
      const { height } = image.getSize();
      const bitmap = image.toBitmap();
      bitmap.copy(merged, offsetY * width * 4, 0, Math.min(bitmap.length, width * height * 4));
      offsetY += height;
    }
    return nativeImage.createFromBitmap(merged, { width, height: totalHeight });
  } catch {
    return null;
  }
}

/** 资源夹命名：[文档名去扩展]_assets（SRS 3.5.5.2） */
function assetsFolderName(docName) {
  const base = String(docName || '未命名文档').replace(/\.(md|markdown|txt|html|htm)$/i, '');
  return `${base || '未命名文档'}_assets`;
}

function sanitizeFileName(name) {
  const cleaned = String(name).replace(/[\\/:*?"<>|]/g, '-').trim();
  return cleaned || `image-${Date.now()}.png`;
}

/** 同名避让：追加 -1、-2…（SRS 3.5.5.2 边界：不覆盖既有文件） */
function resolveAssetName(taken, name) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let counter = 1;
  while (taken.has(`${stem}-${counter}${ext}`)) counter += 1;
  return `${stem}-${counter}${ext}`;
}

function readImageFile(target) {
  try {
    const ext = path.extname(target).toLowerCase();
    // 错误一律回机器码，由渲染层映射成界面语言文案
    if (!IMAGE_EXT.includes(ext)) return { ok: false, error: 'unsupported' };
    const buf = fs.readFileSync(target);
    if (buf.length > IMAGE_SIZE_LIMIT) return { ok: false, error: 'too-large' };
    return {
      ok: true,
      data: {
        name: path.basename(target),
        bytes: new Uint8Array(buf),
        mime: IMAGE_MIME[ext] || 'image/png',
        size: buf.length,
      },
    };
  } catch {
    return { ok: false, error: 'unreadable' };
  }
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
    electron: process.versions.electron,
  }));

  ipcMain.handle('file:open', async (_event, options = {}) => {
    if (!state.win) return { ok: false, error: '窗口不可用' };
    const startDir = resolveStartDir('open', options.startDir);
    const result = await dialog.showOpenDialog(state.win, {
      title: '打开 Markdown 文档',
      defaultPath: startDir,
      properties: ['openFile'],
      filters: [
        { name: 'Markdown 文档', extensions: ['md', 'markdown', 'txt'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: '已取消', cancelled: true };
    const read = readFromDisk(result.filePaths[0]);
    if (read.ok) {
      touchRecent(read.data.path);
      rememberDir('open', read.data.path);
    }
    return read;
  });

  /**
   * 导入选择（SRS 3.5.3.6）：.html / .htm 走文本读取；
   * .docx 是二进制包，以 base64 交给渲染层（mammoth 在渲染层解析，避免主进程引入解析依赖）
   */
  ipcMain.handle('file:openImport', async (_event, options = {}) => {
    if (!state.win) return { ok: false, error: '窗口不可用' };
    const startDir = resolveStartDir('open', options.startDir);
    const result = await dialog.showOpenDialog(state.win, {
      title: '导入文档',
      defaultPath: startDir,
      properties: ['openFile'],
      filters: [{ name: '可导入文档', extensions: ['html', 'htm', 'docx'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: '已取消', cancelled: true };
    const target = result.filePaths[0];
    if (/\.docx$/i.test(target)) {
      try {
        const buf = fs.readFileSync(target);
        rememberDir('open', target);
        return {
          ok: true,
          data: {
            name: path.basename(target),
            path: target,
            text: '',
            encoding: 'binary',
            base64: buf.toString('base64'),
          },
        };
      } catch {
        return { ok: false, error: '文件读取失败' };
      }
    }
    const read = readFromDisk(target, [...HTML_EXT]);
    if (read.ok) {
      touchRecent(read.data.path);
      rememberDir('open', read.data.path);
    }
    return read;
  });

  ipcMain.handle('file:openPath', (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: '路径无效' };
    // 允许重开 HTML（导入产物记录的是源文件），.docx 为二进制不在此列
    const read = readFromDisk(filePath, [...MD_EXT, ...HTML_EXT]);
    if (read.ok) {
      touchRecent(read.data.path);
      rememberDir('open', read.data.path);
    }
    return read;
  });

  ipcMain.handle('file:saveAs', async (_event, options = {}) => {
    if (!state.win) return { ok: false, error: '窗口不可用' };
    const suggested = String(options.defaultName || '未命名文档');
    const startDir = resolveStartDir('save', options.startDir);
    const result = await dialog.showSaveDialog(state.win, {
      title: '保存 Markdown 文档',
      defaultPath: path.join(startDir || path.dirname(suggested), path.basename(suggested)),
      filters: [{ name: 'Markdown 文档', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: '已取消', cancelled: true };
    touchRecent(result.filePath);
    rememberDir('save', result.filePath);
    return { ok: true, data: { path: result.filePath, name: path.basename(result.filePath) } };
  });

  ipcMain.handle('file:write', (_event, payload = {}) => {
    const target = typeof payload.path === 'string' ? payload.path : '';
    if (!target) return { ok: false, error: '保存路径缺失' };
    const result = saveToDisk(target, String(payload.text ?? ''), payload.encoding || 'utf8');
    return result.ok ? { ok: true, data: { path: target, name: path.basename(target) } } : result;
  });

  ipcMain.handle('file:export', async (_event, payload = {}) => {
    if (!state.win) return { ok: false, error: '窗口不可用' };
    const kindRaw = String(payload.kind || 'markdown');
    const kind = kindRaw === 'html' ? 'html' : kindRaw === 'word' ? 'word' : 'markdown';
    const EXT_OF = { markdown: 'md', html: 'html', word: 'doc' };
    const TITLE_OF = { markdown: '导出 Markdown 源文件', html: '导出独立网页', word: '导出 Word 文档' };
    const FILTER_OF = {
      markdown: [{ name: 'Markdown 文档', extensions: ['md'] }],
      html: [{ name: '网页文件', extensions: ['html'] }],
      word: [{ name: 'Word 文档', extensions: ['doc'] }],
    };
    const ext = EXT_OF[kind];
    const defaultName = String(payload.defaultName || `未命名文档.${ext}`);
    const startDir = resolveStartDir('save', payload.startDir);
    const result = await dialog.showSaveDialog(state.win, {
      title: TITLE_OF[kind],
      defaultPath: path.join(startDir || path.dirname(defaultName), path.basename(defaultName)),
      filters: FILTER_OF[kind],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: '已取消', cancelled: true };
    const saved = saveToDisk(result.filePath, String(payload.text ?? ''), 'utf8');
    if (saved.ok) rememberDir('save', result.filePath);
    return saved.ok ? { ok: true, data: { path: result.filePath, name: path.basename(result.filePath) } } : saved;
  });

  /* ---- 阶段二：便携文档（隐藏窗口打印）与图片（隐藏窗口截图） ---- */

  ipcMain.handle('file:exportPdf', async (_event, payload = {}) => {
    if (!state.win) return { ok: false, error: '窗口不可用' };
    const target = await pickBinaryTarget(payload, '导出便携文档', '便携文档', 'pdf');
    if (!target.ok) return target;
    const scratch = writeScratchHtml(String(payload.html || ''));
    if (!scratch.ok) return scratch;
    let win = null;
    try {
      win = createRenderWindow(900, 1200, false);
      await win.loadFile(scratch.path);
      await settle(420);
      const data = await win.webContents.printToPDF({
        printBackground: true,
        // 国内文档惯例为 A4（Chromium 默认 Letter），方向默认纵向（LLD §6.2 导出下拉无二级面板）
        pageSize: 'A4',
        landscape: Boolean(payload.landscape),
        margins: { marginType: 'default' },
      });
      fs.writeFileSync(target.path, data);
      rememberDir('save', target.path);
      return { ok: true, path: target.path, name: path.basename(target.path) };
    } catch (error) {
      return { ok: false, error: `导出失败：${error.message}` };
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
      removeScratch(scratch.path);
    }
  });

  ipcMain.handle('file:exportImage', async (_event, payload = {}) => {
    if (!state.win) return { ok: false, error: '窗口不可用' };
    const target = await pickBinaryTarget(payload, '导出图片', '图片文件', 'png');
    if (!target.ok) return target;
    const scratch = writeScratchHtml(String(payload.html || ''));
    if (!scratch.ok) return scratch;
    let win = null;
    try {
      // 截图窗口必须真正绘制：极小尺寸 + 屏外定位，避免遮挡用户视线
      win = createRenderWindow(980, 900, true);
      await win.loadFile(scratch.path);
      await settle(520);
      const metrics = await win.webContents.executeJavaScript(MEASURE_SCRIPT, true);
      const width = Math.max(320, Math.min(Math.ceil(metrics.width), 4000));
      const height = Math.max(200, Math.ceil(metrics.height));
      const segments = Math.min(Math.ceil(height / CAPTURE_SEGMENT), CAPTURE_MAX_SEGMENTS);
      const clipped = Math.ceil(height / CAPTURE_SEGMENT) > CAPTURE_MAX_SEGMENTS;

      win.setContentSize(width, Math.min(height, CAPTURE_SEGMENT));
      await settle(420);

      const parts = [];
      for (let index = 0; index < segments; index += 1) {
        // eslint-disable-next-line no-await-in-loop
        await win.webContents.executeJavaScript(`window.scrollTo(0, ${index * CAPTURE_SEGMENT}); 1`, true);
        // eslint-disable-next-line no-await-in-loop
        await settle(320);
        // eslint-disable-next-line no-await-in-loop
        const shot = await win.webContents.capturePage();
        if (!shot.isEmpty()) parts.push(shot);
      }
      if (parts.length === 0) return { ok: false, error: '导出失败：未能取得渲染结果' };

      const merged = stitchImages(parts);
      if (!merged) return { ok: false, error: '导出失败：图片拼接未成功' };
      fs.writeFileSync(target.path, merged.toPNG());
      rememberDir('save', target.path);
      return { ok: true, path: target.path, name: path.basename(target.path), stitched: parts.length > 1, clipped };
    } catch (error) {
      return { ok: false, error: `导出失败：${error.message}` };
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
      removeScratch(scratch.path);
    }
  });

  /* ---- 阶段二：图片选取与资源夹读写（SRS 3.5.5.1 / 3.5.5.2） ---- */

  ipcMain.handle('asset:pick', async (_event, payload = {}) => {
    if (!state.win) return { ok: false, error: '窗口不可用' };
    const startDir = resolveStartDir('open', payload.startDir);
    const result = await dialog.showOpenDialog(state.win, {
      title: '选择图片',
      defaultPath: startDir,
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: IMAGE_EXT.map((ext) => ext.slice(1)) }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: '已取消', cancelled: true };
    return readImageFile(result.filePaths[0]);
  });

  ipcMain.handle('asset:write', (_event, payload = {}) => {
    const docPath = typeof payload.docPath === 'string' ? payload.docPath : '';
    const docName = typeof payload.docName === 'string' ? payload.docName : '';
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (files.length === 0) {
      return { ok: true, data: { folder: '', written: [], renamed: [], failed: [] } };
    }
    if (!docPath) {
      return { ok: false, error: '文档尚未落盘，图片未能写入资源夹' };
    }
    const folder = path.join(path.dirname(docPath), assetsFolderName(docName || path.basename(docPath)));
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (error) {
      return { ok: false, error: `资源夹创建失败：${error.message}` };
    }
    const written = [];
    const renamed = [];
    const failed = [];
    const taken = new Set();
    try {
      fs.readdirSync(folder).forEach((name) => taken.add(name));
    } catch {
      /* 目录刚建，读不到没关系 */
    }
    for (const item of files) {
      const raw = sanitizeFileName(String(item.name || `image-${Date.now()}.png`));
      // 同名避让：不覆盖既有文件（SRS 3.5.5.2 边界）
      const finalName = resolveAssetName(taken, raw);
      taken.add(finalName);
      try {
        fs.writeFileSync(path.join(folder, finalName), Buffer.from(item.bytes));
        written.push({ name: finalName, path: path.join(folder, finalName) });
        if (finalName !== raw) renamed.push({ from: raw, to: finalName });
      } catch {
        failed.push(raw);
      }
    }
    return { ok: true, data: { folder, written, renamed, failed } };
  });

  ipcMain.handle('asset:read', (_event, payload = {}) => {
    const docPath = typeof payload.docPath === 'string' ? payload.docPath : '';
    const docName = typeof payload.docName === 'string' ? payload.docName : '';
    if (!docPath) return { ok: false, error: '文档路径缺失' };
    const folder = path.join(path.dirname(docPath), assetsFolderName(docName || path.basename(docPath)));
    const entries = [];
    try {
      fs.readdirSync(folder).forEach((name) => {
        const ext = path.extname(name).toLowerCase();
        if (!IMAGE_EXT.includes(ext)) return;
        try {
          const buf = fs.readFileSync(path.join(folder, name));
          entries.push({ name, dataUrl: `data:${IMAGE_MIME[ext] || 'image/png'};base64,${buf.toString('base64')}` });
        } catch {
          /* 单张读取失败跳过 */
        }
      });
    } catch {
      return { ok: true, data: { folder, entries: [] } };
    }
    return { ok: true, data: { folder, entries } };
  });

  ipcMain.on('app:dirty', (_event, dirty) => {
    state.dirty = Boolean(dirty);
  });

  ipcMain.handle('quit:ready', () => {
    state.quitting = true;
    if (state.win && !state.win.isDestroyed()) state.win.destroy();
    return { ok: true };
  });

  ipcMain.handle('quit:cancel', () => {
    state.quitting = false;
    return { ok: true };
  });

  ipcMain.handle('shell:reveal', (_event, filePath) => {
    if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath);
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ *
 * 启动参数里的文件路径（拖到 exe / 右键打开 / 命令行）
 * ------------------------------------------------------------------ */

function pendingFileFromArgv() {
  const argv = process.argv.slice(app.isPackaged ? 1 : 2);
  const hit = argv.find((arg) => !arg.startsWith('-') && MD_EXT.includes(path.extname(arg).toLowerCase()));
  if (!hit) return null;
  return path.isAbsolute(hit) ? hit : path.resolve(hit);
}

function sendOpenPaths(paths) {
  if (state.win && !state.win.isDestroyed()) state.win.webContents.send('files:open', paths);
}

/* ------------------------------------------------------------------ *
 * 自检（--selftest：截屏 + 关键度量，用于无头验收）
 * ------------------------------------------------------------------ */

async function runSelfTest(win) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const report = { metrics: null, menu: null, menuCommandPath: [], ipc: null, disk: null };
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    await wait(1600);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(LOG_DIR, 'selftest.png'), image.toPNG());

    report.metrics = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
          title: document.title,
          appMounted: !!document.querySelector('.md-app'),
          textarea: !!document.querySelector('textarea'),
          panes: document.querySelectorAll('.md-pane, .md-pane-wrap').length,
          bodyHtmlLength: document.body.innerHTML.length,
          bridgeReady: !!(window.markdesk && window.markdesk.isDesktop),
          localStorageOk: (function(){try{localStorage.setItem('__probe','1');localStorage.removeItem('__probe');return true;}catch(e){return false;}})(),
          size: [window.innerWidth, window.innerHeight],
        })`,
      ),
    );

    // 原生菜单结构（含快捷键），证明菜单已装载
    const appMenu = Menu.getApplicationMenu();
    report.menu = appMenu
      ? appMenu.items.map((top) => ({
          label: top.label,
          items: top.submenu
            ? top.submenu.items.map((item) => ({
                label: item.label || `(${item.type})`,
                accelerator: item.accelerator || null,
                enabled: item.enabled,
              }))
            : [],
        }))
      : null;

    // 菜单命令通路：主进程 send → 渲染层响应（原生点击无法无头模拟，走同一 IPC 通路）
    const probe = async (label, payload, expr) => {
      win.webContents.send('menu:command', payload);
      await wait(450);
      const value = await win.webContents.executeJavaScript(expr);
      report.menuCommandPath.push({ step: label, value });
    };
    await probe('theme→切换', { cmd: 'theme' }, `document.documentElement.className`);
    await probe('viewMode→edit', { cmd: 'viewMode', mode: 'edit' }, `document.querySelectorAll('.md-pane-wrap').length`);
    await probe('viewMode→preview', { cmd: 'viewMode', mode: 'preview' }, `document.querySelectorAll('textarea').length`);
    await probe('viewMode→both', { cmd: 'viewMode', mode: 'both' }, `document.querySelectorAll('textarea, .md-pane-wrap').length`);
    await probe('sidebar→折叠', { cmd: 'sidebar' }, `document.querySelectorAll('.md-sidebar, aside').length`);
    await probe('sidebar→展开', { cmd: 'sidebar' }, `document.querySelectorAll('.md-sidebar, aside').length`);
    await probe('help→打开', { cmd: 'help' }, `document.querySelectorAll('[class*="help"]').length`);
    // 复原主题，避免自检把用户默认外观改成深色
    await probe('theme→复原', { cmd: 'theme' }, `document.documentElement.className`);

    // IPC 全链路（系统对话框类接口无法无头自动化，改用无对话框的同源接口取证）
    const fixture = path.join(LOG_DIR, 'fixture');
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.mkdirSync(fixture, { recursive: true });
    const utf8File = path.join(fixture, '样例-中文.md');
    const gbkFile = path.join(fixture, 'gbk样例.md');
    const outFile = path.join(fixture, '写回输出.md');
    const body = '# 样例\n\n第一行\n';
    fs.writeFileSync(utf8File, body, 'utf8');
    fs.writeFileSync(gbkFile, iconv.encode('# 编码样例\n中文内容\n', 'gbk'));

    report.ipc = JSON.parse(
      await win.webContents.executeJavaScript(`(async () => {
        const out = {};
        const read = await window.markdesk.openPath(${JSON.stringify(utf8File)});
        out.openPath = { ok: read.ok, name: read.data && read.data.name, encoding: read.data && read.data.encoding, textMatch: !!(read.data && read.data.text === ${JSON.stringify(body)}) };
        const write = await window.markdesk.writeFile({ path: ${JSON.stringify(outFile)}, text: '# 写回\\n\\n第二行', encoding: 'utf8' });
        out.writeExisting = { ok: write.ok, name: write.data && write.data.name };
        const gbk = await window.markdesk.openPath(${JSON.stringify(gbkFile)});
        out.gbkRead = { ok: gbk.ok, encoding: gbk.data && gbk.data.encoding, text: gbk.data && gbk.data.text };
        const gbkWrite = await window.markdesk.writeFile({ path: ${JSON.stringify(gbkFile)}, text: ((gbk.data && gbk.data.text) || '') + '追加行\\n', encoding: (gbk.data && gbk.data.encoding) || 'utf8' });
        out.gbkWriteBack = { ok: gbkWrite.ok };
        const missing = await window.markdesk.openPath('Z:\\\\不存在的目录\\\\x.md');
        out.openMissing = { ok: missing.ok, error: missing.error };
        const info = await window.markdesk.info();
        out.info = { platform: info.platform, electron: info.electron, hasUserData: !!info.userData };
        return JSON.stringify(out);
      })()`),
    );

    // 磁盘回读：证明真的落盘、且编码保持
    const outText = fs.readFileSync(outFile, 'utf8');
    const gbkBuf = fs.readFileSync(gbkFile);
    let gbkStillGbk = false;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(gbkBuf);
    } catch {
      gbkStillGbk = true;
    }
    report.disk = {
      outFileWritten: outText.includes('第二行'),
      outFileText: outText,
      gbkTextAfterAppend: iconv.decode(gbkBuf, 'gbk'),
      gbkEncodingPreserved: gbkStillGbk,
    };

    fs.writeFileSync(path.join(LOG_DIR, 'selftest.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('[selftest] ' + JSON.stringify(report.metrics));
    console.log('[selftest] ipc ' + JSON.stringify(report.ipc));
    console.log('[selftest] disk ' + JSON.stringify(report.disk));
    console.log('[selftest] menu-command ' + JSON.stringify(report.menuCommandPath));
  } catch (error) {
    console.error('[selftest] failed: ' + error.stack);
    try {
      fs.writeFileSync(path.join(LOG_DIR, 'selftest.json'), JSON.stringify({ ...report, error: error.stack }, null, 2), 'utf8');
    } catch {
      /* 忽略 */
    }
  } finally {
    app.exit(0);
  }
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!state.win) return;
    if (state.win.isMinimized()) state.win.restore();
    state.win.focus();
    const hit = argv.find((arg) => !arg.startsWith('-') && MD_EXT.includes(path.extname(arg).toLowerCase()));
    if (hit) sendOpenPaths([path.isAbsolute(hit) ? hit : path.resolve(hit)]);
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.markdesk.desktop');
    loadRecent();
    loadDirs();
    registerIpc();
    refreshMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
