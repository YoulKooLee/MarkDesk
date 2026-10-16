/**
 * 链接输入：工具栏「链接」与插入图片地址共用的取值弹窗
 * 追溯：LLD V2.0 §2.3 ｜ SRS V2.0 F-1.7（3.5.1.7 链接行为）
 */
import React, { useEffect, useRef, useState } from 'react';
import type { UiKey } from '../lib/lang';
import type { LinkInput } from '../lib/formatOps';

export interface LinkPromptProps {
  initialText: string;
  t: (key: UiKey) => string;
  onSubmit: (input: LinkInput) => void;
  onCancel: () => void;
}

export default function LinkPrompt({ initialText, t, onSubmit, onCancel }: LinkPromptProps) {
  const [text, setText] = useState(initialText);
  const [url, setUrl] = useState('');
  const urlRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { urlRef.current?.focus(); }, []);

  return (
    <div className="md-modal-mask md-modal-mask-thin" onMouseDown={onCancel}>
      <div className="md-modal md-modal-mini" onMouseDown={(event) => event.stopPropagation()}>
        <div className="md-modal-head">
          <span>{t('link.title')}</span>
          <button className="md-icon-btn md-icon-btn-sm" onClick={onCancel}>×</button>
        </div>
        <div className="md-modal-body md-form">
          <label>
            <span>{t('link.text')}</span>
            <input value={text} spellCheck={false} onChange={(event) => setText(event.target.value)} />
          </label>
          <label>
            <span>{t('link.url')}</span>
            <input
              ref={urlRef}
              value={url}
              spellCheck={false}
              placeholder="https://…"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); if (url.trim()) onSubmit({ text, url: url.trim() }); }
                if (event.key === 'Escape') onCancel();
              }}
            />
          </label>
        </div>
        <div className="md-modal-foot">
          <button className="md-btn" onClick={onCancel}>{t('link.cancel')}</button>
          <button className="md-btn md-btn-primary" disabled={!url.trim()} onClick={() => onSubmit({ text, url: url.trim() })}>
            {t('link.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
