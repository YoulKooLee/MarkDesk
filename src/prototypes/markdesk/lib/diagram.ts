/**
 * 图表渲染（mermaid，离线内置、按需装载）
 * 追溯：LLD V2.0 §3.1 DiagramRenderer ｜ SRS V2.0 F-2.6（3.5.2.6）
 *
 * 装载纪律：mermaid 运行时体积大（约 5MB），只在首次遇到 ```mermaid 围栏时才装载并初始化
 * （ESM 动态导入，vite 侧自动拆分为独立 chunk；esbuild 单文件侧内联但延迟执行）。
 * 回填纪律（LLD §3.3）：渲染完成只交出 svg 字符串，由 PreviewPane 替换对应块的内层内容，
 * 不触发 setSource、不改该块 data-line —— 这是图表与滚动同步 / 预览改写互不打乱的前提。
 * 异常纪律：语法错误返回 error 标记，由 PreviewPane 呈现「图表写法有误」占位 + 原始写法。
 */
import type { ThemeMode } from './storage';

interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
}

export interface DiagramResult {
  svg?: string;
  failed: boolean;
  /** 语法错误摘要（供 title 提示），不含用户数据以外的内容 */
  reason?: string;
}

let loader: Promise<MermaidApi> | null = null;
let appliedTheme: ThemeMode | null = null;

function configFor(theme: ThemeMode): Record<string, unknown> {
  return {
    startOnLoad: false,
    // strict：输出做 XSS 消毒，与 §十四「HTML 不执行」纪律一致
    securityLevel: 'strict',
    // 不回灌错误图形到页面，错误由我们自己的占位承担
    suppressErrorRendering: true,
    theme: theme === 'dark' ? 'dark' : 'default',
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
    flowchart: { htmlLabels: false, useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    class: { htmlLabels: false, useMaxWidth: true },
    state: { useMaxWidth: true },
    er: { useMaxWidth: true },
    mindmap: { useMaxWidth: true },
  };
}

async function load(theme: ThemeMode): Promise<MermaidApi> {
  if (!loader) {
    loader = import('mermaid').then((mod) => (mod as unknown as { default: MermaidApi }).default);
  }
  const api = await loader;
  if (appliedTheme !== theme) {
    api.initialize(configFor(theme));
    appliedTheme = theme;
  }
  return api;
}

let seq = 0;

/** 把一段 mermaid 代码渲染为 svg；失败时 failed=true 并附原因 */
export async function renderDiagram(code: string, theme: ThemeMode): Promise<DiagramResult> {
  const source = code.trim();
  if (!source) return { failed: true, reason: '图表内容为空' };
  const id = `md-mermaid-${(seq += 1)}`;
  try {
    const api = await load(theme);
    const result = await api.render(id, source);
    return { svg: result.svg, failed: false };
  } catch (error) {
    // mermaid 出错时可能在 body 留下临时节点，按 id 清理
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    const reason = error instanceof Error ? error.message.split('\n')[0] : '图表写法有误';
    return { failed: true, reason };
  }
}

/** 主题变化时使已装载配置失效，下次渲染重新 initialize */
export function resetDiagramTheme(): void {
  appliedTheme = null;
}
