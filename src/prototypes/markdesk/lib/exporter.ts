/**
 * 导出：Markdown 源文件 / 独立 HTML / Word（.doc）/ 便携文档（.pdf）/ 图片（.png）
 * 追溯：LLD V2.0 §六 M6 ｜ SRS V2.0 F-4.1 ~ F-4.5（3.5.4.1 ~ 3.5.4.5）
 *
 * 阶段二要点：
 * - 取材纪律：导出内容取自**预览区实际渲染结果**（含已回填的 mermaid SVG 与 KaTeX 结构），
 *   与 SRS「输出内容与预览区渲染结果一致」对齐；预览不可用（仅编辑态）时退回解析结果。
 * - KaTeX 样式：运行时从 CSSOM 提取（构建期已把字体内联为 data URL），随文件一并携带，
 *   保证导出产物零外部引用、断网可读（SRS 3.5.4.2 业务规则）。
 * - Word 形态为可被 Word 打开的标记型网页文档（LLD §6.2 口径），扩展名 .doc。
 * - PDF / PNG 依赖宿主渲染能力：桌面端交主进程（隐藏窗口打印 / 截图）；浏览器宿主降级提示。
 */
import { desktopBridge, writeFile } from './fileBridge';
import type { ThemeMode } from './storage';

export type ExportFormat = 'markdown' | 'html' | 'word' | 'pdf' | 'png';

export const APP_CSS = `
:root{--bg:#f6f7f9;--panel:#ffffff;--border:#e3e6ec;--text:#1b2230;--text-weak:#6b7583;--accent:#2f6fed;--code-bg:#f4f6f9;}
body{margin:0;padding:48px 20px;background:var(--bg);color:var(--text);
 font:15px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
.md-doc{max-width:820px;margin:0 auto;background:var(--panel);border:1px solid var(--border);
 border-radius:12px;padding:48px 56px;}
.md-h{font-weight:650;line-height:1.35;margin:28px 0 12px;letter-spacing:.2px;}
.md-h1{font-size:28px;margin-top:0;} .md-h2{font-size:23px;border-bottom:1px solid var(--border);padding-bottom:8px;}
.md-h3{font-size:19px;} .md-h4{font-size:16px;} .md-h5{font-size:15px;} .md-h6{font-size:14px;color:var(--text-weak);}
.md-p{margin:12px 0;} .md-list{margin:12px 0;padding-left:24px;} .md-li{margin:5px 0;}
.md-task{display:flex;gap:8px;align-items:flex-start;}
.md-task-box{flex:none;width:16px;height:16px;border:1px solid #9aa4b2;border-radius:4px;
 margin-top:4px;font-size:12px;line-height:15px;text-align:center;color:#fff;}
.md-task.is-done .md-task-box{background:var(--accent);border-color:var(--accent);}
.md-task.is-done{color:var(--text-weak);text-decoration:line-through;}
.md-quote{margin:14px 0;padding:10px 16px;border-left:3px solid var(--accent);background:#f2f5fb;color:#4b5563;border-radius:0 8px 8px 0;}
.md-hr{border:0;border-top:1px solid var(--border);margin:26px 0;}
.md-inline-code{background:var(--code-bg);border:1px solid var(--border);border-radius:5px;padding:1px 5px;font-size:.9em;}
.md-pre-wrap{position:relative;margin:16px 0;}
.md-pre-lang{position:absolute;top:8px;right:12px;font-size:11px;color:#8b95a5;letter-spacing:.6px;text-transform:uppercase;}
.md-pre{background:var(--code-bg);border:1px solid var(--border);border-radius:10px;padding:18px;overflow:auto;
 font-family:"JetBrains Mono",Consolas,"Courier New",monospace;font-size:13px;line-height:1.7;margin:0;}
.md-table-wrap{overflow:auto;margin:16px 0;}
.md-table{border-collapse:collapse;width:100%;font-size:14px;}
.md-table th,.md-table td{border:1px solid var(--border);padding:9px 12px;text-align:left;}
.md-table th{background:#f2f5fb;font-weight:600;}
.md-link{color:var(--accent);text-decoration:none;border-bottom:1px solid rgba(47,111,237,.35);}
.md-img{max-width:100%;border-radius:8px;}
.md-img-broken{display:inline-block;padding:8px 12px;border:1px dashed var(--border);border-radius:8px;color:var(--text-weak);font-size:12px;}
.md-mark{background:#fff3bf;border-radius:3px;padding:0 2px;}
.md-formula-block{margin:16px 0;overflow-x:auto;text-align:center;}
.md-formula-raw{display:inline-block;padding:1px 6px;border:1px dashed #d8483d;border-radius:6px;
 background:var(--code-bg);color:#d8483d;font-family:"JetBrains Mono",Consolas,monospace;font-size:.88em;}
.md-diagram{margin:16px 0;padding:12px;border:1px solid var(--border);border-radius:10px;background:#fafbfd;text-align:center;overflow:auto;}
.md-diagram svg{max-width:100%;height:auto;}
.md-diagram-source{margin:8px 0 0;padding:10px;background:var(--code-bg);border-radius:8px;color:var(--text-weak);
 font-family:"JetBrains Mono",Consolas,monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-word;}
.md-diagram-error-tip{color:#d8483d;font-size:12.5px;}
.tk-kw{color:#8a4bd6;} .tk-str{color:#1f9d68;} .tk-com{color:#96a0ad;font-style:italic;}
.tk-num{color:#d9722a;} .tk-tag{color:#2f6fed;}
`;

