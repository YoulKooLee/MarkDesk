/**
 * 文档目录：从源码提取标题层级，供目录入口跳转
 * 追溯：LLD V2.0 §9.4 ｜ SRS V2.0 F-6.6（3.5.6.6）
 */

export interface OutlineNode {
  level: number;
  text: string;
  line: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;

/**
 * 按 ATX 标题提取层级；围栏代码块内的 `#` 不算标题。
 * line 为源码 0 基行号，与渲染结果的 data-line 锚点同一口径。
 */
export function extractOutline(source: string): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  // 行尾归一化（CRLF→LF）：与 markdown.ts renderBlocks 同口径，保证标题正则稳定匹配
  const lines = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```|^~~~/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const matched = line.match(HEADING_RE);
    if (!matched) continue;
    nodes.push({ level: matched[1].length, text: matched[2].trim(), line: index });
  }
  return nodes;
}

/** 目录条目上限：超出后由界面内滚动承载（SRS 3.5.6.6 边界） */
export const OUTLINE_SCROLL_THRESHOLD = 200;
