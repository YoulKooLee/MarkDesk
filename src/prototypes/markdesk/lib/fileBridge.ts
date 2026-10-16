/**
 * 宿主桥接：本机文件读写（双宿主自适应）
 * 追溯：LLD §三 FileBridge ｜ SRS F-3.1、F-3.2、F-3.4
 *
 * 宿主判定：存在 window.markdesk 即为 Electron 桌面宿主 → 走主进程 IPC（原生对话框、
 * 真实磁盘路径、原编码回写）；否则为浏览器宿主 → 走 File System Access API + 降级通道。
 * 上层组件无需感知差异，两条链路返回同一 BridgeResult 形状。
 */
export interface OpenedFile {
  name: string;
  text: string;
  handle: unknown | null;
  path?: string;
}

interface BridgeResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  cancelled?: boolean;
}

/** 桌面宿主下代表「一份已落盘的文件」，可据此原路写回 */
export interface DesktopHandle {
  path: string;
  name: string;
  encoding: string;
}

export interface BinaryExportPayload {
  html: string;
  defaultName: string;
  startDir?: string | null;
  theme?: 'light' | 'dark';
  landscape?: boolean;
}

export interface BinaryExportOutcome {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  path?: string;
  name?: string;
  /** 内容高于可承载尺寸时按段拼接（PNG） */
  stitched?: boolean;
  /** 内容超出拼接上限被截取（PNG） */
  clipped?: boolean;
}

interface DesktopBridge {
  isDesktop: true;
  openFile(startDir?: string | null): Promise<BridgeResult<OpenedFile>>;
  openPath(path: string): Promise<BridgeResult<OpenedFile>>;
  openImport(startDir?: string | null): Promise<BridgeResult<OpenedFile>>;
  saveAs(options: { defaultName: string; startDir?: string | null }): Promise<BridgeResult<{ path: string; name: string }>>;
  writeFile(payload: { path: string; text: string; encoding?: string }): Promise<BridgeResult<{ path: string; name: string }>>;
  exportFile(payload: {
    defaultName: string;
    text: string;
    kind: 'markdown' | 'html' | 'word';
    startDir?: string | null;
  }): Promise<BridgeResult<{ path: string; name: string }>>;
  /** 阶段二：便携文档（隐藏窗口打印链路）与图片（隐藏窗口截图链路） */
  exportPdf?(payload: BinaryExportPayload): Promise<BinaryExportOutcome>;
  exportImage?(payload: BinaryExportPayload): Promise<BinaryExportOutcome>;
  /** 阶段二：图片插入与资源夹落盘 */
  pickImage?(startDir?: string | null): Promise<BridgeResult<{ name: string; bytes: Uint8Array; mime: string; size: number }>>;
  writeAssets?(payload: {
    docPath: string;
    docName: string;
    files: Array<{ name: string; bytes: Uint8Array }>;
  }): Promise<BridgeResult<{ folder: string; written: Array<{ name: string; path: string }>; renamed: Array<{ from: string; to: string }>; failed: string[] }>>;
  readAssets?(docPath: string, docName: string): Promise<BridgeResult<{ folder: string; entries: Array<{ name: string; dataUrl: string }> }>>;
  setDirty(dirty: boolean): void;
  quitReady(): Promise<unknown>;
  quitCancel(): Promise<unknown>;
  reveal(path: string): Promise<unknown>;
  pathForFile(file: File): string;
  onMenuCommand(handler: (payload: { cmd: string; [key: string]: unknown }) => void): () => void;
  onOpenFiles(handler: (paths: string[]) => void): () => void;
}

export const ACCEPTED_EXT = ['.md', '.markdown', '.txt'];
export const IMPORT_EXT = ['.html', '.htm', '.docx'];

/** 句柄对应的磁盘路径（桌面宿主）；用于记住目录推断 */
export function pathDir(path: string | null): string | null {
  if (!path) return null;
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : null;
}

const PICKER_TYPES = [
  {
    description: 'Markdown 文档',
    accept: { 'text/markdown': ACCEPTED_EXT, 'text/plain': ['.txt'] },
  },
];

function desktop(): DesktopBridge | null {
  const host = (window as unknown as Record<string, unknown>).markdesk as DesktopBridge | undefined;
  return host && host.isDesktop ? host : null;
}

/** 桌面宿主（Electron）判定 —— 供上层做菜单接管、最近文件按路径直开等差异处理 */
export const isDesktopHost = (): boolean => desktop() !== null;

/** 暴露桌面桥本体，避免上层重复做 window 探测 */
export const desktopBridge = (): DesktopBridge | null => desktop();

function extOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

