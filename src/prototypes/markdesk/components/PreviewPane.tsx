/**
 * 预览区：渲染结果呈现 + 待办勾选回写 + 预览改写 + 滚动驱动
 * 追溯：LLD §二、§三、§六 PreviewPane ｜ SRS F-2.1、F-2.5、F-2.6、F-6.2（3.5.2.4）
 *
 * 阶段二接入：```mermaid 图表异步回填（只替换块内层内容，不改 data-line、不触发 setSource）、
 * 公式错误与图表错误的本地化呈现、以及预览改写（点击块 → 原位输入 → blur/Enter 提交 / Esc 放弃）。
 */
import React, { forwardRef, useCallback, useEffect, useRef } from 'react';
import { renderDiagram } from '../lib/diagram';
import { blockReadableText, REWRITE_HIT, rewriteTargetOf, type RewriteTarget } from '../lib/rewrite';
import type { ThemeMode } from '../lib/storage';
import type { UiKey } from '../lib/lang';

export interface RewriteSubmit {
  target: RewriteTarget;
  text: string;
}

export interface PreviewPaneProps {
  html: string;
  empty: boolean;
  emptyText?: string;
  theme: ThemeMode;
  t: (key: UiKey) => string;
  onToggleTask: (line: number) => void;
  /** 携带事件：同步层据此识别「程序化滚动」派发的回声，避免两侧互相抢占 */
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  /** 图表异步回填后触发：外层据此重采行锚点（LLD §3.3） */
  onContentShift?: () => void;
  /**
   * 相对路径图片的呈现来源（SRS 3.5.5.2：打开带资源夹的文档要能显示图；
   * 3.5.5.3：导出烘焙取用同一张表，保证产出与预览同款）。
   * 未命中时保留原引用，交由 onerror 显示「图片无法载入」占位。
   */
  assetUrls?: Record<string, string>;
  /**
   * 预览改写开关（SRS 3.5.2.4）：预览可见时可写。
   * 返回 true 表示已采纳（源码更新或无需更新）；返回 false 时本块回滚为原呈现。
   */
  onRewrite?: (submit: RewriteSubmit) => boolean;
  /** 改写进行中 —— 外层据此暂停滚动同步，避免回写重排引发跳动（LLD §3.5） */
  onRewritingChange?: (active: boolean) => void;
  /** 本次改写因源码被其他来源改动而丢弃（LLD §3.5 冲突处理） */
  onRewriteDropped?: () => void;
  /**
   * 源码修订号（外层持有，每次源码写入同步自增）。
   * 进入改写态时记下当时的值，提交前复核：对不上说明手上这份是按旧现场算的，必须丢弃。
   */
  revisionRef?: { current: number };
}

function escapeText(input: string): string {
  return input.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch] ?? ch));
}

