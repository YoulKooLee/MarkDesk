/**
 * 预览改写：把呈现对象里的文字改动回写为源码区间变更
 * 追溯：LLD V2.0 §3.5 RewriteBridge ｜ SRS V2.0 F-2.4（3.5.2.4）
 *
 * 三步：
 * ① 判定可改写对象 —— p / h1..h6 / li（含待办）/ th / td；
 *    代码块、公式、图表、图片、分隔线不进入改写状态（LLD §3.5）。
 * ② 取块可读文本 —— 剔除勾选框等呈现层节点，勾选态一律取源码值。
 * ③ 按块类型把新文字写回源码区间：
 *    - 无标记：直接替换文字段；
 *    - 有标记：把源码切成一棵「标记 / 文字段」树，用字符级对齐把新文字分配到
 *      各文字段上，标记原样写回 —— 于是「打字落在加粗里仍加粗、整词删掉则标记一并消失」；
 *    - 对齐代价过大或结构不安全时，按 LLD 允许的降级路径整行重写、只保留行前缀。
 */
import type { Change } from './undoStack';

export type RewriteKind = 'heading' | 'paragraph' | 'list' | 'cell';

export interface RewriteTarget {
  kind: RewriteKind;
  /** 源码行号（表格为表头行或数据行） */
  line: number;
  /** 下一块首行号，用于判定本块占用的行区间 */
  nextLine: number | null;
  /** 表格列序（0 起） */
  column?: number;
}

export interface RewriteRequest extends RewriteTarget {
  text: string;
}

export type RewriteResult =
  | { ok: true; change: Change | null }
  | { ok: false; error: 'anchor-lost' | 'unsupported' };

/** 字符级对齐的规模上限：超过即走降级路径（单块通常几十字，远达不到） */
const ALIGN_BUDGET = 400000;

/* ------------------------------------------------------------------ *
 * ① 可改写判定（呈现侧）
 * ------------------------------------------------------------------ */

/**
 * 这些子对象在呈现中不进入改写状态，含其一即整块不可改写。
 * 图片失败占位与公式错误原文块也要算进来 —— 它们是「有素材但取不到」的位置，
 * 一旦放开改写，用户一编辑就会把源码里的图片 / 公式引用整段抹掉。
 */
const BLOCKED_IN_BLOCK = 'img, .md-img-broken, .md-formula-raw, .katex, .katex-display, .md-formula-block, .md-diagram, .md-pre-wrap, hr, ul, ol, table, blockquote, .md-table-wrap';

const REWRITE_SELECTOR = 'p.md-p, li.md-li, td, th, h1.md-h, h2.md-h, h3.md-h, h4.md-h, h5.md-h, h6.md-h';

/** 呈现侧命中改写对象的定位选择器（PreviewPane 复用，避免两处写法漂移） */
export const REWRITE_HIT = REWRITE_SELECTOR;

function lineOf(node: Element | null): number | null {
  if (!node) return null;
  const raw = node.getAttribute('data-line');
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isNaN(value) ? null : value;
}

/** 呈现节点 → 改写目标；null 表示该位置不可改写 */
export function rewriteTargetOf(rawNode: Element, nextLineOf: (line: number) => number | null): RewriteTarget | null {
  const node = rawNode.closest(REWRITE_SELECTOR) as HTMLElement | null;
  if (!node) return null;
  if (node.querySelector(BLOCKED_IN_BLOCK)) return null;

  const tag = node.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) {
    const line = lineOf(node);
    return line === null ? null : { kind: 'heading', line, nextLine: nextLineOf(line) };
  }
  if (tag === 'p') {
    const line = lineOf(node);
    return line === null ? null : { kind: 'paragraph', line, nextLine: nextLineOf(line) };
  }
  if (tag === 'li') {
    const line = lineOf(node);
    if (line === null) return null;
    return { kind: 'list', line, nextLine: nextLineOf(line) };
  }
  const row = node.closest('tr');
  const line = lineOf(row);
  if (line === null || !row) return null;
  const cells = Array.from(row.children);
  const column = cells.indexOf(node);
  if (column < 0) return null;
  return { kind: 'cell', line, nextLine: nextLineOf(line), column };
}

/** 块可读文本：剔勾选框（勾选态取源码值）、软换行按空格并入 */
export function blockReadableText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.md-task-box').forEach((box) => box.remove());
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * ③ 源码回写
 * ------------------------------------------------------------------ */