const DARK_CSS = `
:root{--bg:#12151b;--panel:#181c24;--border:#2a303b;--text:#e6e9ef;--text-weak:#98a2b3;--accent:#6f9dff;--code-bg:#11141a;}
body{background:var(--bg);color:var(--text);}
.md-quote{background:#1d222c;color:#b9c0cd;}
.md-table th{background:#1d222c;}
.md-diagram{background:#151922;border-color:var(--border);}
.md-mark{background:#4a3f12;color:#ffe9a8;}
.tk-kw{color:#c191ff;} .tk-str{color:#5fd39a;} .tk-com{color:#7d8797;} .tk-num{color:#ffab6b;} .tk-tag{color:#6f9dff;}`;

/** 打印/分页规则（SRS 3.5.4.4：避免块内断行、表格跨页表头重复） */
const PRINT_CSS = `
@media print{
  body{padding:0;background:#fff;}
  .md-doc{max-width:none;border:0;border-radius:0;padding:0;box-shadow:none;}
  .md-pre-wrap,.md-table-wrap,.md-diagram,.md-formula-block,.md-quote,.md-task,li,tr{break-inside:avoid;page-break-inside:avoid;}
  .md-table thead{display:table-header-group;}
  .md-h{break-after:avoid;page-break-after:avoid;}
}`;

export function detectLineEnding(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

/* ------------------------------------------------------------------ *
 * 取材与样式收集
 * ------------------------------------------------------------------ */

/** 从预览区取「实际渲染结果」：克隆后剔除未渲染完成的图表骨架，避免骨架进产物 */
export function collectExportBody(previewEl: HTMLElement | null, fallbackHtml: string): string {
  const article = previewEl?.querySelector('article.md-doc');
  if (!article) return fallbackHtml.replace(/<div class="md-diagram-loading"[^>]*><\/div>/g, '');
  const clone = article.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.md-diagram-loading').forEach((node) => node.remove());
  return clone.innerHTML;
}

let katexCssCache: string | null = null;

/**
 * 收集 KaTeX 样式（含 @font-face 内联字体）：
 * 这些规则由构建期从 katex.min.css 打进 renderer.css，运行时通过 CSSOM 序列化取出，
 * 使导出产物自身携带公式样式，无需外部引用。
 */
export function collectKatexCss(): string {
  if (katexCssCache !== null) return katexCssCache;
  const chunks: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const isFont = rule.type === 5 /* CSSRule.FONT_FACE_RULE */;
      if (isFont || /katex/i.test(rule.cssText)) chunks.push(rule.cssText);
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested && nested.length > 0) visit(nested);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (sheet.cssRules) visit(sheet.cssRules);
    } catch {
      /* 跨源样式表拿不到规则，跳过（本地宿主不会出现） */
    }
  }
  katexCssCache = chunks.join('\n');
  return katexCssCache;
}

function readTheme(): ThemeMode {
  try {
    const raw = window.localStorage.getItem('markdesk:prefs');
    const theme = raw ? (JSON.parse(raw) as { theme?: string }).theme : 'light';
    return theme === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

type DocMode = 'file' | 'word' | 'render';

function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch] || ch));
}

/**
 * 组装自包含 HTML 文档（导出 HTML / Word / 打印与截图三态共用）。
 * - file：独立网页，除 KaTeX 样式外只带导出专用样式表
 * - word：加 Office 命名空间与 @page 纸张设定，交文字处理软件打开
 * - render：供隐藏窗口打印 / 截图使用，视口即纸张正文宽度
 */