const PreviewPane = forwardRef<HTMLDivElement, PreviewPaneProps>(function PreviewPane(
  { html, empty, emptyText, theme, t, onToggleTask, onScroll, onContentShift, assetUrls, onRewrite, onRewritingChange, onRewriteDropped, revisionRef },
  ref,
) {
  /** 进行中的改写会话：记住节点、原内容与进入时的源码修订号，供提交 / 丢弃判定 */
  const sessionRef = useRef<{ node: HTMLElement; original: string; rev: number } | null>(null);
  // 图片不可用占位 + 公式错误提示（SRS 3.5.2.1 / LLD §3.6）
  useEffect(() => {
    const container = typeof ref === 'object' && ref ? ref.current : null;
    if (!container) return;

    const images = Array.from(container.querySelectorAll('img'));
    images.forEach((image) => {
      const node = image as HTMLImageElement & { mdAssetResolved?: boolean };
      const raw = image.getAttribute('src') ?? '';
      // 相对路径引用（资源夹）→ 换成呈现用 data URL；网络地址与 data URL 原样保留
      const isRelative = !!raw && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw);
      const resolved = isRelative ? assetUrls?.[raw] : undefined;
      if (resolved) {
        node.mdAssetResolved = true;
        image.setAttribute('src', resolved);
      }

      image.onerror = () => {
        /**
         * 竞态防护：相对路径那次请求必然失败（磁盘文件不在应用根下），其 error 事件
         * 可能晚于换源才派发；本 effect 又可能因 html / 资源表分别更新而在同一份 DOM
         * 上跑第二次（此时 src 已是 data URL，靠字符串比对会失效）。
         * 故用节点标记位判定：一旦换过源，旧请求的失败一律忽略。
         */
        if (node.mdAssetResolved) return;
        const placeholder = document.createElement('span');
        placeholder.className = 'md-img-broken';
        placeholder.textContent = t('preview.imgBroken');
        image.parentNode?.replaceChild(placeholder, image);
      };
    });

    container.querySelectorAll('.md-formula-raw').forEach((node) => {
      node.setAttribute('title', t('preview.formulaError'));
    });
  }, [html, ref, t, assetUrls]);

  /**
   * 图表异步渲染（LLD §3.3）：
   * - 依赖 html 或 theme 变化重跑；data-rendered 记录「已按哪个主题渲染过」，避免重复渲染
   * - 渲染顺序串行（mermaid 内部有共享状态，不宜并发）
   * - 组件卸载或 html 变更时置 cancelled，防止回填到已废弃的节点
   */
  useEffect(() => {
    const container = typeof ref === 'object' && ref ? ref.current : null;
    if (!container) return;
    const pending = Array.from(container.querySelectorAll<HTMLElement>('.md-diagram[data-graph]')).filter(
      (node) => node.dataset.rendered !== theme,
    );
    if (pending.length === 0) return;

    let cancelled = false;
    const run = async () => {
      for (const node of pending) {
        if (cancelled) return;
        const code = decodeURIComponent(node.dataset.graph ?? '');
        // eslint-disable-next-line no-await-in-loop
        const result = await renderDiagram(code, theme);
        if (cancelled || !node.isConnected) continue;
        if (result.svg) {
          node.innerHTML = result.svg;
          node.classList.remove('is-error');
        } else {
          node.classList.add('is-error');
          node.innerHTML =
            `<div class="md-diagram-error"><span class="md-diagram-error-tip">${escapeText(t('preview.diagramError'))}</span>` +
            `<pre class="md-diagram-source">${escapeText(code)}</pre></div>`;
        }
        node.dataset.rendered = theme;
      }
      if (!cancelled) onContentShift?.();
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [html, theme, ref, t, onContentShift]);

  /* ------------------------------------------------------------------ *
   * 预览改写（SRS 3.5.2.4 / LLD §3.5）
   * 点击可改写块 → contenteditable → blur / Enter 提交，Esc 放弃。
   * ------------------------------------------------------------------ */

  /** 从当下 DOM 现场重采行锚点，供「本块占几行」的判定使用（不改 data-line，不影响滚动同步） */
  const nextLineOf = useCallback((line: number): number | null => {
    const container = typeof ref === 'object' && ref ? ref.current : null;
    if (!container) return null;
    const all = new Set<number>();
    container.querySelectorAll('[data-line]').forEach((node) => {
      const value = Number(node.getAttribute('data-line'));
      if (!Number.isNaN(value)) all.add(value);
    });
    let found: number | null = null;
    all.forEach((value) => {
      if (value > line && (found === null || value < found)) found = value;
    });
    return found;
  }, [ref]);

  const endEdit = useCallback(
    (keep: boolean) => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      onRewritingChange?.(false);
      const node = session.node;
      node.removeAttribute('contenteditable');
      node.classList.remove('md-rw-active');
      // 源码在编辑期间被其他来源改过（撤销等）→ 手上这份改写按旧现场算的，丢弃不合并
      const stale = revisionRef !== undefined && revisionRef.current !== session.rev;
      if (!keep || stale) {
        node.innerHTML = session.original;
        if (stale) onRewriteDropped?.();
        return;
      }
      const text = blockReadableText(node);
      const target = rewriteTargetOf(node, nextLineOf);
      const accepted = target !== null && (onRewrite?.({ target, text }) ?? false);
      if (!accepted) node.innerHTML = session.original;
    },
    [nextLineOf, onRewrite, onRewritingChange, onRewriteDropped, revisionRef],
  );

  const beginEdit = useCallback(
    (node: HTMLElement) => {
      const active = sessionRef.current;
      if (active?.node === node) return;
      if (active) endEdit(true);
      node.setAttribute('contenteditable', 'plaintext-only');
      node.classList.add('md-rw-active');
      sessionRef.current = { node, original: node.innerHTML, rev: revisionRef?.current ?? 0 };
      onRewritingChange?.(true);
      node.focus();
      // 光标落在块尾，点击后可直接续写
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    [endEdit, onRewritingChange, revisionRef],
  );

  /**
   * 源码因其他来源变更导致重渲染 → 丢弃未完成的改写（LLD §3.5 冲突处理，以最后一次源码为准）。
   * 自身提交也会换 html，但那时会话已在 endEdit 里清空，不会误伤。
   */
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    onRewritingChange?.(false);
    if (session.node.isConnected) {
      session.node.removeAttribute('contenteditable');
      session.node.classList.remove('md-rw-active');
      session.node.innerHTML = session.original;
    }
    // 该路径与 blur 路径互斥（先到者清空会话）：谁抢到都告知一次，用户不会白打一段字
    onRewriteDropped?.();
  }, [html, onRewritingChange, onRewriteDropped]);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const task = target.closest('[data-task]') as HTMLElement | null;
    if (task) {
      const line = Number(task.getAttribute('data-line'));
      if (!Number.isNaN(line)) onToggleTask(line);
      return;
    }
    if (!onRewrite) return;
    const session = sessionRef.current;
    if (session && session.node.contains(target)) return;
    const node = target.closest(REWRITE_HIT) as HTMLElement | null;
    if (!node || !rewriteTargetOf(node, nextLineOf)) return;
    beginEdit(node);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!sessionRef.current) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      endEdit(true);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      endEdit(false);
    }
  };

  const handleBlur = () => {
    if (sessionRef.current) endEdit(true);
  };

  if (empty) {
    return (
      <div className="md-pane md-preview" ref={ref} onScroll={onScroll}>
        <div className="md-empty">{emptyText ?? '暂无内容'}</div>
      </div>
    );
  }

  return (
    <div
      className="md-pane md-preview"
      ref={ref}
      onScroll={onScroll}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      dangerouslySetInnerHTML={{ __html: `<article class="md-doc">${html}</article>` }}
    />
  );
});

export default PreviewPane;
