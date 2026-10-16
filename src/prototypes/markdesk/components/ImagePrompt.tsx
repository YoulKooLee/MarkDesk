/**
 * 图片插入：网络地址与本地文件两个入口
 * 追溯：LLD V2.0 §七 ImagePrompt ｜ SRS V2.0 F-5.1（3.5.5.1）
 *
 * 形态复用链接弹窗（md-modal-mask-thin / md-modal-mini），插入类弹窗手感统一。
 * 本地文件不在此组件里选：宿主差异（桌面原生对话框 / 浏览器文件选择器）与
 * 登记、避让、写引用统一由上层处理，弹窗只负责取值与防重复提交。
 */
import React, { useEffect, useRef, useState } from 'react';
import type { UiKey } from '../lib/lang';

export interface ImagePromptProps {
  initialText: string;
  /** 本地图片登记中：禁用全部入口，避免重复登记同一张图 */
  busy: boolean;
  t: (key: UiKey) => string;
  onSubmitUrl: (input: { alt: string; url: string }) => void;
  onPickLocal: (alt: string) => void;
  onCancel: () => void;
}

export default function ImagePrompt({ initialText, busy, t, onSubmitUrl, onPickLocal, onCancel }: ImagePromptProps) {
  const [alt, setAlt] = useState(initialText);
  const [url, setUrl] = useState('');
  const urlRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { urlRef.current?.focus(); }, []);

  const trimmed = url.trim();

  return (
    <div className="md-modal-mask md-modal-mask-thin" onMouseDown={busy ? undefined : onCancel}>
      <div className="md-modal md-modal-mini" onMouseDown={(event) => event.stopPropagation()}>
        <div className="md-modal-head">
          <span>{t('img.title')}</span>
          <button className="md-icon-btn md-icon-btn-sm" disabled={busy} onClick={onCancel}>×</button>
        </div>
        <div className="md-modal-body md-form">
          <label>
            <span>{t('img.alt')}</span>
            <input value={alt} spellCheck={false} onChange={(event) => setAlt(event.target.value)} />
          </label>
          <label>
            <span>{t('img.url')}</span>
            <input
              ref={urlRef}
              value={url}
              spellCheck={false}
              placeholder="https://…"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); if (trimmed && !busy) onSubmitUrl({ alt, url: trimmed }); }
                if (event.key === 'Escape') onCancel();
              }}
            />
          </label>
          <p className="md-form-hint">{t('img.pasteHint')}</p>
        </div>
        <div className="md-modal-foot">
          <button className="md-btn" disabled={busy} onClick={onCancel}>{t('img.cancel')}</button>
          <button className="md-btn" disabled={busy} onClick={() => onPickLocal(alt)}>{t('img.local')}</button>
          <button
            className="md-btn md-btn-primary"
            disabled={!trimmed || busy}
            onClick={() => onSubmitUrl({ alt, url: trimmed })}
          >
            {t('img.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