/** 是否支持「写回同一文件」：桌面宿主恒为真；浏览器宿主取决于 File System Access API */
export const hasNativePicker = (): boolean =>
  isDesktopHost() ||
  typeof (window as unknown as Record<string, unknown>).showOpenFilePicker === 'function';

type AnyHandle = {
  name?: string;
  path?: string;
  encoding?: string;
  getFile?: () => Promise<File>;
  createWritable?: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
};

/* ------------------------------------------------------------------ *
 * 浏览器宿主：File System Access API + 降级通道
 * ------------------------------------------------------------------ */

async function openViaInput(accept: string[] = ACCEPTED_EXT): Promise<BridgeResult<OpenedFile>> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept.join(',');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve({ ok: false, error: '已取消', cancelled: true });
        return;
      }
      if (!accept.includes(extOf(file.name))) {
        resolve({ ok: false, error: '不支持的文件类型' });
        return;
      }
      try {
        const text = await readFileText(file);
        resolve({ ok: true, data: { name: file.name, text, handle: null } });
      } catch {
        resolve({ ok: false, error: '读取失败' });
      }
    };
    input.click();
  });
}

async function readFileText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return utf8;
  }
}

/* ------------------------------------------------------------------ *
 * 打开
 * ------------------------------------------------------------------ */

/** 打开文件：桌面宿主走系统对话框；浏览器宿主优先系统选择器，缺失时降级为文件输入框 */
export async function openFile(startDir?: string | null): Promise<BridgeResult<OpenedFile>> {
  const host = desktop();
  if (host) return host.openFile(startDir);

  if (typeof (window as unknown as Record<string, unknown>).showOpenFilePicker === 'function') {
    try {
      const win = window as unknown as {
        showOpenFilePicker: (options: unknown) => Promise<AnyHandle[]>;
      };
      const handles = await win.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
      const handle = handles[0];
      const file = await handle.getFile?.();
      if (!file) return { ok: false, error: '读取失败' };
      if (!ACCEPTED_EXT.includes(extOf(file.name))) {
        return { ok: false, error: '不支持的文件类型' };
      }
      const text = await readFileText(file);
      return { ok: true, data: { name: file.name, text, handle } };
    } catch (error) {
      const aborted = (error as DOMException)?.name === 'AbortError';
      if (aborted) return { ok: false, error: '已取消', cancelled: true };
      return openViaInput();
    }
  }
  return openViaInput();
}

/** 导入源：统一为「名字 + 二进制缓冲」，.html 文本与 .docx 二进制同一形态交 importer */
export interface ImportedSource {
  name: string;
  buffer: ArrayBuffer;
  handle: unknown | null;
  path?: string;
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/**
 * 导入选择（SRS 3.5.3.6）：白名单 .html / .htm / .docx。
 * 桌面宿主下 .docx 以 base64 承载二进制（主进程读取），.html 走文本；
 * 浏览器宿主直接取 File 的 ArrayBuffer。两条链路都交 importer 按扩展名分派。
 */
export async function openImportFile(startDir?: string | null): Promise<BridgeResult<ImportedSource>> {
  const host = desktop();
  if (host) {
    const result = await host.openImport(startDir);
    if (!result.ok || !result.data) return { ok: false, error: result.error, cancelled: result.cancelled };
    const opened = result.data as OpenedFile & { base64?: string };
    const buffer = typeof opened.base64 === 'string'
      ? base64ToBuffer(opened.base64)
      : new TextEncoder().encode(opened.text).buffer;
    return { ok: true, data: { name: opened.name, buffer, handle: opened.handle, path: opened.path } };
  }

  const toSource = async (file: File, handle: unknown): Promise<BridgeResult<ImportedSource>> => {
    if (!IMPORT_EXT.includes(extOf(file.name))) return { ok: false, error: '不支持的导入类型' };
    try {
      return { ok: true, data: { name: file.name, buffer: await file.arrayBuffer(), handle } };
    } catch {
      return { ok: false, error: '读取失败' };
    }
  };

  if (typeof (window as unknown as Record<string, unknown>).showOpenFilePicker === 'function') {
    try {
      const win = window as unknown as { showOpenFilePicker: (options: unknown) => Promise<AnyHandle[]> };
      const handles = await win.showOpenFilePicker({
        multiple: false,
        types: [{ description: '可导入文档', accept: { 'text/html': ['.html', '.htm'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] } }],
      });
      const file = await handles[0]?.getFile?.();
      if (!file) return { ok: false, error: '读取失败' };
      return toSource(file, handles[0]);
    } catch (error) {
      const aborted = (error as DOMException)?.name === 'AbortError';
      if (aborted) return { ok: false, error: '已取消', cancelled: true };
    }
  }
  // 降级：文件输入框
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = IMPORT_EXT.join(',');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve({ ok: false, error: '已取消', cancelled: true }); return; }
      resolve(await toSource(file, null));
    };
    input.click();
  });
}