const HEADING_PREFIX = /^(\s*#{1,6}\s+)/;
/** 与渲染器 matchList 同规则（只认 `1.`，不认 `1)`） */
const LIST_MARKER = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const LIST_PREFIX = /^(\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?)/;
const QUOTE_PREFIX = /^(\s*(?:>\s?)*)/;
const QUOTE_LINE = /^\s*>\s?/;

function prefixOf(kind: RewriteKind, line: string): string {
  if (kind === 'heading') return HEADING_PREFIX.exec(line)?.[1] ?? '';
  if (kind === 'list') return LIST_PREFIX.exec(line)?.[1] ?? '';
  if (kind === 'paragraph') return QUOTE_PREFIX.exec(line)?.[1] ?? '';
  return '';
}

/** 与渲染器一致的块起点判定（用于确定段落实际占用的行区间） */
function isBlockStart(line: string): boolean {
  return (
    line.trim() === '' ||
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*\$\$/.test(line) ||
    /^\s*([-*_])\s*(\1\s*){2,}$/.test(line) ||
    LIST_MARKER.test(line)
  );
}

function indentWidth(line: string): number {
  return (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '  ').length;
}

/**
 * 本块占用的源码行区间（含尾；表格恒为单行）。
 * 判定依据是「渲染器会把哪些行并进同一个块」——段落延续到空行或下一个块起点，
 * 列表项只吃缩进更深的续行，引用块内的段落逐行对应（`>` 行与内层行 1:1）。
 * 不用「下一块锚点」当主判据：块之间夹着空行时锚点会跳号，那样会把待办项误判成不可改写。
 */
function blockRange(lines: string[], request: RewriteRequest): { start: number; end: number } | null {
  const start = request.line;
  if (start < 0 || start >= lines.length) return null;
  if (request.kind === 'heading' || request.kind === 'cell') return { start, end: start };

  const inQuote = request.kind === 'paragraph' && QUOTE_LINE.test(lines[start]);
  let end = start;
  if (request.kind === 'list') {
    const base = indentWidth(lines[start]);
    while (end + 1 < lines.length) {
      const raw = lines[end + 1];
      if (raw.trim() === '' || LIST_MARKER.test(raw)) break;
      if (indentWidth(raw) <= base) break;
      end += 1;
    }
    return { start, end };
  }

  while (end + 1 < lines.length) {
    const raw = lines[end + 1];
    const body = inQuote ? (QUOTE_LINE.test(raw) ? raw.replace(QUOTE_LINE, '') : null) : raw;
    if (body === null || isBlockStart(body)) break;
    // 锚点护栏：源码已被其他来源改动（行数对不上）时收手，交给调用方放弃本次改写
    if (request.nextLine !== null && end + 1 >= request.nextLine) break;
    end += 1;
  }
  return { start, end };
}

/** 续行文字：引用块内的段落要连同 `>` 前缀一起去掉 */
function continuationBody(kind: RewriteKind, prefix: string, line: string): string {
  if (kind === 'paragraph' && prefix !== '') return line.replace(QUOTE_LINE, '').trim();
  return line.trim();
}

function offsetOfLine(lines: string[], line: number): number {
  let offset = 0;
  for (let index = 0; index < line; index += 1) offset += lines[index].length + 1;
  return offset;
}

function makeChange(lines: string[], start: number, end: number, nextLines: string[]): Change {
  const before = lines.slice(start, end + 1).join('\n');
  const after = nextLines.join('\n');
  const at = offsetOfLine(lines, start);
  return {
    start: at,
    before,
    after,
    selStart: at + after.length,
    selEnd: at + after.length,
    origin: 'rewrite',
  };
}

/* ---------------- 标记 / 文字段树 ---------------- */

interface MarkerPiece {
  marker: true;
  open: string;
  close: string;
  inner: Piece[];
  /** 子树内是否还有被保留的文字（全删则整段标记一并消失） */
  kept: boolean;
}

interface TextPiece {
  marker: false;
  text: string;
  /** 该文字段在整块纯文本中的序号区间 */
  from: number;
  to: number;
}

type Piece = MarkerPiece | TextPiece;

const MARKERS: Array<{ open: string; close: string }> = [
  { open: '***', close: '***' },
  { open: '**', close: '**' },
  { open: '__', close: '__' },
  { open: '~~', close: '~~' },
  { open: '==', close: '==' },
  { open: '<u>', close: '</u>' },
  { open: '*', close: '*' },
  { open: '_', close: '_' },
  { open: '`', close: '`' },
  { open: '^', close: '^' },
  { open: '~', close: '~' },
];

function findClose(src: string, from: number, close: string): number {
  const at = src.indexOf(close, from);
  if (at <= from) return -1;
  return src.slice(from, at).includes('\n') ? -1 : at;
}

/** 把源码文字切成分层的「标记 / 文字段」树 */
function tokenize(src: string): Piece[] {
  const pieces: Piece[] = [];
  let buffer = '';
  let index = 0;
  const flush = () => {
    if (buffer !== '') {
      pieces.push({ marker: false, text: buffer, from: 0, to: 0 });
      buffer = '';
    }
  };
  while (index < src.length) {
    if (src[index] === '[') {
      const link = /^\[([^\]\n]*)\]\(([^)\n]*)\)/.exec(src.slice(index));
      if (link) {
        flush();
        pieces.push({ marker: true, open: '[', close: `](${link[2]})`, inner: tokenize(link[1]), kept: true });
        index += link[0].length;
        continue;
      }
    }
    const hit = MARKERS.find((item) => {
      if (!src.startsWith(item.open, index)) return false;
      return findClose(src, index + item.open.length, item.close) >= 0;
    });
    if (hit) {
      const innerStart = index + hit.open.length;
      const closeAt = findClose(src, innerStart, hit.close);
      flush();
      pieces.push({
        marker: true,
        open: hit.open,
        close: hit.close,
        inner: tokenize(src.slice(innerStart, closeAt)),
        kept: true,
      });
      index = closeAt + hit.close.length;
      continue;
    }
    buffer += src[index];
    index += 1;
  }
  flush();
  return pieces;
}