export function buildDocument(mode: DocMode, bodyHtml: string, title: string, theme: ThemeMode): string {
  const themeCss = theme === 'dark' ? DARK_CSS : '';
  const katex = collectKatexCss();
  const styleParts = [APP_CSS, themeCss, katex, mode === 'file' ? PRINT_CSS : ''].filter(Boolean);

  if (mode === 'word') {
    return [
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">',
      '<head><meta charset="utf-8" />',
      `<title>${escapeText(title)}</title>`,
      '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->',
      '<style>',
      '@page WordSection1{size:595.3pt 841.9pt;margin:72pt 72pt 72pt 72pt;}',
      'div.WordSection1{page:WordSection1;}',
      'body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;font-size:10.5pt;line-height:1.6;}',
      '.md-doc{max-width:none;border:0;border-radius:0;padding:0;background:transparent;box-shadow:none;}',
      '.md-table{border-collapse:collapse;}',
      '.md-table th,.md-table td{border:1px solid #999;}',
      '.md-task-box{display:inline-block;width:12px;height:12px;line-height:12px;text-align:center;}',
      styleParts.join('\n'),
      '</style></head><body><div class="WordSection1"><article class="md-doc">',
      bodyHtml || '<p class="md-p">暂无内容</p>',
      '</article></div></body></html>',
    ].join('\n');
  }

  if (mode === 'render') {
    const katexFontNote = '';
    return [
      '<!DOCTYPE html>',
      '<html lang="zh-CN"><head><meta charset="utf-8" />',
      `<title>${escapeText(title)}</title>`,
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      `<style>${katexFontNote}`,
      'html,body{background:' + (theme === 'dark' ? '#12151b' : '#ffffff') + ';}',
      'body{padding:0;margin:0;}',
      '.md-doc{max-width:none;margin:0;border:0;border-radius:0;box-shadow:none;background:transparent;}',
      styleParts.join('\n'),
      PRINT_CSS,
      '</style></head><body><article class="md-doc">',
      bodyHtml || '<p class="md-p">暂无内容</p>',
      '</article></body></html>',
    ].join('\n');
  }

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><meta charset="utf-8" />',
    `<title>${escapeText(title)}</title>`,
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<style>',
    styleParts.join('\n'),
    '</style></head>',
    `<body><article class="md-doc">${bodyHtml || '<p class="md-p">暂无内容</p>'}</article></body></html>`,
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * 各形态导出
 * ------------------------------------------------------------------ */

/** 导出 Markdown：与源码逐字符一致（SRS F-4.1）；startDir 为记住目录起点（SRS 3.5.3.7） */
export async function exportMarkdown(source: string, name: string, handle: unknown | null, startDir?: string | null) {
  return writeFile(handle, ensureExt(name, '.md'), source, startDir);
}

/** 导出独立 HTML：内联样式、零外部引用（SRS F-4.2） */
export async function exportHtml(bodyHtml: string, name: string, handle: unknown | null, startDir?: string | null) {
  const doc = buildDocument('file', bodyHtml, name, readTheme());
  return writeFile(handle, ensureExt(name, '.html'), doc, startDir);
}

/** 导出 Word：标记型网页文档，扩展名 .doc（SRS F-4.3 / LLD §6.2） */
export async function exportWord(bodyHtml: string, name: string, handle: unknown | null, startDir?: string | null) {
  const doc = buildDocument('word', bodyHtml, name, 'light');
  return writeFile(handle, ensureExt(name, '.doc'), doc, startDir);
}

export interface BinaryExportResult {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  path?: string;
  name?: string;
  /** 图片形态：内容过高被按段拼接时的提示标记 */
  stitched?: boolean;
  clipped?: boolean;
}

/** 导出便携文档（SRS F-4.4）：桌面端交主进程隐藏窗口打印链路 */
export async function exportPdf(bodyHtml: string, name: string, startDir?: string | null): Promise<BinaryExportResult> {
  const host = desktopBridge();
  if (!host?.exportPdf) return { ok: false, error: '当前宿主不支持该导出形态，请在桌面版使用' };
  const doc = buildDocument('render', bodyHtml, name, readTheme());
  return host.exportPdf({ html: doc, defaultName: ensureExt(name, '.pdf'), startDir });
}

/** 导出图片（SRS F-4.5）：桌面端交主进程隐藏窗口截图链路 */
export async function exportImage(bodyHtml: string, name: string, startDir?: string | null): Promise<BinaryExportResult> {
  const host = desktopBridge();
  if (!host?.exportImage) return { ok: false, error: '当前宿主不支持该导出形态，请在桌面版使用' };
  const theme = readTheme();
  const doc = buildDocument('render', bodyHtml, name, theme);
  return host.exportImage({ html: doc, defaultName: ensureExt(name, '.png'), startDir, theme });
}

export function ensureExt(name: string, ext: string): string {
  const trimmed = (name || '未命名文档').trim();
  if (/\.(md|markdown|txt|html|doc|pdf|png)$/i.test(trimmed)) {
    return trimmed.replace(/\.(md|markdown|txt|html|doc|pdf|png)$/i, ext);
  }
  return `${trimmed}${ext}`;
}
