/**
 * 查找与替换面板
 * 追溯：LLD V2.0 §2.4、§十一 SearchPanel ｜ SRS V2.0 F-1.6（3.5.1.6）
 */
import React, { useEffect, useRef, useState } from 'react';
import { X, ChevronUp, ChevronDown, CaseSensitive } from 'lucide-react';
import type { UiKey } from '../lib/lang';

export interface SearchPanelProps {
  t: (key: UiKey, vars?: Record<string, string | number>) => string;
  initial: string;
  hitCount: number;
  current: number;
  caseSensitive: boolean;
  onClose: () => void;
  onSearch: (needle: string, caseSensitive: boolean) => void;
  onMove: (delta: 1 | -1) => void;
  onReplace: (replacement: string, all: boolean) => void;
  onToggleCase: () => void;
}

export default function SearchPanel({
  t, initial, hitCount, current, caseSensitive, onClose, onSearch, onMove, onReplace, onToggleCase,
}: SearchPanelProps) {
  const [needle, setNeedle] = useState(initial);
  const [replacement, setReplacement] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => onSearch(needle, caseSensitive), 160);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, caseSensitive]);

  const noMatch = needle.trim() !== '' && hitCount === 0;

  return (
    <div className="md-find" role="search">
      <div className="md-find-row">
        <input
          ref={inputRef}
          className="md-find-input"
          value={needle}
          placeholder={t('find.placeholder')}
          spellCheck={false}
          onChange={(event) => setNeedle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); onMove(event.shiftKey ? -1 : 1); }
            if (event.key === 'Escape') onClose();
          }}
        />
        <span className={`md-find-count${noMatch ? ' is-none' : ''}`}>
          {noMatch ? t('find.none') : hitCount > 0 ? t('find.of', { i: current + 1, n: hitCount }) : ''}
        </span>
        <button className="md-find-btn" onClick={onToggleCase} title={t('find.case')} aria-pressed={caseSensitive}>
          <CaseSensitive size={15} />
        </button>
        <button className="md-find-btn" onClick={() => onMove(-1)} title={t('find.prev')} disabled={hitCount === 0}>
          <ChevronUp size={15} />
        </button>
        <button className="md-find-btn" onClick={() => onMove(1)} title={t('find.next')} disabled={hitCount === 0}>
          <ChevronDown size={15} />
        </button>
        <button className="md-find-btn" onClick={onClose} title={t('find.close')}>
          <X size={15} />
        </button>
      </div>
      <div className="md-find-row">
        <input
          className="md-find-input"
          value={replacement}
          placeholder={t('find.replacePlaceholder')}
          spellCheck={false}
          onChange={(event) => setReplacement(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
        />
        <button className="md-find-action" onClick={() => onReplace(replacement, false)} disabled={hitCount === 0}>
          {t('find.replace')}
        </button>
        <button className="md-find-action" onClick={() => onReplace(replacement, true)} disabled={hitCount === 0}>
          {t('find.replaceAll')}
        </button>
      </div>
    </div>
  );
}
