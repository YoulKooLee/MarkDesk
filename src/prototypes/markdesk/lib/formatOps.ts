/**
 * 格式操作：把工具栏命令映射为源码区间变更
 * 追溯：LLD V2.0 §2.3 ｜ SRS V2.0 F-1.7（3.5.1.7）
 */
import type { Change } from './undoStack';

export type FormatCommand =
  | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p'
  | 'bold' | 'italic' | 'underline' | 'strike' | 'sup' | 'sub' | 'mark'
  | 'quote' | 'ul' | 'ol' | 'task'
  | 'code' | 'codeblock'
  | 'link' | 'image' | 'table' | 'hr' | 'mermaid' | 'tag';

interface Selection { start: number; end: number }

function lineBounds(text: string, pos: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  const nextBreak = text.indexOf('\n', pos);
  return { start, end: nextBreak < 0 ? text.length : nextBreak };
}

function selectedLines(text: string, sel: Selection): { start: number; end: number; lines: string[] } {
  const first = lineBounds(text, sel.start);
  let endBound = lineBounds(text, Math.max(sel.end - 1, sel.start));
  if (sel.end > first.start && text[sel.end] !== '\n' && sel.end === endBound.start) {
    // 选区恰好在行首时不牵连下一行
    endBound = first;
  }
  const raw = text.slice(first.start, endBound.end);
  return { start: first.start, end: endBound.end, lines: raw.split('\n') };
}

function makeChange(start: number, before: string, after: string, selStart: number, selEnd: number): Change {
  return { start, before, after, selStart, selEnd, origin: 'format' };
}

/* ---------------- 包裹类 ---------------- */

const WRAPPERS: Partial<Record<FormatCommand, { open: string; close: string }>> = {
  bold: { open: '**', close: '**' },
  italic: { open: '_', close: '_' },
  underline: { open: '<u>', close: '</u>' },
  strike: { open: '~~', close: '~~' },
  sup: { open: '^', close: '^' },
  sub: { open: '~', close: '~' },
  mark: { open: '==', close: '==' },
  code: { open: '`', close: '`' },
};

/** 开关式：已整体被同款标记包裹则移除，否则包裹 */
function toggleWrap(text: string, sel: Selection, open: string, close: string): Change | null {
  const inner = text.slice(sel.start, sel.end);
  if (inner.startsWith(open) && inner.endsWith(close) && inner.length >= open.length + close.length) {
    const stripped = inner.slice(open.length, inner.length - close.length);
    return makeChange(sel.start, inner, stripped, sel.start, sel.start + stripped.length);
  }
  // 选区外侧已被同款标记包裹 → 移除外侧标记
  const outside = text.slice(Math.max(0, sel.start - open.length), Math.min(text.length, sel.end + close.length));
  if (outside.length === open.length + (sel.end - sel.start) + close.length && outside.startsWith(open) && outside.endsWith(close)) {
    return makeChange(sel.start - open.length, outside, inner, sel.start - open.length, sel.end - open.length);
  }
  const wrapped = `${open}${inner}${close}`;
  const caret = inner.length === 0 ? sel.start + open.length : sel.start + wrapped.length;
  return makeChange(sel.start, inner, wrapped, caret, caret);
}

/* ---------------- 行级 ---------------- */

const HEADING_RE = /^(\s*)(#{1,6})\s+/;
const QUOTE_RE = /^(\s*)>\s?/;
const UL_RE = /^(\s*)([-*+])\s+/;
const OL_RE = /^(\s*)(\d+)([.)])\s+/;
const TASK_RE = /^(\s*)([-*+])\s+(\[[ xX]\])\s*/;

function stripLineMarkers(line: string): string {
  return line.replace(HEADING_RE, '$1').replace(TASK_RE, '$1$2 ').replace(QUOTE_RE, '$1').replace(UL_RE, '$1').replace(OL_RE, '$1');
}

function toggleHeading(text: string, sel: Selection, level: number | null): Change | null {
  const bounds = lineBounds(text, sel.start);
  const line = text.slice(bounds.start, bounds.end);
  const matched = line.match(HEADING_RE);
  const bare = stripLineMarkers(line);
  // level=null（还原正文）或「已是同级标题再触发」→ 去标记；否则套目标级别
  const next = level === null || (matched && matched[2].length === level)
    ? bare
    : `${'#'.repeat(level)} ${bare}`;
  if (next === line) return null;
  return makeChange(bounds.start, line, next, bounds.start + next.length, bounds.start + next.length);
}

