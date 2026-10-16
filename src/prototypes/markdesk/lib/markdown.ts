/**
 * Markdown 轻量解析器（内置实现，离线可用）
 * 追溯：LLD §二 MarkdownParser ｜ SRS F-2.1（3.5.2.1 语法清单）
 *
 * 阶段二接入：行内 `$…$` / 成行 `$$…$$` 公式（FormulaRenderer）、```mermaid 图表占位（DiagramRenderer）。
 * 公式段切分先于一切行内规则（LLD §3.2），图表只落占位结构、不在此处做异步渲染。
 */
import { highlight } from './highlight';
import { renderFormula } from './formula';

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

const SAFE_SCHEME = /^(https?:|mailto:|data:image\/)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// 允许相对路径与白名单协议；javascript: / vbscript: 等危险协议一律拦截
const URL_PATTERN = '((?:[^()\\s]|\\([^()\\s]*\\))+)';

function safeUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  if (HAS_SCHEME.test(url)) return SAFE_SCHEME.test(url) ? url : '';
  return url;
}

/**
 * 公式段切分（LLD §3.2）：把一行文本切成「普通段 / 公式段」交替序列。
 * 定界规则：`$$…$$` 为成行公式、`$…$` 为行内公式；开符后与闭符前均不能是空白，
 * 借此避开中文里「$5 和 $10」这类纯文本误判。空内容（孤立 $）按普通文本回退。
 */
interface InlineSegment {
  text: string;
  formula: boolean;
  display: boolean;
}

const FORMULA_SEGMENT = /\$\$(?!\s)[\s\S]*?(?<!\s)\$\$|\$(?!\s)[^$\n]*?(?<!\s)\$/g;

function splitFormulaSegments(src: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  FORMULA_SEGMENT.lastIndex = 0;
  while ((match = FORMULA_SEGMENT.exec(src)) !== null) {
    if (match.index > last) segments.push({ text: src.slice(last, match.index), formula: false, display: false });
    const raw = match[0];
    const display = raw.startsWith('$$');
    segments.push({ text: display ? raw.slice(2, -2) : raw.slice(1, -1), formula: true, display });
    last = match.index + raw.length;
  }
  if (last < src.length) segments.push({ text: src.slice(last), formula: false, display: false });
  return segments;
}

/** 行内语法入口：先切公式段，普通段走既有行内规则、公式段整体交 FormulaRenderer */
export function renderInline(src: string): string {
  if (!src.includes('$')) return renderInlinePlain(src);
  const segments = splitFormulaSegments(src);
  if (segments.length === 1 && !segments[0].formula) return renderInlinePlain(src);
  return segments
    .map((segment) => (segment.formula ? renderFormula(segment.text, segment.display).html : renderInlinePlain(segment.text)))
    .join('');
}

/**
 * 行内语法：行内代码 → 图片 → 链接 → 强调 → 删除线
 *
 * 行内代码、图片、链接一律先落成占位符，再跑强调 / 删除线 / 上下标等规则。
 * 否则这些规则会作用到已生成的 HTML 里：资源夹名带下划线（SRS 3.5.5.2 约定
 * `[文档名]_assets`），文档里出现两张及以上本地图片时，两个地址中的下划线会被
 * 斜体规则跨地址配对，把 `src` 写成 `未命名文档<em>assets/…`，图片必然显示为占位。
 */
function renderInlinePlain(src: string): string {
  let text = escapeHtml(src);
  const atoms: string[] = [];
  const hold = (html: string) => {
    atoms.push(html);
    return `\u0000A${atoms.length - 1}\u0000`;
  };

  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => hold(`<code class="md-inline-code">${code}</code>`));

  const imageRe = new RegExp(`!\\[([^\\]]*)\\]\\(${URL_PATTERN}(?:\\s+&quot;([^&]*)&quot;)?\\)`, 'g');
  text = text.replace(imageRe, (all, alt: string, url: string, title?: string) => {
    const safe = safeUrl(url);
    if (!safe) return all;
    const t = title ? ` title="${title}"` : '';
    return hold(`<img class="md-img" src="${safe}" alt="${alt}"${t} />`);
  });

  const linkRe = new RegExp(`\\[([^\\]]+)\\]\\(${URL_PATTERN}(?:\\s+&quot;([^&]*)&quot;)?\\)`, 'g');
  text = text.replace(linkRe, (_all, label: string, url: string, title?: string) => {
    const safe = safeUrl(url);
    if (!safe) return label;
    const t = title ? ` title="${title}"` : '';
    return hold(`<a class="md-link" href="${safe}" target="_blank" rel="noreferrer noopener"${t}>${label}</a>`);
  });

  text = text
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // 下划线：SRS 3.5.1.7 约定标记 <u>…</u>（白名单标签，其余 HTML 仍原文呈现）
    .replace(/&lt;u&gt;([\s\S]+?)&lt;\/u&gt;/g, '<u>$1</u>')
    // 高亮 ==x==、上标 ^x^、下标 ~x~（单波浪，须先于 ~~ 处理，此处 ~~ 已消费）
    .replace(/==([^=\n]+)==/g, '<mark class="md-mark">$1</mark>')
    .replace(/\^([^\s^]+)\^/g, '<sup>$1</sup>')
    .replace(/(^|[^~])~([^\s~]+)~/g, '$1<sub>$2</sub>');

  text = text.replace(/ {2,}$/, '<br />');
  return text.replace(/\u0000A(\d+)\u0000/g, (_m, index: string) => atoms[Number(index)]);
}