/** 给文字段标上「整块纯文本序号」，返回整块纯文本 */
function flatten(pieces: Piece[], cursor: { value: number }): string {
  let plain = '';
  for (const piece of pieces) {
    if (piece.marker) {
      plain += flatten(piece.inner, cursor);
      continue;
    }
    piece.from = cursor.value;
    piece.to = cursor.value + piece.text.length;
    cursor.value = piece.to;
    plain += piece.text;
  }
  return plain;
}

/** 字符级 LCS 对齐：返回 oldIdx → newIdx 映射（未保留为 -1） */
function align(oldText: string, nextText: string): Int32Array | null {
  const n = oldText.length;
  const m = nextText.length;
  if (n * m > ALIGN_BUDGET) return null;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * (m + 1) + j] = oldText[i] === nextText[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const map = new Int32Array(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldText[i] === nextText[j]) {
      map[i] = j;
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return map;
}

function ownRange(piece: Piece, owner: Int32Array): { lo: number; hi: number } {
  if (piece.marker) {
    let lo = -1;
    let hi = -1;
    for (const child of piece.inner) {
      const range = ownRange(child, owner);
      if (range.lo < 0) continue;
      if (lo < 0 || range.lo < lo) lo = range.lo;
      if (range.hi > hi) hi = range.hi;
    }
    return { lo, hi };
  }
  let lo = -1;
  let hi = -1;
  for (let index = 0; index < owner.length; index += 1) {
    const at = owner[index];
    if (at >= piece.from && at < piece.to) {
      if (lo < 0) lo = index;
      hi = index;
    }
  }
  return { lo, hi };
}

interface EmitState {
  nextText: string;
  cursor: number;
}

function emit(pieces: Piece[], owner: Int32Array, state: EmitState): string {
  let out = '';
  for (const piece of pieces) {
    const range = ownRange(piece, owner);
    if (range.lo < 0) continue; // 该标记 / 文字段整体被删除 → 标记一并消失
    if (piece.marker) {
      out += piece.open + emit(piece.inner, owner, state) + piece.close;
      continue;
    }
    const from = Math.max(state.cursor, range.lo);
    if (range.hi + 1 > from) {
      out += state.nextText.slice(from, range.hi + 1);
      state.cursor = range.hi + 1;
    }
  }
  return out;
}

/**
 * 新文字字符 → 旧纯文本序号的归属表。
 * 保留段直接对应；未保留段按「替换优先」处理：新旧两侧都有未保留段时视为就地替换、
 * 逐字落到旧段上（于是「粗体里改一个字」标记仍在原位）；只有纯插入时才挂到前一段
 * （于是「在加粗末尾接着打字」保持加粗）。全部替换（无任何保留字符）返回 null 走降级。
 */
function buildOwnership(oldText: string, nextText: string, map: Int32Array): Int32Array | null {
  const pairs: Array<{ old: number; next: number }> = [];
  for (let index = 0; index < map.length; index += 1) {
    if (map[index] >= 0) pairs.push({ old: index, next: map[index] });
  }
  if (pairs.length === 0) return null;

  const owner = new Int32Array(nextText.length).fill(-1);
  pairs.forEach((pair) => { owner[pair.next] = pair.old; });

  let pointer = 0;
  for (let index = 0; index < nextText.length; index += 1) {
    if (owner[index] >= 0) continue;
    while (pointer < pairs.length && pairs[pointer].next < index) pointer += 1;
    const prev = pointer > 0 ? pairs[pointer - 1] : null;
    const next = pointer < pairs.length ? pairs[pointer] : null;
    const gapStart = prev ? prev.old + 1 : 0;
    const gapEnd = next ? next.old : oldText.length;
    if (gapEnd > gapStart) {
      const offset = index - (prev ? prev.next + 1 : 0);
      owner[index] = Math.min(gapStart + offset, gapEnd - 1);
    } else {
      owner[index] = prev ? prev.old : (next ? next.old : 0);
    }
  }
  return owner;
}

/** 文字段重写：无标记直接替换，有标记按归属表把新文字分回各文字段 */
function rewriteBody(body: string, nextText: string): string {
  if (body === nextText) return body;
  const pieces = tokenize(body);
  if (!pieces.some((piece) => piece.marker)) return nextText;

  const plain = flatten(pieces, { value: 0 });
  const map = align(plain, nextText);
  if (!map) return nextText; // 降级：整段重写（行前缀由调用方保留）
  const owner = buildOwnership(plain, nextText, map);
  if (!owner) return nextText; // 降级：内容被整体替换，标记无从锚定

  return emit(pieces, owner, { nextText, cursor: 0 });
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 生成改写变更。
 * - ok + change=null：新文字与原内容一致，无需回写；
 * - ok + change：一条 origin='rewrite' 的区间替换；
 * - error='anchor-lost'：源码行已不存在（源码被其他来源改动过），放弃本次改写；
 * - error='unsupported'：该形态不支持改写（表格列序越界等）。
 */
export function buildRewrite(source: string, request: RewriteRequest): RewriteResult {
  const lines = source.split('\n');
  const range = blockRange(lines, request);
  if (!range) return { ok: false, error: 'anchor-lost' };
  const { start, end } = range;
  const nextText = request.text.replace(/\s+/g, ' ').trim();

  // 锚点核验：目标行已不是该形态（源码被其他来源改过）→ 放弃本次改写
  if (request.kind === 'heading' && !HEADING_PREFIX.test(lines[start])) return { ok: false, error: 'anchor-lost' };
  if (request.kind === 'list' && !LIST_PREFIX.test(lines[start])) return { ok: false, error: 'anchor-lost' };

  if (request.kind === 'cell') {
    const column = request.column ?? -1;
    if (column < 0) return { ok: false, error: 'unsupported' };
    const raw = lines[start];
    const parts = raw.split('|');
    const head = /^\s*\|/.test(raw) ? 1 : 0;
    const tail = /\|\s*$/.test(raw) ? 1 : 0;
    const cells = parts.slice(head, parts.length - tail);
    if (column >= cells.length) return { ok: false, error: 'unsupported' };
    const rewritten = rewriteBody(cells[column].trim(), nextText);
    cells[column] = ` ${rewritten} `;
    const rebuilt = [...parts.slice(0, head), ...cells, ...(tail ? parts.slice(parts.length - 1) : [])].join('|');
    if (rebuilt === raw) return { ok: true, change: null };
    return { ok: true, change: makeChange(lines, start, end, [rebuilt]) };
  }

  // 多行块（软换行段落）按 SRS 归并为一行：前缀取首行，文字段合并后再分配
  const prefix = prefixOf(request.kind, lines[start]);
  const bodies: string[] = [lines[start].slice(prefix.length)];
  for (let index = start + 1; index <= end; index += 1) {
    bodies.push(continuationBody(request.kind, prefix, lines[index]));
  }
  const body = bodies.join(' ').trim();

  const rewritten = rewriteBody(body, nextText);
  const nextLine = `${prefix}${rewritten}`.replace(/[ \t]+$/, '');
  if (nextLine === lines[start] && start === end) return { ok: true, change: null };

  return { ok: true, change: makeChange(lines, start, end, [nextLine]) };
}
