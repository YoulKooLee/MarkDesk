/**
 * 主操作区（顶栏）：品牌 / 文档名输入 / 留存与保存状态 / 保存 / 另存为 / 导入 / 导出
 * 追溯：LLD V2.0 §十一 TopBar ｜ SRS V2.0 F-6.9、F-1.8（3.5.6.9）
 * 结构对齐线上：品牌与状态靠左，动作组靠右，文档名可直接修改
 * 语言入口已按 LLD「重复项保留一处」收敛到导航区底部的图标浮层，顶栏不再重复提供
 */
import React, { useEffect, useRef, useState } from 'react';
import { Save, SaveAll, Upload, Download, PanelLeft } from 'lucide-react';
import type { UiKey } from '../lib/lang';

export type ExportKind = 'html' | 'png' | 'word' | 'pdf' | 'md';

export interface TopBarProps {
  docName: string;
  dirty: boolean;
  retention: 'on' | 'time' | 'off';
  retentionLabel: string;
  t: (key: UiKey, vars?: Record<string, string | number>) => string;
  onDocNameChange: (next: string) => void;
  onToggleSidebar: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onImport: () => void;
  onExport: (kind: ExportKind) => void;
}

const EXPORT_ORDER: Array<{ kind: ExportKind; key: UiKey }> = [
  { kind: 'html', key: 'export.html' },
  { kind: 'png', key: 'export.png' },
  { kind: 'word', key: 'export.word' },
  { kind: 'pdf', key: 'export.pdf' },
  { kind: 'md', key: 'export.md' },
];

export default function TopBar({
  docName, dirty, retention, retentionLabel, t,
  onDocNameChange, onToggleSidebar, onSave, onSaveAs, onImport, onExport,
}: TopBarProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const [draftName, setDraftName] = useState(docName);
  const exportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setDraftName(docName), [docName]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (exportRef.current && !exportRef.current.contains(target)) setExportOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const commitName = () => {
    const next = draftName.trim();
    if (!next) { setDraftName(docName); return; }
    if (next !== docName) onDocNameChange(next);
  };

  return (
    <header className="md-topbar">
      <div className="md-topbar-left">
        <button className="md-icon-btn" onClick={onToggleSidebar} title={t('top.toggleNav')}>
          <PanelLeft size={17} />
        </button>
        <span className="md-brand-mark">MD</span>
        <span className="md-brand-name">MarkDesk</span>
        <input
          className="md-docname"
          value={draftName}
          spellCheck={false}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); commitName(); }
            if (event.key === 'Escape') setDraftName(docName);
          }}
        />
        {dirty ? <span className="md-dirty-dot" title={t('top.dirty')} /> : null}
        <span className={`md-retention${retention === 'off' ? ' is-off' : ''}`}>
          {retention === 'off' ? t('top.autoSaveOff') : retentionLabel || t('top.autoSaved')}
        </span>
      </div>

      <div className="md-topbar-right">
        <button className="md-btn md-btn-primary" onClick={onSave}>
          <Save size={15} /> {t('top.save')}
        </button>
        <button className="md-btn" onClick={onSaveAs}>
          <SaveAll size={15} /> {t('top.saveAs')}
        </button>
        <button className="md-btn" onClick={onImport}>
          <Upload size={15} /> {t('top.import')}
        </button>

        <div className="md-menu" ref={exportRef}>
          <button className="md-btn" onClick={() => setExportOpen((v) => !v)}>
            <Download size={15} /> {t('top.export')}
          </button>
          {exportOpen ? (
            <div className="md-dropdown">
              {EXPORT_ORDER.map((item) => (
                <button
                  key={item.kind}
                  className="md-dropdown-item"
                  onClick={() => { setExportOpen(false); onExport(item.kind); }}
                >
                  {t(item.key)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
