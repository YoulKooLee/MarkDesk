/**
 * 代码块轻量着色（自实现分词，避免引入体积较大的高亮库）
 * 追溯：LLD §二 Highlighter ｜ SRS F-6.1
 * 实现要点：在**原文**上分词，逐段转义后再拼装；若先整体转义，转义实体（如 &#39;）
 * 会被数字/关键字规则二次匹配，导致实体被打碎、页面出现乱码。
 */
import { escapeHtml } from './markdown';

type LangKey = 'js' | 'py' | 'css' | 'html' | 'json' | 'sql' | 'plain';

const KEYWORDS: Record<string, string[]> = {
  js: [
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
    'case', 'break', 'continue', 'import', 'from', 'export', 'default', 'class', 'extends', 'new',
    'this', 'super', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'typeof', 'instanceof',
    'interface', 'type', 'implements', 'public', 'private', 'readonly', 'static', 'void', 'null',
    'undefined', 'true', 'false', 'as', 'of', 'in', 'yield', 'delete',
  ],
  py: [
    'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'with',
    'try', 'except', 'finally', 'raise', 'lambda', 'pass', 'None', 'True', 'False', 'and', 'or',
    'not', 'is', 'in', 'yield', 'async', 'await', 'global',
  ],
  sql: [
    'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create',
    'table', 'drop', 'alter', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'order',
    'by', 'having', 'limit', 'distinct', 'as', 'and', 'or', 'not', 'null', 'count', 'sum', 'avg',
  ],
  css: ['important', 'inherit', 'initial', 'auto', 'none', 'solid', 'flex', 'grid', 'block', 'inline'],
};

const LANG_MAP: Record<string, LangKey> = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', javascript: 'js', typescript: 'js',
  py: 'py', python: 'py',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', xml: 'html', vue: 'html', svg: 'html',
  json: 'json',
  sql: 'sql',
};

const HASH_COMMENT = ['py', 'python', 'sh', 'bash', 'shell', 'yml', 'yaml', 'rb', 'ruby', 'conf', 'ini'];

function wrap(cls: string, raw: string): string {
  return `<span class="${cls}">${escapeHtml(raw)}</span>`;
}

function highlightJson(raw: string): string {
  const pattern = /("(?:[^"\\\n]|\\.)*")(\s*:)?|(\b-?\d+(?:\.\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)/g;
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    out += escapeHtml(raw.slice(last, match.index));
    if (match[1]) {
      out += match[2] ? wrap('tk-key', match[1]) + escapeHtml(match[2]) : wrap('tk-str', match[1]);
    } else if (match[3]) {
      out += wrap('tk-num', match[3]);
    } else {
      out += wrap('tk-kw', match[4]);
    }
    last = match.index + match[0].length;
  }
  out += escapeHtml(raw.slice(last));
  return out;
}

export function highlight(code: string, lang: string): string {
  const key = (lang || '').toLowerCase();
  const mapped = LANG_MAP[key] || (HASH_COMMENT.includes(key) ? 'py' : 'plain');
  if (mapped === 'plain') return escapeHtml(code);
  if (mapped === 'json') return highlightJson(code);

  const kw = KEYWORDS[mapped] || [];
  const hashLead = HASH_COMMENT.includes(key);
  const comment = hashLead
    ? '#[^\\n]*'
    : mapped === 'css'
      ? '/\\*[\\s\\S]*?\\*/'
      : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
  const stringPart = '"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`';
  const kwPart = kw.length ? `|(\\b(?:${kw.join('|')})\\b)` : '';
  const pattern = new RegExp(
    `(${comment})` + `|(${stringPart})` + `|(\\b\\d+(?:\\.\\d+)?\\b)` + `|(<\\/?[A-Za-z][\\w-]*)` + kwPart,
    'g',
  );

  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    out += escapeHtml(code.slice(last, match.index));
    const cls = match[1] ? 'tk-com' : match[2] ? 'tk-str' : match[3] ? 'tk-num' : match[4] ? 'tk-tag' : 'tk-kw';
    out += wrap(cls, match[0]);
    last = match.index + match[0].length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}