function toggleLinePrefix(text: string, sel: Selection, kind: 'quote' | 'ul' | 'ol' | 'task'): Change | null {
  const region = selectedLines(text, sel);
  const allHas = region.lines.every((line) =>
    kind === 'quote' ? QUOTE_RE.test(line) : kind === 'ul' ? UL_RE.test(line) : kind === 'ol' ? OL_RE.test(line) : TASK_RE.test(line));
  const nextLines = region.lines.map((line, offset) => {
    if (allHas) {
      if (kind === 'quote') return line.replace(QUOTE_RE, '$1');
      if (kind === 'ul') return line.replace(UL_RE, '$1');
      if (kind === 'ol') return line.replace(OL_RE, '$1');
      return line.replace(TASK_RE, '$1$2 ');
    }
    const bare = stripLineMarkers(line);
    if (kind === 'quote') return `> ${bare}`;
    if (kind === 'ul') return `- ${bare}`;
    if (kind === 'ol') return `${offset + 1}. ${bare}`;
    return `- [ ] ${bare}`;
  });
  const next = nextLines.join('\n');
  if (next === text.slice(region.start, region.end)) return null;
  return makeChange(region.start, text.slice(region.start, region.end), next, region.start, region.start + next.length);
}

/** 任务列表二次触发切换勾选态（SRS 3.5.1.7） */
function toggleTaskState(text: string, sel: Selection): Change | null {
  const region = selectedLines(text, sel);
  const allTask = region.lines.every((line) => TASK_RE.test(line));
  if (!allTask) return toggleLinePrefix(text, sel, 'task');
  const nextLines = region.lines.map((line) => line.replace(/\[([ xX])\]/, (_m, mark: string) => (mark.toLowerCase() === 'x' ? '[ ]' : '[x]')));
  const next = nextLines.join('\n');
  if (next === text.slice(region.start, region.end)) return null;
  return makeChange(region.start, text.slice(region.start, region.end), next, region.start, region.start + next.length);
}

/* ---------------- 插入类 ---------------- */

function insertAt(text: string, sel: Selection, snippet: string, caretOffset: number): Change {
  const change = makeChange(sel.start, text.slice(sel.start, sel.end), snippet, sel.start + caretOffset, sel.start + caretOffset);
  return change;
}

const CODEBLOCK = '```language\n\n```\n';
const TABLE = '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n|  |  |  |\n';
const MERMAID = '```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```\n';

export interface LinkInput { text: string; url: string }

/** 链接：有选中文字时以选中文字为链接文字（SRS 3.5.1.7） */
export function buildLink(text: string, sel: Selection, input: LinkInput): Change {
  const selected = text.slice(sel.start, sel.end);
  const label = input.text || selected;
  const snippet = `[${label}](${input.url})`;
  return makeChange(sel.start, selected, snippet, sel.start + snippet.length, sel.start + snippet.length);
}

/**
 * 图片插入（SRS 3.5.5.1）：在选区处写入引用，光标落在引用之后。
 * 选中文字时以其为说明文字，与链接行为一致；src 为网络地址或资源夹相对路径。
 */
export function buildImageChange(text: string, sel: Selection, label: string, src: string): Change {
  const selected = text.slice(sel.start, sel.end);
  const alt = label || selected || '图片';
  const snippet = `![${alt}](${src})`;
  return makeChange(sel.start, selected, snippet, sel.start + snippet.length, sel.start + snippet.length);
}

/**
 * 命令 → 变更。返回 null 表示无改动（入口不可用 / 状态未变）。
 * image 由调用方走图片插入流程，link 需先取输入，故此处不处理。
 */
export function applyFormat(text: string, sel: Selection, command: FormatCommand): Change | null {
  if (/^h[1-6]$/.test(command)) return toggleHeading(text, sel, Number(command.slice(1)));
  if (command === 'p') return toggleHeading(text, sel, null);
  const wrapper = WRAPPERS[command];
  if (wrapper) return toggleWrap(text, sel, wrapper.open, wrapper.close);
  if (command === 'quote') return toggleLinePrefix(text, sel, 'quote');
  if (command === 'ul') return toggleLinePrefix(text, sel, 'ul');
  if (command === 'ol') return toggleLinePrefix(text, sel, 'ol');
  if (command === 'task') return toggleTaskState(text, sel);
  if (command === 'codeblock') return insertAt(text, sel, CODEBLOCK, 3);
  if (command === 'table') return insertAt(text, sel, TABLE, sel.start === sel.end ? 2 : TABLE.length);
  if (command === 'mermaid') return insertAt(text, sel, MERMAID, 11);
  if (command === 'hr') return insertAt(text, sel, '\n---\n', 5);
  if (command === 'tag') return insertAt(text, sel, '<span></span>', 6);
  return null;
}

/** 「更多文字效果」与标题项的清单，供工具栏渲染 */
export const FORMAT_GROUPS: Array<{ label: string; commands: FormatCommand[] }> = [
  { label: '回退恢复', commands: [] },
  { label: '标题', commands: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] },
  { label: '强调', commands: ['bold', 'italic', 'underline', 'strike', 'sup', 'sub', 'mark', 'code'] },
  { label: '列表引用', commands: ['quote', 'ul', 'ol', 'task'] },
  { label: '插入', commands: ['link', 'image', 'table', 'codeblock', 'hr', 'mermaid', 'tag'] },
];