function splitRow(row: string): string[] {
  return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
}

function parseAlign(sepRow: string): string[] {
  return splitRow(sepRow).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  });
}

/**
 * 表格渲染。表头行锚点取表格首行，第 k 条数据行取首行 +2 +k（中间是分隔行）——
 * 供预览改写按「行 + 列」定位单元格源码子段（LLD §3.5）。
 */
function buildTable(headerCells: string[], aligns: string[], rows: string[][], lineNo: number): string {
  const head = headerCells
    .map((cell, index) => {
      const style = aligns[index] ? ` style="text-align:${aligns[index]}"` : '';
      return `<th${style}>${renderInline(cell)}</th>`;
    })
    .join('');
  const body = rows
    .map((row, rowIndex) => {
      const cells = headerCells
        .map((_cell, index) => {
          const style = aligns[index] ? ` style="text-align:${aligns[index]}"` : '';
          return `<td${style}>${renderInline(row[index] ?? '')}</td>`;
        })
        .join('');
      return `<tr data-line="${lineNo + 2 + rowIndex}">${cells}</tr>`;
    })
    .join('');
  return `<table class="md-table"><thead><tr data-line="${lineNo}">${head}</tr></thead><tbody>${body}</tbody></table>`;
}

interface ListMatch {
  indent: number;
  ordered: boolean;
  text: string;
}

function matchList(line: string): ListMatch | null {
  const matched = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
  if (!matched) return null;
  return {
    indent: matched[1].replace(/\t/g, '  ').length,
    ordered: /\d/.test(matched[2]),
    text: matched[3],
  };
}

/**
 * 列表解析。
 * offset 为该段相对整篇文档的行偏移（引用块内的列表靠它拿到绝对行号）——
 * 列表项的行锚点既供滚动同步，也供预览改写定位源码区间（LLD §3.5）。
 */
function parseList(lines: string[], start: number, offset = 0): { html: string; next: number } {
  const base = matchList(lines[start]) as ListMatch;
  const items: string[] = [];
  let hasTask = false;
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      const next = i + 1 < lines.length ? lines[i + 1] : '';
      const nextMatch = next === '' ? null : matchList(next);
      if (nextMatch && nextMatch.indent >= base.indent) {
        i += 1;
        continue;
      }
      break;
    }
    const current = matchList(line);
    if (!current) break;
    if (current.indent < base.indent) break;
    if (current.indent > base.indent) {
      const nested = parseList(lines, i, offset);
      items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, '') + nested.html + '</li>';
      i = nested.next;
      continue;
    }
    if (current.ordered !== base.ordered) break;

    const task = current.text.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      hasTask = true;
      const done = task[1].toLowerCase() === 'x';
      items.push(
        `<li class="md-li" data-line="${i + offset}">` +
          `<span class="md-task${done ? ' is-done' : ''}">` +
          `<span class="md-task-box" data-task="1" data-line="${i + offset}">${done ? '✓' : ''}</span>` +
          `${renderInline(task[2])}</span>`,
      );
    } else {
      items.push(`<li class="md-li" data-line="${i + offset}">${renderInline(current.text)}`);
    }

    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === '' || matchList(next)) break;
      const indent = next.match(/^\s*/)?.[0].replace(/\t/g, '  ').length ?? 0;
      if (indent <= base.indent) break;
      items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, '') + ' ' + renderInline(next.trim());
      i += 1;
    }
    if (!items[items.length - 1].endsWith('</li>')) items[items.length - 1] += '</li>';
  }

  const tag = base.ordered ? 'ol' : 'ul';
  const kind = base.ordered ? 'md-ol' : 'md-ul';
  const taskCls = hasTask ? ' md-tasklist' : '';
  return { html: `<${tag} class="md-list ${kind}${taskCls}">${items.join('')}</${tag}>`, next: i };
}

