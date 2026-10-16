/**
 * 导航区：缩略图标栏（图标在上、小字在下，宽 60px）+ 右侧浮层收纳需要展开的内容
 * 追溯：LLD V2.0 §十一 Sidebar ｜ SRS V2.0 F-6.10（3.5.6.10）
 *
 * 形态对齐 MarkPane：主组六个入口竖排「图标 + 小字」，底部主题 / 语言只用图标。
 * 「最近文件」「视图三态」「语言」内容较多，改为点图标后在栏右侧弹出浮层承载，点外部或 Esc 收起。
 * 导航区整体的收起 / 展开由顶栏的 PanelLeft 按钮负责（故此处不再放 ✕）。
 *
 * 底部「更多工具分享」入口按用户裁定移除（原为不可点击的文案占位，与线上外链行为不一致）。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  FolderOpen, FilePlus2, ListTree, History, HelpCircle,
  Sun, Moon, Eye, EyeOff, Globe, Check, X,
} from 'lucide-react';
import type { RecentRecord, ViewMode, ThemeMode } from '../lib/storage';
import type { LangCode, UiKey } from '../lib/lang';
import { LANG_OPTIONS } from '../lib/lang';

export interface SidebarProps {
  recent: RecentRecord[];
  viewMode: ViewMode;
  theme: ThemeMode;
  lang: LangCode;
  activeFile: string | null;
  outlineOpen: boolean;
  t: (key: UiKey) => string;
  onOpen: () => void;
  onNew: () => void;
  onToggleOutline: () => void;
  onOpenRecent: (record: RecentRecord) => void;
  onRemoveRecent: (record: RecentRecord) => void;
  onViewMode: (mode: ViewMode) => void;
  onOpenHelp: () => void;
  onToggleTheme: () => void;
  onPickLang: (code: LangCode) => void;
}

const VIEW_ITEMS: Array<{ mode: ViewMode; key: UiKey }> = [
  { mode: 'both', key: 'view.both' },
  { mode: 'edit', key: 'view.edit' },
  { mode: 'preview', key: 'view.preview' },
];

type FlyoutKey = 'recent' | 'view' | 'lang' | null;

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface RailItemProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  onClick: (el: HTMLButtonElement) => void;
}

function RailItem({ icon, label, active, buttonRef, onClick }: RailItemProps) {
  return (
    <button
      ref={buttonRef}
      className={`md-rail-item${active ? ' is-active' : ''}`}
      title={label}
      onClick={(event) => onClick(event.currentTarget)}
    >
      <span className="md-rail-icon">{icon}</span>
      <span className="md-rail-label">{label}</span>
    </button>
  );
}

export default function Sidebar({
  recent, viewMode, theme, lang, activeFile, outlineOpen, t,
  onOpen, onNew, onToggleOutline, onOpenRecent, onRemoveRecent, onViewMode, onOpenHelp, onToggleTheme, onPickLang,
}: SidebarProps) {
  const [flyout, setFlyout] = useState<FlyoutKey>(null);
  /** 浮层贴合后的位置：top 为相对 wrap 的顶边，maxHeight 为压进可视区后的高度上限 */
  const [flyoutBox, setFlyoutBox] = useState<{ top: number; maxHeight: number }>({ top: 8, maxHeight: 360 });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const anchors = useRef<Record<string, HTMLButtonElement | null>>({});

  const toggleFlyout = useCallback((key: Exclude<FlyoutKey, null>, el?: HTMLButtonElement | null) => {
    if (flyout === key) {
      setFlyout(null);
      return;
    }
    if (el) anchors.current[key] = el;
    setFlyout(key);
  }, [flyout]);

  /**
   * 浮层贴合视口：默认与触发项顶对齐、向下展开；下方放不下时改为「底边贴合触发项」向上展开，
   * 并把高度压进可视区（超出部分在浮层内部滚动）。
   * 语言有 10 项而触发图标在栏底，向下展开必然溢出屏幕底 —— 故必须测量真实高度后再定位。
   */
  const placeFlyout = useCallback(() => {
    const wrap = wrapRef.current;
    const panel = panelRef.current;
    if (!wrap || !panel || !flyout) return;
    const anchor = anchors.current[flyout] ?? null;
    const EDGE = 8;
    const wrapTop = wrap.getBoundingClientRect().top;
    const viewport = window.innerHeight;
    const available = viewport - wrapTop - EDGE; // 相对 wrap 的可视高度
    // 限量高度下 clientHeight 已被裁剪，取 scrollHeight 才是内容的真实需求高度
    const natural = panel.scrollHeight + 2;
    let top = EDGE;
    if (anchor) {
      const anchorRect = anchor.getBoundingClientRect();
      top = anchorRect.top - wrapTop;
      if (top + natural > available) {
        const upward = anchorRect.bottom - wrapTop - natural;
        top = upward >= EDGE ? upward : EDGE;
      }
    }
    top = Math.max(EDGE, Math.round(top));
    const maxHeight = Math.max(120, Math.round(available - top));
    setFlyoutBox((prev) => (prev.top === top && prev.maxHeight === maxHeight ? prev : { top, maxHeight }));
  }, [flyout]);

  useLayoutEffect(() => {
    if (!flyout) return;
    placeFlyout();
    window.addEventListener('resize', placeFlyout);
    return () => window.removeEventListener('resize', placeFlyout);
  }, [flyout, placeFlyout]);

  useEffect(() => {
    if (!flyout) return;
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setFlyout(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFlyout(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [flyout]);

  return (
    <div className="md-side-wrap" ref={wrapRef}>
      <aside className="md-rail">
        <RailItem icon={<FolderOpen size={18} />} label={t('side.open')} onClick={onOpen} />
        <RailItem icon={<FilePlus2 size={18} />} label={t('side.new')} onClick={onNew} />
        <RailItem
          icon={<ListTree size={18} />}
          label={t('side.outline')}
          active={outlineOpen}
          onClick={onToggleOutline}
        />
        <RailItem
          icon={<History size={18} />}
          label={t('side.recent')}
          active={flyout === 'recent'}
          buttonRef={(el) => { anchors.current.recent = el; }}
          onClick={(el) => toggleFlyout('recent', el)}
        />
        <RailItem
          icon={viewMode === 'edit' ? <EyeOff size={18} /> : <Eye size={18} />}
          label={t('side.view')}
          active={flyout === 'view'}
          buttonRef={(el) => { anchors.current.view = el; }}
          onClick={(el) => toggleFlyout('view', el)}
        />
        <RailItem icon={<HelpCircle size={18} />} label={t('side.help')} onClick={onOpenHelp} />

        <div className="md-rail-foot">
          <button className="md-rail-iconbtn" onClick={onToggleTheme} title={t('side.theme')}>
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <button
            ref={(el) => { anchors.current.lang = el; }}
            className={`md-rail-iconbtn${flyout === 'lang' ? ' is-active' : ''}`}
            onClick={(event) => toggleFlyout('lang', event.currentTarget)}
            title={t('side.lang')}
          >
            <Globe size={18} />
          </button>
        </div>
      </aside>

      {flyout === 'recent' ? (
        <div className="md-flyout" ref={panelRef} data-flyout="recent" style={{ top: flyoutBox.top, maxHeight: flyoutBox.maxHeight }}>
          <div className="md-flyout-head">{t('side.recent')}</div>
          {recent.length === 0 ? (
            <p className="md-flyout-empty">{t('side.empty')}</p>
          ) : (
            <ul className="md-recent-list">
              {recent.map((item) => (
                <li key={item.path} className={`md-recent-item${item.name === activeFile ? ' is-active' : ''}`}>
                  <button className="md-recent-main" onClick={() => onOpenRecent(item)} title={item.path}>
                    <span className="md-recent-name">{item.name}</span>
                    <span className="md-recent-time">{formatTime(item.visited_at)}</span>
                  </button>
                  <button className="md-recent-remove" onClick={() => onRemoveRecent(item)} title={t('tip.removed')}>
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {flyout === 'view' ? (
        <div className="md-flyout" ref={panelRef} data-flyout="view" style={{ top: flyoutBox.top, maxHeight: flyoutBox.maxHeight }}>
          <div className="md-flyout-head">{t('side.view')}</div>
          <div className="md-flyout-list">
            {VIEW_ITEMS.map((item) => (
              <button
                key={item.mode}
                className={`md-flyout-row${viewMode === item.mode ? ' is-active' : ''}`}
                onClick={() => { onViewMode(item.mode); setFlyout(null); }}
              >
                <span>{t(item.key)}</span>
                {viewMode === item.mode ? <Check size={14} /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {flyout === 'lang' ? (
        <div className="md-flyout" ref={panelRef} data-flyout="lang" style={{ top: flyoutBox.top, maxHeight: flyoutBox.maxHeight }}>
          <div className="md-flyout-head">{t('side.lang')}</div>
          <div className="md-flyout-list">
            {LANG_OPTIONS.map((option) => (
              <button
                key={option.code}
                className={`md-flyout-row${lang === option.code ? ' is-active' : ''}`}
                onClick={() => { onPickLang(option.code); setFlyout(null); }}
              >
                <span>{option.label}</span>
                {lang === option.code ? <Check size={14} /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
