/**
 * 导入转换：HTML → Markdown（零依赖，用离线 DOMParser）；
 * .docx 经 mammoth 转 HTML 中间层后复用同一套映射（LLD §5.3：避免两套映射逻辑）
 * 追溯：LLD V2.0 §五 ｜ SRS V2.0 F-3.6（3.5.3.6）
 */

export interface ImportResult {
  markdown: string;
  warnings: string[];
}

const BLOCK_NEWLINE = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'PRE', 'BLOCKQUOTE', 'BR', 'HR', 'TABLE', 'UL', 'OL']);

function inline(node: Node, out: string[]): void {
  if (node.nodeType === 3) {
    out.push(node.textContent?.replace(/\s+/g, ' ') ?? '');
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'IFRAME') return;

  if (tag === 'BR') { out.push('\n'); return; }
  if (tag === 'IMG') {
    const src = el.getAttribute('src') ?? '';
    if (src) out.push(`![${el.getAttribute('alt') ?? ''}](${src})`);
    return;
  }
  if (tag === 'A') {
    const href = el.getAttribute('href') ?? '';
    const inner = collect(el);
    if (href) out.push(`[${inner || href}](${href})`);
    else out.push(inner);
    return;
  }
  if (tag === 'CODE' && el.closest('pre') === null) { out.push('`' + collect(el).trim() + '`'); return; }
  if (tag === 'STRONG' || tag === 'B') { out.push('**' + collect(el) + '**'); return; }
  if (tag === 'EM' || tag === 'I') { out.push('*' + collect(el) + '*'); return; }
  if (tag === 'U' || tag === 'INS') { out.push('<u>' + collect(el) + '</u>'); return; }
  if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') { out.push('~~' + collect(el) + '~~'); return; }
  if (tag === 'SUP') { out.push('^' + collect(el) + '^'); return; }
  if (tag === 'SUB') { out.push('~' + collect(el) + '~'); return; }
  if (tag === 'MARK') { out.push('==' + collect(el) + '=='); return; }
  out.push(collect(el));
}

function collect(el: Element): string {
  const parts: string[] = [];
  el.childNodes.forEach((child) => inline(child, parts));
  return parts.join('');
}

function tableToMd(table: HTMLTableElement): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return '';
  const cellsOf = (tr: Element) => Array.from(tr.querySelectorAll('td,th')).map((cell) => collect(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim());
  const header = cellsOf(rows[0]);
  const body = rows.slice(1).map(cellsOf);
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const sep = `| ${header.map(() => '---').join(' | ')} |`;
  return [line(header), sep, ...body.map(line)].join('\n');
}

function listToMd(list: HTMLElement, depth: number): string {
  const ordered = list.tagName === 'OL';
  const lines: string[] = [];
  let counter = Number(list.getAttribute('start') ?? '1');
  Array.from(list.children).forEach((child) => {
    if (child.tagName !== 'LI') return;
    const nested = Array.from(child.querySelectorAll(':scope > ul, :scope > ol'));
    const clone = child.cloneNode(true) as HTMLElement;
    Array.from(clone.querySelectorAll(':scope > ul, :scope > ol')).forEach((node) => node.remove());
    let text = collect(clone).trim().replace(/\s+/g, ' ');
    const checkbox = child.querySelector('input[type=checkbox]');
    const marker = ordered ? `${counter}. ` : '- ';
    if (checkbox) {
      const done = (checkbox as HTMLInputElement).checked;
      lines.push(`${'  '.repeat(depth)}- [${done ? 'x' : ' '}] ${text}`);
    } else {
      lines.push(`${'  '.repeat(depth)}${marker}${text}`);
    }
    counter += 1;
    nested.forEach((sub) => lines.push(listToMd(sub as HTMLElement, depth + 1)));
  });
  return lines.join('\n');
}

