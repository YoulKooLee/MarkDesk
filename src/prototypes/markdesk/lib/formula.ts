/**
 * 公式渲染（KaTeX，离线内置、同步）
 * 追溯：LLD V2.0 §3.1 FormulaRenderer ｜ SRS V2.0 F-2.5（3.5.2.5）
 *
 * 归属纪律：本模块只负责「TeX → HTML」，公式段切分由 markdown.ts 承担
 * （LLD §3.2：先按 $ 定界切段，普通段走行内规则，公式段整体交给本模块，
 *  否则 $a_b^c$ 中的 _ ^ 会被行内强调规则吃掉）。
 * 异常纪律：语法错误不抛异常、不中断整篇渲染 —— 该位置原文呈现（LLD §3.6）。
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';

export interface FormulaResult {
  html: string;
  /** 该段是否为语法错误（原文呈现），供上层决定是否提示「公式写法有误」 */
  failed: boolean;
}

// 本地 escape：避免与 markdown.ts 形成循环依赖
function escapePlain(input: string): string {
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

const BASE_OPTIONS = {
  throwOnError: true,
  // trust:false —— 禁用 \href \htmlData 等可注入宏，与 §十四 转义纪律一致
  trust: false,
  strict: false,
  output: 'htmlAndMathml',
} as const;

/**
 * 渲染一段 TeX 为 HTML 字符串。
 * 失败时返回 `<code class="md-formula-raw">原文</code>`，调用方可据此在原位提示。
 */
export function renderFormula(tex: string, display: boolean): FormulaResult {
  const source = tex.trim();
  if (!source) return { html: '', failed: false };
  try {
    const html = katex.renderToString(source, { ...BASE_OPTIONS, displayMode: display });
    return { html, failed: false };
  } catch {
    return {
      html: `<code class="md-formula-raw" title="${escapePlain('公式写法有误')}">${escapePlain(source)}</code>`,
      failed: true,
    };
  }
}

/** 供行内段快速判定：文本里是否可能存在公式定界符 */
export function hasFormula(src: string): boolean {
  return src.includes('$');
}
