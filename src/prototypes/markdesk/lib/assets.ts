/**
 * 图片插入、资源夹与导出烘焙（SRS V2.0 阶段二）
 * 追溯：LLD V2.0 §七 ｜ SRS V2.0 F-5.1 ~ F-5.3（3.5.5.1 ~ 3.5.5.3）
 *
 * 三条链路的分工：
 * - 插入：登记待写清单（内存）+ 源码立即写相对路径引用；
 * - 落地：保存 / 另存为时把清单写入「[文档名]_assets」同级资源夹；
 * - 烘焙：导出时把相对引用换成内嵌 data URL，不改源码引用写法。
 * 预览呈现与烘焙共用同一张「相对路径 → data URL」表，故两者必然同款同版本。
 */

export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
export const IMAGE_SIZE_LIMIT = 10 * 1024 * 1024;

export interface AssetRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  data: ArrayBuffer;
  relPath: string;
}

/** 资源夹命名：[文档名去扩展]_assets（SRS 3.5.5.2，与主进程 assetsFolderName 同规则） */
export function folderFor(docName: string): string {
  const base = (docName || '未命名文档').replace(/\.(md|markdown|txt|html|htm)$/i, '');
  return `${base || '未命名文档'}_assets`;
}

/** 文件名归一化：非法字符转连字符 */
export function normalizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-');
}

/** 同名避让：追加 -1、-2…（SRS 3.5.5.1 边界） */
export function resolveName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let counter = 1;
  while (taken.has(`${stem}-${counter}${ext}`)) counter += 1;
  return `${stem}-${counter}${ext}`;
}

/* ------------------------------------------------------------------ *
 * 登记（SRS 3.5.5.1）
 * ------------------------------------------------------------------ */

export interface RegisterResult {
  ok: boolean;
  ref?: AssetRef;
  /** 机器码，由调用方映射为界面语言文案 */
  error?: 'unsupported' | 'too-large' | 'unreadable';
}

/** 图片来源：浏览器宿主给 File，桌面宿主给主进程读出的字节（上层统一成这一形状） */
export interface ImageInput {
  name: string;
  bytes: Uint8Array;
  mime: string;
  size: number;
}

/** 字节转 data URL（预览呈现与导出烘焙共用；网络地址图片不经过这里） */
export function dataUrlOf(bytes: Uint8Array, mime: string): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return `data:${mime || 'image/png'};base64,${btoa(binary)}`;
}

/** 校验并登记一张待写图片（SRS 3.5.5.1 业务规则：格式白名单 + 单张 10MB） */
export function registerImageData(input: ImageInput, docName: string, taken: Set<string>): RegisterResult {
  const ext = `.${(input.name.split('.').pop() ?? '').toLowerCase()}`;
  if (!IMAGE_EXT.includes(ext)) return { ok: false, error: 'unsupported' };
  if (input.size > IMAGE_SIZE_LIMIT) return { ok: false, error: 'too-large' };
  if (input.bytes.byteLength === 0) return { ok: false, error: 'unreadable' };
  const name = resolveName(taken, normalizeName(input.name));
  const ref: AssetRef = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    mime: input.mime || `image/${ext.slice(1)}`,
    size: input.size,
    data: input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer,
    relPath: `${folderFor(docName)}/${name}`,
  };
  return { ok: true, ref };
}

/** 浏览器宿主与粘贴板：从 File 登记（沿用同一套校验与命名避让） */
export async function registerImage(file: File, docName: string, taken: Set<string>): Promise<RegisterResult> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, error: 'unreadable' };
  }
  return registerImageData({ name: file.name, bytes, mime: file.type, size: file.size }, docName, taken);
}

/** 已登记 + 磁盘已存在的名字集合，供同名避让（避免与资源夹内既有文件重名） */
export function takenNames(refs: AssetRef[], urls: Record<string, string>): Set<string> {
  const taken = new Set<string>();
  refs.forEach((ref) => taken.add(ref.name));
  Object.keys(urls).forEach((rel) => {
    const cut = rel.lastIndexOf('/');
    if (cut >= 0) taken.add(rel.slice(cut + 1));
  });
  return taken;
}

/* ------------------------------------------------------------------ *
 * 资源夹写入（SRS 3.5.5.2）
 * ------------------------------------------------------------------ */

export interface MaterializePlan {
  folder: string;
  files: Array<{ name: string; bytes: Uint8Array }>;
}

/** 待写清单 → 宿主写入参数 */
export function planMaterialize(refs: AssetRef[], docName: string): MaterializePlan {
  return {
    folder: folderFor(docName),
    files: refs.map((ref) => ({ name: ref.name, bytes: new Uint8Array(ref.data) })),
  };
}

/** 资源夹引用识别只需「实体名 + 相对路径」，待写清单与既有资源夹条目共用此形状 */
export interface AssetPathRef {
  name: string;
  relPath: string;
}

/**
 * 文档改名后资源夹名随下次写入更新（SRS 3.5.5.2）：
 * 把源码里旧资源夹的引用整体改指到新资源夹，返回改写后的源码。
 */
export function retargetSource(source: string, refs: AssetPathRef[], docName: string): { source: string; changed: boolean } {
  const folder = folderFor(docName);
  let next = source;
  let changed = false;
  for (const ref of refs) {
    const target = `${folder}/${ref.name}`;
    if (ref.relPath === target || !next.includes(ref.relPath)) continue;
    next = next.split(ref.relPath).join(target);
    changed = true;
  }
  return { source: next, changed };
}

/* ------------------------------------------------------------------ *
 * 导出烘焙（SRS 3.5.5.3）
 * ------------------------------------------------------------------ */

/**
 * 把产出内容里指向资源夹的相对引用替换成内嵌 data URL。
 * 只作用于产出，不改源码引用写法；替换不掉的计入缺图数（对应「存在无法嵌入的图片」提示）。
 */
export function bakeUrls(html: string, urls: Record<string, string>): { html: string; missing: number } {
  let next = html;
  for (const [rel, dataUrl] of Object.entries(urls)) {
    if (!rel || !next.includes(rel)) continue;
    next = next.split(rel).join(dataUrl);
  }
  return { html: next, missing: (next.match(/src="[^"]*_assets\//g) || []).length };
}