function isBlockStart(line: string): boolean {
  return (
    line.trim() === '' ||
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*\$\$/.test(line) ||
    /^\s*([-*_])\s*(\1\s*){2,}$/.test(line) ||
    !!matchList(line)
  );
}

function parseBlocks(src: string, offset = 0): string {
  return renderBlocks(src, offset).html;
}

interface BlockResult {
  html: string;
  next: number;
}

function renderBlocks(src: string, offset: number): BlockResult {
  const lines = src.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const lineNo = offset + i;

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = line.match(/^```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1;
      // ```mermaid：只落占位结构，异步渲染交 DiagramRenderer（LLD §3.3）
      // data-graph 用 encodeURIComponent 转义，避免引号/尖括号破坏属性
      if (lang.toLowerCase() === 'mermaid') {
        out.push(
          `<div class="md-diagram" data-line="${lineNo}" data-graph="${encodeURIComponent(buffer.join('\n'))}">` +
            `<div class="md-diagram-loading" aria-hidden="true"></div></div>`,
        );
        continue;
      }
      const label = lang ? `<span class="md-pre-lang">${escapeHtml(lang)}</span>` : '';
      out.push(
        `<div class="md-pre-wrap" data-line="${lineNo}">${label}<pre class="md-pre"><code>${highlight(buffer.join('\n'), lang)}</code></pre></div>`,
      );
      continue;
    }

    // 成行公式 $$…$$（SRS 3.5.2.5）：支持单行闭合与跨行书写
    if (/^\s*\$\$/.test(line)) {
      const buffer: string[] = [];
      const rest = line.replace(/^\s*\$\$/, '');
      const inlineClose = rest.match(/^([\s\S]*?)\$\$\s*$/);
      if (inlineClose) {
        buffer.push(inlineClose[1]);
        i += 1;
      } else {
        if (rest.trim()) buffer.push(rest);
        i += 1;
        while (i < lines.length && !/\$\$\s*$/.test(lines[i])) {
          buffer.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) {
          buffer.push(lines[i].replace(/\$\$\s*$/, ''));
          i += 1;
        }
      }
      const rendered = renderFormula(buffer.join('\n'), true);
      out.push(
        `<div class="md-formula-block${rendered.failed ? ' is-error' : ''}" data-line="${lineNo}">${rendered.html}</div>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const inner = renderInline(heading[2].replace(/\s+#+\s*$/, ''));
      out.push(`<h${level} class="md-h md-h${level}" data-line="${lineNo}">${inner}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push(`<hr class="md-hr" data-line="${lineNo}" />`);
      i += 1;
      continue;
    }

    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      lines[i + 1].includes('-') &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])
    ) {
      const header = splitRow(line);
      const aligns = parseAlign(lines[i + 1]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(`<div class="md-table-wrap" data-line="${lineNo}">${buildTable(header, aligns, rows, lineNo)}</div>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buffer: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buffer.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      // offset 取引用块首行行号：内层第 0 行就是引用块第 0 行（原先 +1 会让块内锚点整体偏一行，
      // 既影响滚动同步，也让预览改写定位到错误的源码行）
      const inner = parseBlocks(buffer.join('\n'), lineNo);
      out.push(`<blockquote class="md-quote" data-line="${lineNo}">${inner}</blockquote>`);
      continue;
    }

    if (matchList(line)) {
      const result = parseList(lines, i, offset);
      const attrs = ` data-line="${lineNo}"`;
      const html = result.html.replace(/^<([a-z]+) class="/, `<$1 class="`);
      out.push(html.replace(/^<([a-z]+)([^>]*)>/, `<$1$2${attrs}>`));
      i = result.next;
      continue;
    }

    const buffer: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i])) {
      buffer.push(lines[i]);
      i += 1;
    }
    const inner = renderInline(buffer.join('\n')).replace(/\n/g, '<br />');
    out.push(`<p class="md-p" data-line="${lineNo}">${inner}</p>`);
  }

  return { html: out.join('\n'), next: lines.length + offset };
}

/** 对外解析入口 */
export function parse(source: string): string {
  return parseBlocks(source);
}