/** 按磁盘路径直接打开 —— 桌面宿主独有能力（最近文件、拖入 exe、二次实例） */
export async function openByPath(path: string): Promise<BridgeResult<OpenedFile>> {
  const host = desktop();
  if (!host) return { ok: false, error: '当前宿主不支持按路径打开' };
  return host.openPath(path);
}

/** 从拖拽事件中打开文件（SRS F-3.2） */
export async function openDropped(file: File): Promise<BridgeResult<OpenedFile>> {
  const host = desktop();
  if (host) {
    const realPath = host.pathForFile(file);
    if (realPath) return host.openPath(realPath);
  }
  if (!file) return { ok: false, error: '不支持的文件类型' };
  if (!ACCEPTED_EXT.includes(extOf(file.name))) {
    return { ok: false, error: '不支持的文件类型' };
  }
  try {
    const text = await readFileText(file);
    return { ok: true, data: { name: file.name, text, handle: null } };
  } catch {
    return { ok: false, error: '读取失败' };
  }
}

/* ------------------------------------------------------------------ *
 * 保存
 * ------------------------------------------------------------------ */

/** 询问存放位置（首次保存 / 另存为）；startDir 为记住目录起点（SRS 3.5.3.7） */
export async function pickSavePath(name: string, ext: string, startDir?: string | null): Promise<BridgeResult<unknown>> {
  const suggested = name.endsWith(ext) ? name : `${name}${ext}`;
  const host = desktop();
  if (host) {
    const picked = await host.saveAs({ defaultName: startDir ? `${startDir}/${suggested}` : suggested, startDir });
    if (!picked.ok) return picked;
    const target = picked.data as { path: string; name: string };
    return { ok: true, data: { path: target.path, name: target.name, encoding: 'utf8' } as DesktopHandle };
  }

  if (typeof (window as unknown as Record<string, unknown>).showSaveFilePicker === 'function') {
    try {
      const win = window as unknown as {
        showSaveFilePicker: (options: unknown) => Promise<AnyHandle>;
      };
      const handle = await win.showSaveFilePicker({ suggestedName: suggested, types: PICKER_TYPES });
      return { ok: true, data: handle };
    } catch (error) {
      const aborted = (error as DOMException)?.name === 'AbortError';
      return { ok: false, error: aborted ? '已取消' : '写入失败', cancelled: aborted };
    }
  }
  return { ok: true, data: null };
}

/** 另存为入口：语义与 pickSavePath 相同，独立命名供上层区分调用来源 */
export const pickSavePathAs = (name: string, startDir?: string | null) => pickSavePath(name, '', startDir);

/**
 * 写入：
 * - 桌面宿主 + 已有路径 → 原路径写回（保留原编码）
 * - 桌面宿主 + 无路径（导出）→ 弹系统保存对话框
 * - 浏览器宿主 + 句柄 → 写回同一文件
 * - 浏览器宿主 + 无句柄 → 走下载通道
 */
export async function writeFile(handle: unknown, name: string, text: string, startDir?: string | null): Promise<BridgeResult<unknown>> {
  const host = desktop();
  const target = handle as AnyHandle | null;

  if (host) {
    if (target?.path) {
      return host.writeFile({ path: target.path, text, encoding: target.encoding || 'utf8' });
    }
    return host.exportFile({
      defaultName: name,
      text,
      kind: /\.doc$/i.test(name) ? 'word' : /\.html?$/i.test(name) ? 'html' : 'markdown',
      startDir,
    });
  }

  if (target && typeof target.createWritable === 'function') {
    try {
      const writable = await target.createWritable();
      await writable.write(text);
      await writable.close();
      return { ok: true, data: null };
    } catch (error) {
      const aborted = (error as DOMException)?.name === 'AbortError';
      return { ok: false, error: aborted ? '已取消' : '写入失败' };
    }
  }
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return { ok: true, data: null };
  } catch {
    return { ok: false, error: '写入失败' };
  }
}

/** 句柄显示名（浏览器句柄与桌面句柄同形：都带 name） */
export function handleName(handle: unknown): string | null {
  const anyHandle = handle as AnyHandle | null;
  return anyHandle?.name ?? null;
}

/** 句柄对应的磁盘路径：桌面宿主下可用于最近文件与「在文件夹中显示」 */
export function handlePath(handle: unknown): string | null {
  const anyHandle = handle as AnyHandle | null;
  return anyHandle?.path ?? null;
}
