/**
 * 编辑区：源码输入 + 编辑辅助（Tab 缩进 / 列表继承 / 成对符号补全）
 * 追溯：LLD V2.0 §一 EditAssist、§十一 EditorPane ｜ SRS V2.0 F-1.1、F-1.4
 * V2.0 变更：辅助与输入统一走「新全文 + 目标光标」回调，撤销栈在能力层单点入栈
 */
import React, { forwardRef } from 'react';

const PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '`': '`',
  '*': '*',
};

export interface EditorPaneProps {
  value: string;
  assistEnabled: boolean;
  /** 键盘输入（origin=key，由上层并入撤销栈合并窗口） */
  onChange: (next: string) => void;
  /** 编辑辅助生成的改动（origin=assist，携带目标光标） */
  onAssist: (next: string, selStart: number, selEnd: number) => void;
  /** 粘贴板含图片（SRS 3.5.5.1：走本地文件规则） */
  onPasteImage?: (file: File) => void;
  /** 携带事件：同步层据此识别「程序化滚动」派发的回声，避免两侧互相抢占 */
  onScroll: (event: React.UIEvent<HTMLTextAreaElement>) => void;
}

function findLineStart(text: string, position: number): number {
  const index = text.lastIndexOf('\n', position - 1);
  return index < 0 ? 0 : index + 1;
}

function listMarker(line: string): { marker: string; content: string } | null {
  const matched = line.match(/^(\s*)([-*+]|\d+\.|\[[ xX]\])\s+(.*)$/) ||
    line.match(/^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s?.*)$/);
  if (!matched) return null;
  const indent = matched[1];
  const marker = matched[2];
  const content = matched[3];
  if (/^\[[ xX]\]/.test(content)) {
    return { marker: `${indent}${marker} [ ] `, content: content.replace(/^\[[ xX]\]\s*/, '') };
  }
  return { marker: `${indent}${marker} `, content };
}

const EditorPane = forwardRef<HTMLTextAreaElement, EditorPaneProps>(function EditorPane(
  { value, assistEnabled, onChange, onAssist, onPasteImage, onScroll },
  ref,
) {
  /** 在光标处插入文本并把光标放到插入之后（辅助类改动统一入栈） */
  const insert = (node: HTMLTextAreaElement, text: string, caretOffset: number) => {
    const start = node.selectionStart;
    const end = node.selectionEnd;
    const next = value.slice(0, start) + text + value.slice(end);
    const caret = start + caretOffset;
    onAssist(next, caret, caret);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const node = event.currentTarget;
    if (!assistEnabled) return;

    const start = node.selectionStart;
    const end = node.selectionEnd;
    const selected = start !== end;

    // Tab / Shift+Tab：四空格缩进与反缩进（SRS 3.5.1.4 / 3.5.6.8「Tab=4 空格」）
    if (event.key === 'Tab') {
      event.preventDefault();
      const lineStart = findLineStart(value, start);
      const lineEndIndex = value.indexOf('\n', start);
      const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
      if (selected || (!event.shiftKey && start !== lineStart)) {
        insert(node, '    ', 4);
        return;
      }
      if (event.shiftKey) {
        const line = value.slice(lineStart, lineEnd);
        const stripped = line.startsWith('    ') ? line.slice(4) : line.replace(/^\t/, '').replace(/^ {1,4}/, '');
        const removed = line.length - stripped.length;
        const next = value.slice(0, lineStart) + stripped + value.slice(lineEnd);
        onAssist(next, Math.max(lineStart, start - removed), Math.max(lineStart, start - removed));
        return;
      }
      const next = value.slice(0, lineStart) + '    ' + value.slice(lineStart);
      onAssist(next, start + 4, start + 4);
      return;
    }

    // Enter：列表标记继承（SRS 3.5.1.4）
    if (event.key === 'Enter' && !event.shiftKey && !selected) {
      const lineStart = findLineStart(value, start);
      if (start > lineStart) {
        const line = value.slice(lineStart, start);
        const marker = listMarker(line);
        if (marker) {
          event.preventDefault();
          const nextMarker = /^\s*\d+\./.test(marker.marker)
            ? marker.marker.replace(/(\d+)\./, (_m, n: string) => `${Number(n) + 1}.`)
            : marker.marker;
          const insertText = marker.content.trim() === '' ? '\n' : `\n${nextMarker}`;
          insert(node, insertText, insertText.length);
        }
      }
      return;
    }

    // 成对符号补全（SRS 3.5.1.4）：有选区 → 包裹；无选区 → 补对
    if (selected && PAIRS[event.key]) {
      event.preventDefault();
      const closing = PAIRS[event.key];
      const inner = value.slice(start, end);
      insert(node, `${event.key}${inner}${closing}`, inner.length + 1);
      return;
    }

    if (!selected && PAIRS[event.key]) {
      const closing = PAIRS[event.key];
      const next = value[start];
      const prev = value[start - 1];
      const isWordBoundary = !next || /[\s)\]}>'"`*]/.test(next);
      const canPair = event.key === closing ? !(prev === closing || /[\w一-龥]/.test(prev || '')) : true;
      if (isWordBoundary && canPair) {
        event.preventDefault();
        insert(node, `${event.key}${closing}`, 1);
      }
    }
  };

  /**
   * 粘贴板含图片时接管：交给上层登记并写引用（SRS 3.5.5.1）。
   * 纯文本粘贴不拦截，保持原有输入行为。
   */
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onPasteImage) return;
    const item = Array.from(event.clipboardData?.items ?? []).find((entry) => entry.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    onPasteImage(file);
  };

  return (
    <textarea
      ref={ref}
      className="md-editor-area"
      value={value}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onScroll={onScroll}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
    />
  );
});

export default EditorPane;
