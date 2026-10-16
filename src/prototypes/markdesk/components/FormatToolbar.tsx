/**
 * 格式操作区：撤销重做 / 标题 / 强调 / 列表引用 / 插入 / 查找 / 快捷键 / 语法
 * 追溯：LLD V2.0 §二 FormatToolbar ｜ SRS V2.0 F-1.7（3.5.1.7）
 * 项序与线上实测一致（差异清单 A2）
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Undo2, Redo2, Heading, Bold, Italic, Underline, Strikethrough, Type,
  Quote, ListChecks, List, ListOrdered, Tag, Code, SquareCode, Link, Image,
  Table, Minus, Workflow, Search, Keyboard, BookOpen, Superscript, Subscript,
  Highlighter,
} from 'lucide-react';
import type { FormatCommand } from '../lib/formatOps';
import type { UiKey } from '../lib/lang';

export interface FormatToolbarProps {
  t: (key: UiKey) => string;
  canUndo: boolean;
  canRedo: boolean;
  disabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onCommand: (command: FormatCommand) => void;
  onFind: () => void;
  onShortcuts: () => void;
  onSyntax: () => void;
}

interface Item {
  icon?: React.ReactNode;
  text?: string;
  titleKey: UiKey;
  command?: FormatCommand;
}

export default function FormatToolbar({
  t, canUndo, canRedo, disabled, onUndo, onRedo, onCommand, onFind, onShortcuts, onSyntax,
}: FormatToolbarProps) {
  const [headingOpen, setHeadingOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const headingRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (headingRef.current && !headingRef.current.contains(target)) setHeadingOpen(false);
      if (moreRef.current && !moreRef.current.contains(target)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const fire = (command: FormatCommand) => {
    if (disabled) return;
    onCommand(command);
  };

  const items: Array<Item | 'sep'> = [
    { icon: <Bold size={15} />, titleKey: 'fmt.bold', command: 'bold' },
    { icon: <Italic size={15} />, titleKey: 'fmt.italic', command: 'italic' },
    { icon: <Underline size={15} />, titleKey: 'fmt.underline', command: 'underline' },
    { icon: <Strikethrough size={15} />, titleKey: 'fmt.strike', command: 'strike' },
    'sep',
    { icon: <Quote size={15} />, titleKey: 'fmt.quote', command: 'quote' },
    { icon: <ListChecks size={15} />, titleKey: 'fmt.task', command: 'task' },
    { icon: <List size={15} />, titleKey: 'fmt.ul', command: 'ul' },
    { icon: <ListOrdered size={15} />, titleKey: 'fmt.ol', command: 'ol' },
    'sep',
    { icon: <Tag size={15} />, titleKey: 'fmt.tag', command: 'tag' },
    { icon: <Code size={15} />, titleKey: 'fmt.code', command: 'code' },
    { icon: <SquareCode size={15} />, titleKey: 'fmt.codeblock', command: 'codeblock' },
    { icon: <Link size={15} />, titleKey: 'fmt.link', command: 'link' },
    { icon: <Image size={15} />, titleKey: 'fmt.image', command: 'image' },
    { icon: <Table size={15} />, titleKey: 'fmt.table', command: 'table' },
    { icon: <Minus size={15} />, titleKey: 'fmt.hr', command: 'hr' },
    { icon: <Workflow size={15} />, titleKey: 'fmt.mermaid', command: 'mermaid' },
    'sep',
    { icon: <Search size={15} />, titleKey: 'fmt.find' },
    { icon: <Keyboard size={15} />, titleKey: 'fmt.shortcuts' },
    { icon: <BookOpen size={15} />, titleKey: 'fmt.syntax' },
  ];

  return (
    <div className={`md-fmtbar${disabled ? ' is-disabled' : ''}`}>
      <button className="md-fmt-btn" onClick={onUndo} disabled={!canUndo || disabled} title={t('fmt.undo')}>
        <Undo2 size={15} />
      </button>
      <button className="md-fmt-btn" onClick={onRedo} disabled={!canRedo || disabled} title={t('fmt.redo')}>
        <Redo2 size={15} />
      </button>

      <div className="md-menu" ref={headingRef}>
        <button className="md-fmt-btn" disabled={disabled} onClick={() => { setHeadingOpen((v) => !v); setMoreOpen(false); }} title={t('fmt.h')}>
          <Heading size={15} />
        </button>
        {headingOpen ? (
          <div className="md-dropdown">
            {([1, 2, 3, 4, 5, 6] as const).map((level) => (
              <button key={level} className="md-dropdown-item" onClick={() => { setHeadingOpen(false); fire(`h${level}` as FormatCommand); }}>
                H{level}
              </button>
            ))}
            <button className="md-dropdown-item" onClick={() => { setHeadingOpen(false); fire('p'); }}>{t('fmt.h')} → ¶</button>
          </div>
        ) : null}
      </div>

      {items.map((item, index) => {
        if (item === 'sep') return <span className="md-fmt-sep" key={`sep-${index}`} />;
        const special = (item.titleKey === 'fmt.find' || item.titleKey === 'fmt.shortcuts' || item.titleKey === 'fmt.syntax');
        return (
          <button
            key={item.titleKey}
            className={`md-fmt-btn${special ? ' md-fmt-btn-ghost' : ''}`}
            disabled={disabled}
            title={t(item.titleKey)}
            onClick={() => {
              if (item.titleKey === 'fmt.find') { onFind(); return; }
              if (item.titleKey === 'fmt.shortcuts') { onShortcuts(); return; }
              if (item.titleKey === 'fmt.syntax') { onSyntax(); return; }
              if (item.command) fire(item.command);
            }}
          >
            {item.icon}
          </button>
        );
      })}

      <div className="md-menu md-fmt-more" ref={moreRef}>
        <button className="md-fmt-btn" disabled={disabled} onClick={() => { setMoreOpen((v) => !v); setHeadingOpen(false); }} title={t('fmt.more')}>
          <Type size={15} />
        </button>
        {moreOpen ? (
          <div className="md-dropdown">
            <button className="md-dropdown-item" onClick={() => { setMoreOpen(false); fire('sup'); }}><Superscript size={14} /> x²</button>
            <button className="md-dropdown-item" onClick={() => { setMoreOpen(false); fire('sub'); }}><Subscript size={14} /> x₂</button>
            <button className="md-dropdown-item" onClick={() => { setMoreOpen(false); fire('mark'); }}><Highlighter size={14} /> {t('fmt.more')}</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