function blockToMd(el: HTMLElement, warnings: string[]): string {
  const tag = el.tagName;
  const text = collect(el).trim();
  if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') {
    return `${'#'.repeat(Number(tag.slice(1)))} ${text.replace(/\s+/g, ' ')}`;
  }
  if (tag === 'PRE') {
    const code = el.textContent ?? '';
    const lang = (el.firstElementChild as HTMLElement | null)?.className?.match(/language-([\w+#-]+)/)?.[1] ?? '';
    return '```' + lang + '\n' + code.replace(/\n$/, '') + '\n```';
  }
  if (tag === 'BLOCKQUOTE') {
    const inner = blockChildrenToMd(Array.from(el.children), warnings) || text;
    return inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
  }
  if (tag === 'UL' || tag === 'OL') return listToMd(el, 0);
  if (tag === 'TABLE') return tableToMd(el as HTMLTableElement);
  if (tag === 'HR') return '---';
  if (tag === 'P' || tag === 'DIV') return text.replace(/\n{3,}/g, '\n\n');
  return text;
}

function blockChildrenToMd(nodes: Element[], warnings: string[]): string {
  return nodes.map((node) => blockToMd(node as HTMLElement, warnings)).filter((part) => part !== '').join('\n\n');
}

/** 解析 HTML 文本为 Markdown；不注入当前文档、不执行脚本 */
export function htmlToMarkdown(html: string): ImportResult {
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const host = doc.body.querySelector('article, main, .markdown-body, .markdown') as HTMLElement | null;
  const root = host ?? doc.body;

  const blockChildren = Array.from(root.children).filter((child) => BLOCK_NEWLINE.has(child.tagName) || child.tagName === 'SECTION');
  let markdown: string;
  if (blockChildren.length > 0) {
    markdown = blockChildrenToMd(blockChildren, warnings);
  } else {
    const own = collect(root).trim();
    markdown = own ? own.replace(/\n{3,}/g, '\n\n') : '';
  }

  const styles = Array.from(root.querySelectorAll('style'));
  if (styles.length > 0) warnings.push('样式已忽略');
  const scripts = Array.from(root.querySelectorAll('script'));
  if (scripts.length > 0) warnings.push('脚本已忽略');

  return { markdown: markdown.trim() + (markdown ? '\n' : ''), warnings };
}

/**
 * .docx 转换：mammoth 只读解析为 HTML 中间层，再复用 HtmlToMd。
 * - 动态导入：mammoth 体积不小，只在真正导入 Word 时装载
 * - 内嵌图片由 mammoth 输出为 data URL，经 HtmlToMd 原样保留（SRS 3.5.3.6「保留图片引用」）
 * - 解析失败不改动源码，交调用方提示「导入失败，该文件可能已损坏或无法解析」
 */
async function docxToMarkdown(buffer: ArrayBuffer): Promise<ImportResult> {
  let converted: { value: string; messages: Array<{ type: string; message: string }> };
  try {
    const mammoth = await import('mammoth/mammoth.browser.js');
    converted = await mammoth.convertToHtml({ arrayBuffer: buffer });
  } catch {
    return { markdown: '', warnings: ['导入失败，该文件可能已损坏或无法解析'] };
  }
  if (!converted.value || converted.value.trim() === '') {
    return { markdown: '', warnings: ['该文件无可转换内容'] };
  }
  const result = htmlToMarkdown(converted.value);
  if (result.markdown.trim() === '') {
    return { markdown: '', warnings: ['该文件无可转换内容'] };
  }
  const warnings = [...result.warnings];
  if (converted.messages.length > 0) warnings.push('部分样式已忽略');
  return { markdown: result.markdown, warnings };
}

/** 导入入口：按扩展名分派（SRS 3.5.3.6 白名单 .html / .htm / .docx） */
export async function importFile(name: string, buffer: ArrayBuffer): Promise<ImportResult> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    const text = new TextDecoder('utf-8').decode(buffer);
    return htmlToMarkdown(text);
  }
  if (lower.endsWith('.docx')) {
    return docxToMarkdown(buffer);
  }
  return { markdown: '', warnings: ['仅支持 .html / .htm / .docx 导入'] };
}
