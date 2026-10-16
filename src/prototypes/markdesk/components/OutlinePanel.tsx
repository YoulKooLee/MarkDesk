/**
 * 文档目录面板：标题层级索引与跳转
 * 追溯：LLD V2.0 §9.4 ｜ SRS V2.0 F-6.6（3.5.6.6）
 */
import React from 'react';
import type { OutlineNode } from '../lib/outline';
import type { UiKey } from '../lib/lang';

export interface OutlinePanelProps {
  nodes: OutlineNode[];
  activeLine: number;
  t: (key: UiKey) => string;
  onJump: (node: OutlineNode) => void;
  onClose: () => void;
}

export default function OutlinePanel({ nodes, activeLine, t, onJump, onClose }: OutlinePanelProps) {
  return (
    <aside className="md-outline">
      <div className="md-outline-head">
        <span>{t('side.outline')}</span>
        <button className="md-icon-btn md-icon-btn-sm" onClick={onClose}>×</button>
      </div>
      {nodes.length === 0 ? (
        <p className="md-side-empty">{t('side.noOutline')}</p>
      ) : (
        <ul className={`md-outline-list${nodes.length > 200 ? ' is-scroll' : ''}`}>
          {nodes.map((node, index) => (
            <li
              key={`${node.line}-${index}`}
              className={`md-outline-item lv-${node.level}${node.line === activeLine ? ' is-active' : ''}`}
              style={{ paddingLeft: 8 + (node.level - 1) * 14 }}
            >
              <button onClick={() => onJump(node)}>
                {node.text || '（无题）'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
