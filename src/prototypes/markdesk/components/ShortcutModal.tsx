/**
 * 快捷键说明：三组十条，数据源与 KeyBindings 对齐
 * 追溯：LLD V2.0 §9.3 ｜ SRS V2.0 F-6.8（3.5.6.8）
 */
import React from 'react';
import type { UiKey } from '../lib/lang';

export interface ShortcutModalProps {
  t: (key: UiKey) => string;
  onClose: () => void;
}

interface Row { labelKey: UiKey | null; label: string; win: string; mac: string }
interface Group { titleKey: UiKey; rows: Row[] }

/** 单一来源：与 index.tsx 的键位分派一一对应（LLD §13.4） */
export const SHORTCUT_GROUPS: Group[] = [
  {
    titleKey: 'sc.file',
    rows: [
      { labelKey: null, label: '保存文档', win: 'Ctrl + S', mac: '⌘ S' },
      { labelKey: null, label: '撤销', win: 'Ctrl + Z', mac: '⌘ Z' },
      { labelKey: null, label: '重做', win: 'Ctrl + Y', mac: '⌘ Y' },
    ],
  },
  {
    titleKey: 'sc.format',
    rows: [
      { labelKey: null, label: '加粗', win: 'Ctrl + B', mac: '⌘ B' },
      { labelKey: null, label: '斜体', win: 'Ctrl + I', mac: '⌘ I' },
      { labelKey: null, label: '下划线', win: 'Ctrl + U', mac: '⌘ U' },
      { labelKey: null, label: '插入链接', win: 'Ctrl + K', mac: '⌘ K' },
      { labelKey: null, label: '插入图片', win: 'Ctrl + Shift + K', mac: '⌘ ⇧ K' },
    ],
  },
  {
    titleKey: 'sc.find',
    rows: [
      { labelKey: null, label: '查找', win: 'Ctrl + F', mac: '⌘ F' },
      { labelKey: null, label: '替换', win: 'Ctrl + H', mac: '⌘ H' },
      { labelKey: null, label: '插入 4 空格缩进', win: 'Tab', mac: 'Tab' },
    ],
  },
];

export default function ShortcutModal({ t, onClose }: ShortcutModalProps) {
  return (
    <div className="md-modal-mask" onMouseDown={onClose}>
      <div className="md-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="md-modal-head">
          <span>{t('sc.title')}</span>
          <button className="md-icon-btn md-icon-btn-sm" onClick={onClose}>×</button>
        </div>
        <div className="md-modal-body">
          <table className="md-help-table">
            <thead>
              <tr>
                <th>{t('sc.win')}</th>
                <th>{t('sc.mac')}</th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUT_GROUPS.map((group) => (
                <React.Fragment key={group.titleKey}>
                  <tr className="md-sc-group"><td colSpan={2}>{t(group.titleKey)}</td></tr>
                  {group.rows.map((row) => (
                    <tr key={row.label}>
                      <td>{row.win}</td>
                      <td>
                        {row.mac}
                        <span className="md-sc-label">{row.label}</span>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
