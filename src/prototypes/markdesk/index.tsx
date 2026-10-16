/**
 * MarkDesk —— 本地离线 Markdown 编辑器（Axhub 原型层可运行原型）
 * 规格真源：docs/01-需求与规划/MarkDesk-SRS需求规格说明书-V2.0.md
 * 设计依据：docs/02-架构与设计/MarkDesk-概要设计-V2.0.md、MarkDesk-详细设计-V2.0.md
 * 阶段一接线：顶栏 / 侧栏 / 格式操作区 / 撤销重做 / 查找替换 / 目录 / 语言 / 全屏 /
 *            帮助与快捷键 / 记住目录 / 数据清理 / 导入（HTML；Word 随阶段二）
 * 阶段二接线：公式与图表渲染（PreviewPane 内）、五种导出形态、.html/.docx 导入、
 *            图片插入（网络地址 / 本地文件 / 粘贴板）与资源夹落盘、导出烘焙
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TopBar, { type ExportKind } from './components/TopBar';
import Sidebar from './components/Sidebar';
import FormatToolbar from './components/FormatToolbar';
import EditorPane from './components/EditorPane';
import PreviewPane from './components/PreviewPane';
import SearchPanel from './components/SearchPanel';
import OutlinePanel from './components/OutlinePanel';
import HelpPanel from './components/HelpPanel';
import ShortcutModal from './components/ShortcutModal';
import LinkPrompt from './components/LinkPrompt';
import ImagePrompt from './components/ImagePrompt';
import { parse } from './lib/markdown';
import {
  ClearService,
  DirService,
  DraftService,
  PrefService,
  RecentService,
  type ClearScope,
  type Prefs,
  type RecentRecord,
  type ViewMode,
} from './lib/storage';
import {
  desktopBridge,
  handleName,
  handlePath,
  isDesktopHost,
  openByPath,
  openDropped,
  openFile,
  openImportFile,
  pathDir,
  pickSavePath,
  writeFile,
  type ImportedSource,
} from './lib/fileBridge';
import {
  collectExportBody,
  ensureExt,
  exportHtml,
  exportImage,
  exportMarkdown,
  exportPdf,
  exportWord,
} from './lib/exporter';
import { UndoStack, applyChange, type Change, type Origin } from './lib/undoStack';
import { applyFormat, buildImageChange, buildLink, type FormatCommand, type LinkInput } from './lib/formatOps';
import {
  bakeUrls,
  dataUrlOf,
  folderFor,
  IMAGE_EXT,
  planMaterialize,
  registerImage,
  registerImageData,
  retargetSource,
  takenNames,
  type AssetRef,
  type ImageInput,
} from './lib/assets';
import { findHits, replaceAll, replaceOne, NEEDLE_LIMIT, type Hit } from './lib/searchEngine';
import { buildRewrite, type RewriteTarget } from './lib/rewrite';
import { extractOutline, type OutlineNode } from './lib/outline';
import { importFile } from './lib/importer';
import { LANG_OPTIONS, translate, type UiKey } from './lib/lang';
import { WELCOME_DOC } from './lib/welcome';
import type { LangCode } from './lib/lang';
import './styles.css';

const LARGE_FILE_THRESHOLD = 1024 * 1024;
const DEFAULT_DOC_NAME = '未命名文档.md';
/** 产出体积明显增大的判定线（SRS 3.5.5.3：不阻断，仅提示） */
const BIG_EXPORT_THRESHOLD = 6 * 1024 * 1024;

/** 浏览器宿主的本地图片选择（桌面宿主走原生对话框，SRS 3.5.5.1） */
function pickImageViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = IMAGE_EXT.join(',');
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

export default function MarkDeskApp() {
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);

  const [prefs, setPrefs] = useState<Prefs>(() => PrefService.get());
  const [source, setSource] = useState<string>('');
  const [baseline, setBaseline] = useState<string>('');
  const [docName, setDocName] = useState<string>(DEFAULT_DOC_NAME);
  const [fileHandle, setFileHandle] = useState<unknown | null>(null);
  const [recent, setRecent] = useState<RecentRecord[]>([]);
  const [html, setHtml] = useState<string>('');
  const [toast, setToast] = useState<string>('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [graphTick, setGraphTick] = useState(0);

  // 查找与替换（SRS 3.5.1.6）
  const [findOpen, setFindOpen] = useState(false);
  const [findNeedle, setFindNeedle] = useState('');
  const [findCase, setFindCase] = useState(true);
  const [hits, setHits] = useState<Hit[]>([]);
  const [hitIndex, setHitIndex] = useState(0);

  // 链接输入弹窗
  const [linkAsk, setLinkAsk] = useState<{ sel: { start: number; end: number }; prefill: string } | null>(null);

  // 图片插入（SRS 3.5.5.1）：弹窗取值 + 本地图片登记中标记
  const [imageAsk, setImageAsk] = useState<{ sel: { start: number; end: number }; prefill: string } | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  /** 相对路径 → data URL：预览呈现与导出烘焙共用同一张表（SRS 3.5.5.2 / 3.5.5.3） */
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  /** 待写清单：插入后先驻内存，文档落地时写入资源夹 */
  const assetRefs = useRef<AssetRef[]>([]);

  const history = useRef(new UndoStack()).current;
  const blocksRef = useRef<Array<{ line: number; top: number }>>([]);
  const lockUntilRef = useRef(0);
  const driverRef = useRef<'editor' | 'preview' | null>(null);
  /**
   * 程序化滚动标记：我们给某一侧设过 scrollTop 后，它会异步派发一次 scroll 事件。
   * 若不认出来，这次事件会被当成「用户在该侧滚动」并反向拽另一侧 ——
   * 两侧互相抢占、一路掉到顶部或乱跳（实测：设完立即出现对侧 scrollTop 归零）。
   * 判据同时看「是不是同一个盒子」与「位置是否仍等于我们设的值」：
   * 用户一旦真的滚了，位置就偏离，标记自然失效，不会吞掉用户操作。
   */
  const suppressRef = useRef<{ box: HTMLElement | null; value: number; until: number }>({ box: null, value: -1, until: 0 });
  /** 预览改写进行中：暂停滚动同步，避免回写重排引发跳动（LLD §3.5） */
  const rewritingRef = useRef(false);
  /**
   * 源码修订号：每一次源码写入都同步自增。
   * 预览改写靠它判定「我编辑期间源码被别人动过」——那时手上这份改写是按旧现场算的，
   * 必须丢弃（LLD §3.5 冲突处理：以最后一次源码为准，不合并）。
   * 放在 ref 里而不是 state：撤销会顺带把焦点抢回编辑区触发 blur，时机早于重渲染。
   */
  const sourceRevRef = useRef(0);
  const toastTimer = useRef<number | null>(null);
  const savingRef = useRef(false);

  const dirty = source !== baseline;
  const lang = prefs.lang;
  const t = useCallback(
    (key: UiKey, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang],
  );

  const outline = useMemo<OutlineNode[]>(() => (outlineOpen ? extractOutline(source) : []), [source, outlineOpen]);
  const bumpHistory = useCallback(() => setHistoryTick((v) => v + 1), []);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2600);
  }, []);

  const updatePrefs = useCallback((partial: Partial<Prefs>) => {
    setPrefs((current) => PrefService.patch({ ...current, ...partial }));
  }, []);

  const measureLineHeight = () => {
    const node = editorRef.current;
    if (!node) return 24;
    const raw = window.getComputedStyle(node).lineHeight;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
  };

  /**
   * 编辑器「源码行 → 视觉纵坐标」映射表。
   *
   * 为什么需要：textarea 是软换行的，一行源码可能占多个视觉行，
   * 于是 scrollTop / lineHeight 得到的是「视觉行号」而非源码行号 ——
   * 含长行的文档实测偏差可达 25%（128 行文档：视觉行 68 对源码行 54），
   * 拿它去查预览锚点会越滚越错位。改为用同宽同字体的离线容器逐行量高、累加出精确坐标。
   */
  const lineMetricsRef = useRef<{ src: string; width: number; ys: Float64Array } | null>(null);

  const lineOffsets = useCallback((): Float64Array | null => {
    const node = editorRef.current;
    if (!node) return null;
    const cs = window.getComputedStyle(node);
    const width = node.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
    if (!(width > 0)) return null;
    const src = node.value;
    const cached = lineMetricsRef.current;
    if (cached && cached.src === src && cached.width === width) return cached.ys;

    const rows = src.split('\n');
    // 超大文档不做逐行测量：代价高、收益递减，交回比例换算
    if (rows.length > 4000) {
      lineMetricsRef.current = null;
      return null;
    }

    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = [
      'position:absolute', 'left:-100000px', 'top:0', 'visibility:hidden', 'pointer-events:none',
      'margin:0', 'padding:0', 'border:0', 'box-sizing:content-box',
      `width:${width}px`,
      `font-family:${cs.fontFamily}`, `font-size:${cs.fontSize}`, `font-weight:${cs.fontWeight}`,
      `line-height:${cs.lineHeight}`, `letter-spacing:${cs.letterSpacing}`,
      'white-space:pre-wrap', 'overflow-wrap:break-word', 'word-break:break-word',
    ].join(';');
    document.body.appendChild(probe);
    const spans: HTMLElement[] = [];
    rows.forEach((text) => {
      const row = document.createElement('div');
      // 空行也占一行高：塞零宽空格保证盒高存在
      row.textContent = text.length > 0 ? text : '\u200b';
      probe.appendChild(row);
      spans.push(row);
    });
    // 先插完再一次性读高度，避免逐行触发重排
    const heights = spans.map((row) => row.getBoundingClientRect().height);
    probe.remove();

    const ys = new Float64Array(rows.length);
    let acc = 0;
    for (let index = 0; index < rows.length; index += 1) {
      ys[index] = acc;
      acc += heights[index];
    }
    lineMetricsRef.current = { src, width, ys };
    return ys;
  }, []);

  /** 二分：落在 offset 处的是第几行（行顶 y ≤ offset 的最后一行） */
  const lineAtOffset = (ys: Float64Array, offset: number): number => {
    let low = 0;
    let high = ys.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (ys[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  /** 二分 + 行内插值：小数行号也能换回像素坐标 */
  const offsetOfLine = (ys: Float64Array, line: number): number => {
    const clamped = Math.min(Math.max(line, 0), ys.length - 1);
    const low = Math.floor(clamped);
    const high = Math.min(low + 1, ys.length - 1);
    if (high === low) return ys[low];
    return ys[low] + (ys[high] - ys[low]) * (clamped - low);
  };

  const selectHit = (hit: Hit) => {
    const node = editorRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(hit.start, hit.end);
    const lineHeight = measureLineHeight();
    const line = source.slice(0, hit.start).split('\n').length - 1;
    const top = line * lineHeight;
    if (top < node.scrollTop || top > node.scrollTop + node.clientHeight - lineHeight) {
      node.scrollTop = Math.max(0, top - node.clientHeight / 2);
    }
  };

  /**
   * 源码写入唯一通道（LLD §13.2 M1.setSource）：入撤销栈 + 更新状态 + 恢复光标。
   * origin='key' 时光标已由浏览器维护，不再重置，避免输入抖动。
   */
  const commit = useCallback(
    (next: string, origin: Origin, selStart?: number, selEnd?: number) => {
      const node = editorRef.current;
      const caretStart = selStart ?? node?.selectionStart ?? next.length;
      const caretEnd = selEnd ?? node?.selectionEnd ?? next.length;
      history.commit(source, next, caretStart, caretEnd, origin);
      if (history.takeDroppedNotice()) notify(t('tip.undoLost'));
      sourceRevRef.current += 1;
      setSource(next);
      bumpHistory();
      if (origin !== 'key') {
        requestAnimationFrame(() => {
          if (node) {
            node.focus();
            node.selectionStart = caretStart;
            node.selectionEnd = caretEnd;
          }
        });
      }
    },
    [source, history, notify, t, bumpHistory],
  );

  const applyChangeToEditor = useCallback(
    (change: Change) => {
      const next = applyChange(source, change);
      sourceRevRef.current += 1;
      setSource(next);
      bumpHistory();
      requestAnimationFrame(() => {
        const node = editorRef.current;
        if (node) {
          node.focus();
          node.selectionStart = change.selStart;
          node.selectionEnd = change.selEnd;
        }
      });
    },
    [source, bumpHistory],
  );

  const runUndo = useCallback(() => {
    const change = history.undo(source);
    if (change) applyChangeToEditor(change);
  }, [history, source, applyChangeToEditor]);

  const runRedo = useCallback(() => {
    const change = history.redo(source);
    if (change) applyChangeToEditor(change);
  }, [history, source, applyChangeToEditor]);

  /** 图片错误码 → 界面文案（主进程与登记层都回机器码，文案只在界面层落地） */
  const imageErrorText = useCallback(
    (code?: string) => {
      if (code === 'too-large') return t('tip.imageTooLarge');
      if (code === 'unsupported') return t('tip.imageUnsupported');
      return t('tip.imageFail');
    },
    [t],
  );

  /**
   * 打开文档时读取同级资源夹（SRS 3.5.5.2：识别资源夹内图片供预览显示）。
   * 资源夹不存在或读取失败一律按「无本地图片」处理，相关图片由预览显示占位。
   */
  const loadAssets = useCallback(async (name: string, docPath: string | null) => {
    assetRefs.current = [];
    const host = desktopBridge();
    if (!host?.readAssets || !docPath) {
      setAssetUrls({});
      return;
    }
    const result = await host.readAssets(docPath, name);
    if (!result.ok || !result.data) {
      setAssetUrls({});
      return;
    }
    const folder = folderFor(name);
    const next: Record<string, string> = {};
    result.data.entries.forEach((entry) => { next[`${folder}/${entry.name}`] = entry.dataUrl; });
    setAssetUrls(next);
  }, []);

  const resetAll = useCallback(
    (anchorText: string, anchorName: string, anchorHandle: unknown | null) => {
      sourceRevRef.current += 1;
      setSource(anchorText);
      setBaseline(anchorText);
      setDocName(anchorName);
      setFileHandle(anchorHandle);
      setHits([]);
      setFindOpen(false);
      setImageAsk(null);
      // 换文档即丢弃上一份文档的图片登记与呈现表，随后按新文档重绑
      assetRefs.current = [];
      setAssetUrls({});
      history.reset(anchorText);
      bumpHistory();
    },
    [history, bumpHistory],
  );

  // ---------- 启动：偏好 / 草稿 / 最近文件 ----------
  useEffect(() => {
    const draft = DraftService.load();
    if (draft && draft.text) {
      setSource(draft.text);
      setBaseline(draft.baseline ?? '');
      if (draft.doc_name) setDocName(draft.doc_name);
      history.reset(draft.text);
      if (draft.text !== draft.baseline) notify(t('tip.restored'));
    } else {
      setSource(WELCOME_DOC);
      setBaseline(WELCOME_DOC);
      history.reset(WELCOME_DOC);
    }
    setRecent(RecentService.list());
    bumpHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 主题作用于根节点
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('md-theme-dark', prefs.theme === 'dark');
    root.classList.toggle('md-theme-light', prefs.theme !== 'dark');
  }, [prefs.theme]);

  // 渲染调度（SRS 3.5.2.2：300ms 防抖，超 1MB 放宽至 1000ms）
  useEffect(() => {
    if (prefs.view_mode === 'edit') return;
    const delay = source.length > LARGE_FILE_THRESHOLD ? 1000 : 300;
    const timer = window.setTimeout(() => {
      try {
        setHtml(parse(source));
        if (source.length > LARGE_FILE_THRESHOLD) notify(t('tip.bigFile'));
      } catch {
        notify(t('tip.renderFail'));
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [source, prefs.view_mode, notify, t]);

  /**
   * 采集预览行锚点，供滚动同步换算。
   * 用 rect 差值换算「相对内容起点」的纵坐标：与 scrollTop 同一坐标系，
   * 不依赖 offsetParent（.md-pane 未必是定位祖先，直接用 offsetTop 有错位风险）。
   *
   * 关键：锚点是「内容坐标」，宽度一变折行数就变、所有块纵坐标整体作废。
   * 只在内容重渲染时采一次是不够的 —— 开关目录 / 缩放窗口都会改两栏宽度却不改 html，
   * 拿旧表换算会越往下越偏（实测：打开目录后滚到文档中部，源码 49 行对预览 38.8 行，
   * 文档末尾偏差累积到 18.7 行）。因此每次布局变化后都要重采。
   */
  const collectBlocks = useCallback(() => {
    const container = previewRef.current;
    if (!container) return;
    const origin = container.getBoundingClientRect().top - container.scrollTop;
    const nodes = Array.from(container.querySelectorAll('[data-line]')) as HTMLElement[];
    blocksRef.current = nodes
      .map((node) => ({ line: Number(node.getAttribute('data-line')), top: node.getBoundingClientRect().top - origin }))
      .filter((item) => !Number.isNaN(item.line))
      .sort((a, b) => a.line - b.line);
  }, []);

  // 渲染完成后采集行锚点，供滚动同步换算
  // graphTick：mermaid 异步回填会改变块高度，回填后重采一次，保证滚动同步不错位（LLD §3.3）
  useEffect(() => {
    collectBlocks();
  }, [collectBlocks, html, prefs.view_mode, graphTick]);

  const handleContentShift = useCallback(() => setGraphTick((v) => v + 1), []);

  // 草稿自动留存（SRS 3.5.1.2：停止输入 500ms；含文档名）
  useEffect(() => {
    const timer = window.setTimeout(() => DraftService.save(source, baseline, docName), 500);
    return () => window.clearTimeout(timer);
  }, [source, baseline, docName]);

  // ---------- 未保存拦截（SRS 3.5.3.8） ----------
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const confirmIfDirty = useCallback(
    (message: string) => {
      if (!dirty) return true;
      return window.confirm(message);
    },
    [dirty],
  );

  // ---------- 保存（SRS 3.5.1.3；本地图片随文档落地写入资源夹，SRS 3.5.5.2） ----------
  const persist = useCallback(
    async (forceNew = false): Promise<boolean> => {
      if (savingRef.current) return false;
      savingRef.current = true;
      try {
        let handle = forceNew ? null : fileHandle;
        let name = docName;
        const base = name.replace(/\.(md|markdown|txt)$/i, '');
        const startDir = DirService.read('save');
        if (!handle) {
          const picked = await pickSavePath(ensureExt(base, '.md'), '', startDir);
          if (!picked.ok) {
            if (picked.error && picked.error !== '已取消') notify(t('tip.saveFail'));
            return false;
          }
          handle = picked.data ?? null;
          name = handleName(handle) ?? ensureExt(base, '.md');
        }
        name = ensureExt(name, '.md');

        // 资源夹引用识别素材：待写清单 + 已绑定的资源夹条目（改名时两者都要跟到新资源夹名）
        const pending = assetRefs.current;
        const relRefs = [
          ...pending.map((ref) => ({ name: ref.name, relPath: ref.relPath })),
          ...Object.keys(assetUrls).map((rel) => ({ name: rel.slice(rel.lastIndexOf('/') + 1), relPath: rel })),
        ];
        const retarget = relRefs.length > 0 ? retargetSource(source, relRefs, name) : { source, changed: false };
        let outgoing = retarget.source;

        const result = await writeFile(handle, name, outgoing, startDir);
        if (!result.ok) {
          notify(result.error === '写入失败' ? t('tip.saveFail') : t('tip.fileBusy'));
          return false;
        }
        const targetPath = handlePath(handle) ?? (result.data as { path?: string } | null)?.path ?? null;

        // 暂存的本地图片写入文档同级资源夹；失败不阻断文档保存（SRS 3.5.5.2）
        if (pending.length > 0) {
          const host = desktopBridge();
          const plan = planMaterialize(pending, name);
          let renamed: Array<{ from: string; to: string }> = [];
          let assetsFailed = false;
          if (host?.writeAssets && targetPath) {
            const written = await host.writeAssets({ docPath: targetPath, docName: name, files: plan.files });
            if (written.ok && written.data) {
              renamed = written.data.renamed;
              assetsFailed = written.data.failed.length > 0;
            } else {
              assetsFailed = true;
            }
          } else {
            assetsFailed = true;
          }
          if (assetsFailed) notify(t('tip.assetsFail'));

          // 同名避让改名后，源码引用与呈现表一并跟到实体名。
          // 键必须用「retarget 之后的引用」（源码此刻已统一成 folderFor(name)/原文件名）：
          // 文档若是插入图片后才命名 / 另存为，ref.relPath 还停在旧资源夹
          // （如「未命名文档_assets/…」），拿它当键会与源码失配，改名回写被静默跳过。
          const finalRel = new Map<string, string>();
          for (const ref of pending) {
            const hit = renamed.find((item) => item.from === ref.name);
            finalRel.set(`${plan.folder}/${ref.name}`, `${plan.folder}/${hit ? hit.to : ref.name}`);
          }
          for (const [from, to] of finalRel) {
            if (from !== to && outgoing.includes(from)) outgoing = outgoing.split(from).join(to);
          }
          if (outgoing !== retarget.source) await writeFile(handle, name, outgoing, startDir);

          // 呈现表按同一套映射搬家：既有条目若因文档改名换了资源夹，键跟着搬；
          // 命中 finalRel 的（本轮新登记的图）改用避让后的实体名，值同步搬过去。
          const nextUrls: Record<string, string> = {};
          for (const [rel, url] of Object.entries(assetUrls)) {
            const cut = rel.lastIndexOf('/');
            const base = cut >= 0 ? rel.slice(cut + 1) : rel;
            nextUrls[finalRel.get(`${plan.folder}/${base}`) ?? `${plan.folder}/${base}`] = url;
          }
          setAssetUrls(nextUrls);
          assetRefs.current = [];
        }

        // 源码若因资源夹改名而调整，整体入一次撤销记录，保证撤销栈与文本一致
        if (outgoing !== source) {
          history.commit(source, outgoing, outgoing.length, outgoing.length, 'format');
          bumpHistory();
        }
        setFileHandle(handle);
        setDocName(name);
        setBaseline(outgoing);
        setSource(outgoing);
        DraftService.save(outgoing, outgoing, name);
        setRecent(RecentService.touch({ name, path: targetPath || name }));
        DirService.remember('save', pathDir(targetPath));
        notify(t('tip.savedTo', { name }));
        return true;
      } finally {
        savingRef.current = false;
      }
    },
    [fileHandle, docName, source, assetUrls, history, bumpHistory, notify, t],
  );

  const handleSave = useCallback(() => persist(false), [persist]);
  const handleSaveAs = useCallback(() => persist(true), [persist]);

  // ---------- 载入（打开 / 最近，SRS 3.5.3.2 / 3.5.3.4） ----------
  const loadOpened = useCallback(
    (file: { name: string; text: string; handle: unknown | null; path?: string }) => {
      resetAll(file.text, file.name, file.handle);
      DraftService.save(file.text, file.text, file.name);
      const openedPath = file.path ?? handlePath(file.handle);
      // 同级资源夹内的本地图片随文档一起就位（SRS 3.5.5.2）
      void loadAssets(file.name, openedPath ?? null);
      setRecent(RecentService.touch({ name: file.name, path: openedPath || file.name }));
      DirService.remember('open', pathDir(openedPath));
      notify(t('tip.opened', { name: file.name }));
    },
    [notify, t, resetAll, loadAssets],
  );

  const openAbsolutePath = useCallback(
    async (targetPath: string) => {
      if (!targetPath) return;
      if (!confirmIfDirty(t('ask.open'))) return;
      const result = await openByPath(targetPath);
      if (!result.ok) {
        if (result.error && result.error.includes('不存在')) {
          if (window.confirm(t('tip.missingRecent'))) setRecent(RecentService.remove(targetPath));
        } else {
          notify(t('tip.readFail'));
        }
        return;
      }
      loadOpened(result.data as { name: string; text: string; handle: unknown | null; path?: string });
    },
    [confirmIfDirty, loadOpened, notify, t],
  );

  const handleOpen = useCallback(async () => {
    if (!confirmIfDirty(t('ask.open'))) return;
    const result = await openFile(DirService.read('open'));
    if (!result.ok) {
      if (result.error && result.error !== '已取消') {
        notify(result.error === '不支持的文件类型' ? t('tip.unsupportedLoad') : t('tip.readFail'));
      }
      return;
    }
    loadOpened(result.data as { name: string; text: string; handle: unknown | null; path?: string });
  }, [confirmIfDirty, loadOpened, notify, t]);

  const handleOpenRecent = useCallback(
    async (record: RecentRecord) => {
      if (isDesktopHost()) {
        await openAbsolutePath(record.path);
        return;
      }
      if (!confirmIfDirty(t('ask.open'))) return;
      notify(t('tip.browserRecent', { name: record.name }));
      await handleOpen();
    },
    [confirmIfDirty, handleOpen, notify, t, openAbsolutePath],
  );

  const handleRemoveRecent = useCallback((record: RecentRecord) => {
    setRecent(RecentService.remove(record.path));
  }, []);

  // ---------- 新建（SRS 3.5.3.1） ----------
  const handleNew = useCallback(() => {
    if (!confirmIfDirty(t('ask.new'))) return;
    resetAll('', DEFAULT_DOC_NAME, null);
    DraftService.clear();
    notify(t('tip.new'));
  }, [confirmIfDirty, notify, t, resetAll]);

  // ---------- 恢复默认欢迎页（SRS 3.5.3.9） ----------
  const handleRestoreWelcome = useCallback(() => {
    if (!confirmIfDirty(t('ask.welcome'))) return;
    resetAll(WELCOME_DOC, DEFAULT_DOC_NAME, null);
    DraftService.clear();
    setHelpOpen(false);
    notify(t('tip.cleared'));
  }, [confirmIfDirty, notify, t, resetAll]);

  // ---------- 本地数据清理（SRS 3.5.3.9） ----------
  const handleClearAll = useCallback(() => {
    if (!window.confirm(t('ask.clearAll'))) return;
    const scope: ClearScope = 'all';
    ClearService.run(scope);
    setPrefs(PrefService.get());
    setRecent([]);
    resetAll(WELCOME_DOC, DEFAULT_DOC_NAME, null);
    notify(t('tip.cleared'));
  }, [resetAll, t]);

  // ---------- 导入（SRS 3.5.3.6；.html 直转、.docx 经 mammoth 中间层） ----------
  const handleImport = useCallback(async () => {
    if (!confirmIfDirty(t('ask.import'))) return;
    const picked = await openImportFile();
    if (!picked.ok) {
      if (picked.error && picked.error !== '已取消') notify(t('tip.unsupportedImport'));
      return;
    }
    const source = picked.data as ImportedSource;
    const result = await importFile(source.name, source.buffer);
    if (result.markdown === '') {
      notify(result.warnings[0] === '该文件无可转换内容' ? t('tip.importEmpty') : t('tip.importFail'));
      return;
    }
    const name = `${source.name.replace(/\.(html?|docx)$/i, '')}.md`;
    resetAll(result.markdown, name, source.handle);
    DraftService.save(result.markdown, result.markdown, name);
    const openedPath = source.path ?? handlePath(source.handle);
    setRecent(RecentService.touch({ name, path: openedPath || name }));
    DirService.remember('open', pathDir(openedPath));
    notify(t('tip.imported', { name }));
  }, [confirmIfDirty, notify, t, resetAll]);

  // ---------- 导出（SRS 3.5.4：五种形态） ----------
  const handleExport = useCallback(
    async (kind: ExportKind) => {
      const name = docName.replace(/\.(md|markdown|txt|html|doc|pdf|png)$/i, '');
      const startDir = DirService.read('save');
      // 取材纪律：优先取预览区实际渲染结果（含已回填的图表 SVG 与公式结构），
      // 预览不可用（仅编辑态）时退回解析结果
      const collected = collectExportBody(previewRef.current, html || parse(source));
      // 导出烘焙（SRS 3.5.5.3）：本地图片以内部形式并入产出，不改源码引用写法
      const baked = bakeUrls(collected, assetUrls);
      const body = baked.html;
      /** 产出侧提示：体积明显增大与缺图都不阻断，只提醒（SRS 3.5.5.3 边界） */
      const noticeOutput = () => {
        if (body.length > BIG_EXPORT_THRESHOLD) notify(t('tip.exportBig'));
        if (baked.missing > 0) notify(t('tip.exportLarge'));
      };

      if (kind === 'md') {
        const target = ensureExt(name, '.md');
        const result = await exportMarkdown(source, target, null, startDir);
        notify(result.ok ? t('tip.exported', { name: target }) : t('tip.exportFail'));
        if (result.ok) {
          const savedPath = (result.data as { path?: string } | undefined)?.path ?? null;
          if (savedPath) DirService.remember('save', pathDir(savedPath));
        }
        return;
      }

      if (kind === 'html' || kind === 'word') {
        const target = kind === 'html' ? ensureExt(name, '.html') : ensureExt(name, '.doc');
        const result = kind === 'html'
          ? await exportHtml(body, target, null, startDir)
          : await exportWord(body, target, null, startDir);
        notify(result.ok ? t('tip.exported', { name: target }) : t('tip.exportFail'));
        if (result.ok) {
          const savedPath = (result.data as { path?: string } | undefined)?.path ?? null;
          if (savedPath) DirService.remember('save', pathDir(savedPath));
          noticeOutput();
        }
        return;
      }

      // PDF / PNG：宿主渲染能力形态（SRS 3.5.4.4 / 3.5.4.5）
      if (source.length > 200000 && !window.confirm(t('tip.exportSlow'))) return;
      const target = kind === 'pdf' ? ensureExt(name, '.pdf') : ensureExt(name, '.png');
      const result = kind === 'pdf'
        ? await exportPdf(body, target, startDir)
        : await exportImage(body, target, startDir);
      if (result.ok) {
        notify(t('tip.exported', { name: result.name ?? target }));
        if (result.stitched) notify(t('tip.exportStitched'));
        else if (result.clipped) notify(t('tip.exportClipped'));
        if (result.path) DirService.remember('save', pathDir(result.path));
        noticeOutput();
        return;
      }
      if (result.cancelled) return;
      notify(result.error === '当前宿主不支持该导出形态，请在桌面版使用' ? t('tip.hostUnsupported') : t('tip.exportFail'));
    },
    [docName, source, html, assetUrls, notify, t],
  );

  // ---------- 待办勾选回写源码（SRS 3.5.2.1） ----------
  const handleToggleTask = useCallback(
    (line: number) => {
      const lines = source.split('\n');
      const target = lines[line];
      if (target === undefined) return;
      const nextLine = /\[[ ]\]/.test(target) ? target.replace('[ ]', '[x]') : target.replace(/\[[xX]\]/, '[ ]');
      if (nextLine === target) return;
      lines[line] = nextLine;
      const pos = lines.slice(0, line).join('\n').length + (line === 0 ? 0 : 1);
      commit(lines.join('\n'), 'format', pos, pos);
    },
    [source, commit],
  );

  // ---------- 预览改写（SRS 3.5.2.4：呈现里改文字，回写源码区间） ----------
  const handlePreviewRewrite = useCallback(
    (submit: { target: RewriteTarget; text: string }): boolean => {
      const result = buildRewrite(source, { ...submit.target, text: submit.text });
      if (!result.ok) {
        notify(result.error === 'anchor-lost' ? t('tip.rewriteLost') : t('tip.rewriteUnsupported'));
        return false;
      }
      if (!result.change) return true; // 文字与原内容一致 → 源码不动，本次改写视为已达成
      commit(applyChange(source, result.change), 'rewrite', result.change.selStart, result.change.selEnd);
      return true;
    },
    [source, commit, notify, t],
  );

  const handleRewritingChange = useCallback((active: boolean) => {
    rewritingRef.current = active;
  }, []);

  const handleRewriteDropped = useCallback(() => notify(t('tip.rewriteLost')), [notify, t]);

  // ---------- 格式操作（SRS 3.5.1.7） ----------
  const selectionOf = () => {
    const node = editorRef.current;
    return node ? { start: node.selectionStart, end: node.selectionEnd } : { start: source.length, end: source.length };
  };

  const handleFormatCommand = useCallback(
    (command: FormatCommand) => {
      if (prefs.view_mode === 'preview') { notify(t('tip.editModeFirst')); return; }
      if (command === 'image') {
        const sel = selectionOf();
        setImageAsk({ sel, prefill: source.slice(sel.start, sel.end) });
        return;
      }
      if (command === 'link') {
        const sel = selectionOf();
        setLinkAsk({ sel, prefill: source.slice(sel.start, sel.end) });
        return;
      }
      const change = applyFormat(source, selectionOf(), command);
      if (change) commit(applyChange(source, change), 'format', change.selStart, change.selEnd);
    },
    [source, prefs.view_mode, commit, notify, t],
  );

  const submitLink = useCallback(
    (input: LinkInput) => {
      if (!linkAsk) return;
      const change = buildLink(source, linkAsk.sel, input);
      commit(applyChange(source, change), 'format', change.selStart, change.selEnd);
      setLinkAsk(null);
    },
    [linkAsk, source, commit],
  );

  /* ---------- 图片插入（SRS 3.5.5.1：网络地址 / 本地文件 / 粘贴板） ---------- */

  /** 校验 → 同名避让登记 → 呈现表 → 选区落相对路径引用（三个入口共用） */
  const acceptImage = useCallback(
    async (image: ImageInput | File, alt: string, sel: { start: number; end: number }): Promise<boolean> => {
      const taken = takenNames(assetRefs.current, assetUrls);
      const registered = image instanceof File
        ? await registerImage(image, docName, taken)
        : registerImageData(image, docName, taken);
      if (!registered.ok || !registered.ref) {
        notify(imageErrorText(registered.error));
        return false;
      }
      const ref = registered.ref;
      assetRefs.current = [...assetRefs.current, ref];
      setAssetUrls((current) => ({ ...current, [ref.relPath]: dataUrlOf(new Uint8Array(ref.data), ref.mime) }));
      const change = buildImageChange(source, sel, alt, ref.relPath);
      commit(applyChange(source, change), 'format', change.selStart, change.selEnd);
      notify(t('tip.imageInserted'));
      return true;
    },
    [docName, assetUrls, source, commit, notify, t, imageErrorText],
  );

  /** 网络地址：直接写引用，不经过资源夹 */
  const submitImageUrl = useCallback(
    (input: { alt: string; url: string }) => {
      if (!imageAsk) return;
      const change = buildImageChange(source, imageAsk.sel, input.alt, input.url);
      commit(applyChange(source, change), 'format', change.selStart, change.selEnd);
      setImageAsk(null);
      notify(t('tip.imageInserted'));
    },
    [imageAsk, source, commit, notify, t],
  );

  /** 本地文件：桌面宿主走原生选择器，浏览器宿主走文件选择器 */
  const pickLocalImage = useCallback(
    async (alt: string) => {
      const sel = imageAsk?.sel ?? selectionOf();
      setImageBusy(true);
      try {
        const host = desktopBridge();
        let used = false;
        if (host?.pickImage) {
          const picked = await host.pickImage(DirService.read('open'));
          if (!picked.ok || !picked.data) {
            if (!picked.cancelled) notify(imageErrorText(picked.error));
          } else {
            used = await acceptImage(picked.data, alt, sel);
          }
        } else {
          const file = await pickImageViaInput();
          if (file) used = await acceptImage(file, alt, sel);
        }
        if (used) setImageAsk(null);
      } finally {
        setImageBusy(false);
      }
    },
    [imageAsk, acceptImage, notify, imageErrorText],
  );

  /** 粘贴板图片：不弹窗，按本地文件规则就地插入 */
  const pasteImage = useCallback(
    (file: File) => { void acceptImage(file, '', selectionOf()); },
    [acceptImage],
  );

  // ---------- 查找与替换（SRS 3.5.1.6） ----------
  const runFind = useCallback(
    (needle: string, caseSensitive: boolean) => {
      setFindNeedle(needle);
      if (!needle || needle.length > NEEDLE_LIMIT || source.length === 0) {
        setHits([]);
        setHitIndex(0);
        return;
      }
      const found = findHits(source, needle, caseSensitive);
      setHits(found);
      setHitIndex(0);
      if (found.length === 0) notify(t('find.none'));
      else selectHit(found[0]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, notify, t],
  );

  const moveHit = useCallback(
    (delta: 1 | -1) => {
      if (hits.length === 0) return;
      const next = (hitIndex + delta + hits.length) % hits.length;
      setHitIndex(next);
      selectHit(hits[next]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hits, hitIndex, source],
  );

  const handleReplace = useCallback(
    (replacement: string, all: boolean) => {
      if (hits.length === 0) return;
      if (!all) {
        const hit = hits[hitIndex];
        const change = replaceOne(source, hit, replacement);
        commit(applyChange(source, change), 'replace', change.selStart, change.selEnd);
        return;
      }
      if (hits.length >= 200 && !window.confirm(t('ask.replaceAll', { n: hits.length }))) return;
      const merged = replaceAll(source, hits, replacement);
      if (!merged) return;
      commit(applyChange(source, merged.change), 'replace', merged.change.selStart, merged.change.selEnd);
      notify(t('find.replaced', { n: merged.count }));
    },
    [hits, hitIndex, source, commit, notify, t],
  );

  const openFind = useCallback(() => {
    const node = editorRef.current;
    const selected = node ? source.slice(node.selectionStart, node.selectionEnd) : '';
    // SRS 3.5.1.6 边界：源码为空时唤起查找，提示「暂无内容」
    if (source.length === 0) notify(t('find.empty'));
    setFindOpen(true);
    if (selected) {
      setFindNeedle(selected);
      window.setTimeout(() => runFind(selected, findCase), 0);
    }
  }, [source, runFind, findCase, notify, t]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setHits([]);
    setHitIndex(0);
  }, []);

  // ---------- 滚动同步（SRS 3.5.2.3：单向驱动 + 锁定防回声） ----------
  /** 程序化滚动：设值并登记，使随后由它派发的 scroll 事件不被当成用户操作 */
  const programmaticScroll = (box: HTMLElement, top: number) => {
    const max = Math.max(box.scrollHeight - box.clientHeight, 0);
    const next = Math.min(Math.max(top, 0), max);
    suppressRef.current = {
      box,
      value: next,
      until: (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 400,
    };
    box.scrollTop = next;
  };

  const syncByRatio = (from: 'editor' | 'preview', editor: HTMLTextAreaElement | null, preview: HTMLDivElement | null) => {
    if (!editor || !preview) return;
    const srcBox = from === 'editor' ? editor : preview;
    const targetBox = from === 'editor' ? preview : editor;
    const srcMax = srcBox.scrollHeight - srcBox.clientHeight;
    const targetMax = targetBox.scrollHeight - targetBox.clientHeight;
    if (srcMax <= 0 || targetMax <= 0) return;
    programmaticScroll(targetBox, (srcBox.scrollTop / srcMax) * targetMax);
  };

  /** 预览侧：源码行 → 该行所在锚点块的纵坐标（含块内插值，避免大块内预览纹丝不动） */
  const previewTopOfLine = (line: number): number | null => {
    const blocks = blocksRef.current;
    if (blocks.length === 0) return null;
    let index = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i].line <= line) index = i;
      else break;
    }
    const hit = blocks[index];
    const next = blocks[index + 1];
    // 首个锚点：源码在顶部时预览直接归零 —— 预览内容起点自带内边距，
    // 照搬「块顶对齐」会多滚一截，把标题顶出视野（实测多滚约 38px）
    if (index === 0) return 0;
    if (!next || next.line <= hit.line || next.top <= hit.top) return hit.top;
    const ratio = (line - hit.line) / (next.line - hit.line);
    return hit.top + (next.top - hit.top) * Math.min(Math.max(ratio, 0), 1);
  };

  /** 编辑器侧：预览纵坐标 → 源码行（可为小数，便于换回像素） */
  const lineAtPreviewTop = (top: number): number | null => {
    const blocks = blocksRef.current;
    if (blocks.length === 0) return null;
    let index = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i].top <= top + 12) index = i;
      else break;
    }
    const hit = blocks[index];
    const next = blocks[index + 1];
    if (!next || next.top <= hit.top || next.line <= hit.line) return hit.line;
    const ratio = (top + 12 - hit.top) / (next.top - hit.top);
    return hit.line + (next.line - hit.line) * Math.min(Math.max(ratio, 0), 1);
  };

  const syncTarget = useCallback(
    (from: 'editor' | 'preview', origin: HTMLElement | null) => {
      // 改写进行中挂起同步：块在编辑中重排，跟随会来回抖动（LLD §3.5）
      if (rewritingRef.current) return;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const suppressed = suppressRef.current;
      // 本次滚动是我们自己设的（同一盒子且位置未偏离）→ 不反向驱动，避免两侧互相抢占
      if (origin && suppressed.box === origin && now < suppressed.until && Math.abs(origin.scrollTop - suppressed.value) < 2) {
        return;
      }
      if (driverRef.current && driverRef.current !== from && now < lockUntilRef.current) return;
      driverRef.current = from;
      lockUntilRef.current = now + 150;

      const editor = editorRef.current;
      const preview = previewRef.current;
      if (!editor || !preview) return;

      // 行坐标表不可得（超大文档等）→ 退回比例换算
      const ys = lineOffsets();
      if (!ys) {
        syncByRatio(from, editor, preview);
        return;
      }

      if (from === 'editor') {
        const line = lineAtOffset(ys, editor.scrollTop);
        const top = previewTopOfLine(line);
        if (top === null) {
          syncByRatio(from, editor, preview);
          return;
        }
        programmaticScroll(preview, top - 12);
        return;
      }

      const line = lineAtPreviewTop(preview.scrollTop);
      if (line === null) {
        syncByRatio(from, editor, preview);
        return;
      }
      programmaticScroll(editor, offsetOfLine(ys, line));
    },
    // 依赖留空：换算只走 ref 与缓存表，不随每次输入重建回调
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /**
   * 布局变化后重新对齐：打开 / 关闭目录、切换视图、缩放窗口都会改变两栏宽度，
   * 宽度一变折行数就变，两侧内容高度随之改变 —— 而 scrollTop 是像素值不会跟着变，
   * 于是同一个 scrollTop 指向的内容整体漂移，看起来就是「滚着滚着两边对不上了」。
   * 尺寸变化后按「最后一次驱动方」重新对齐一次。
   */
  useEffect(() => {
    const editor = editorRef.current;
    const preview = previewRef.current;
    if (!editor || !preview || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        lockUntilRef.current = 0;
        suppressRef.current = { box: null, value: -1, until: 0 };
        // 宽度变了 → 预览块的内容坐标全部作废，先重采再对齐，否则用旧表换算会整体漂移
        collectBlocks();
        syncTarget(driverRef.current === 'preview' ? 'preview' : 'editor', null);
      });
    });
    observer.observe(editor);
    observer.observe(preview);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(raf);
    };
  }, [syncTarget, collectBlocks, prefs.view_mode, outlineOpen]);

  // ---------- 目录跳转（SRS 3.5.6.6） ----------
  const jumpOutline = useCallback(
    (node: OutlineNode) => {
      const view = previewRef.current;
      const editor = editorRef.current;
      const ys = lineOffsets();
      if (editor) {
        const lines = source.split('\n');
        const pos = lines.slice(0, node.line).join('\n').length + (node.line === 0 ? 0 : 1);
        editor.focus();
        editor.setSelectionRange(pos, pos);
        const y = ys ? offsetOfLine(ys, node.line) : node.line * measureLineHeight();
        programmaticScroll(editor, y - editor.clientHeight / 3);
      }
      const block = view?.querySelector<HTMLElement>(`[data-line="${node.line}"]`);
      if (block && view) {
        const origin = view.getBoundingClientRect().top - view.scrollTop;
        programmaticScroll(view, block.getBoundingClientRect().top - origin - 12);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source],
  );

  // ---------- 拖拽载入（SRS 3.5.3.3） ----------
  useEffect(() => {
    const onDragOver = (event: DragEvent) => { event.preventDefault(); setDragOver(true); };
    const onDragLeave = (event: DragEvent) => { event.preventDefault(); setDragOver(false); };
    const onDrop = async (event: DragEvent) => {
      event.preventDefault();
      setDragOver(false);
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) { notify(t('tip.dropFolder')); return; }
      if (files.length > 1) notify(t('tip.multiDrop'));
      if (!confirmIfDirty(t('ask.open'))) return;
      const result = await openDropped(files[0]);
      if (!result.ok) {
        notify(result.error === '不支持的文件类型' ? t('tip.unsupportedLoad') : t('tip.readFail'));
        return;
      }
      loadOpened(result.data as { name: string; text: string; handle: unknown | null; path?: string });
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [confirmIfDirty, loadOpened, notify, t]);

  // ---------- 全屏（SRS 3.5.6.2） ----------
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void document.documentElement.requestFullscreen().catch(() => undefined);
  }, []);

  // ---------- 快捷键（LLD §13.4 KeyBindings） ----------
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === 's') { event.preventDefault(); void (event.shiftKey ? handleSaveAs() : handleSave()); return; }
      if (mod && !event.shiftKey && key === 'z') { event.preventDefault(); runUndo(); return; }
      if (mod && (key === 'y' || (event.shiftKey && key === 'z'))) { event.preventDefault(); runRedo(); return; }
      if (mod && key === 'f') { event.preventDefault(); openFind(); return; }
      if (mod && key === 'h') { event.preventDefault(); openFind(); return; }
      if (key === 'escape') {
        if (findOpen) { closeFind(); return; }
        if (imageAsk) { setImageAsk(null); return; }
        if (linkAsk) { setLinkAsk(null); return; }
      }
      const inEditor = document.activeElement === editorRef.current;
      if (!inEditor || prefs.view_mode === 'preview') return;
      // Ctrl+Shift+K：插入图片（SRS 3.5.5.1 / 3.5.6.8）
      if (mod && event.shiftKey && key === 'k') { event.preventDefault(); handleFormatCommand('image'); return; }
      if (mod && !event.shiftKey) {
        const map: Array<[string, FormatCommand]> = [['b', 'bold'], ['i', 'italic'], ['u', 'underline']];
        const found = map.find(([combo]) => combo === key);
        if (found) { event.preventDefault(); handleFormatCommand(found[1]); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, handleSaveAs, runUndo, runRedo, openFind, closeFind, findOpen, linkAsk, imageAsk, handleFormatCommand, prefs.view_mode]);

  // ---------- 桌面宿主集成：原生菜单 / 外部打开 / 脏标记 / 窗口标题 ----------
  useEffect(() => {
    const host = desktopBridge();
    if (!host) return undefined;

    const offMenu = host.onMenuCommand((payload) => {
      const cmd = (payload as { cmd?: string }).cmd;
      switch (cmd) {
        case 'new': handleNew(); break;
        case 'open': void handleOpen(); break;
        case 'openPath': void openAbsolutePath(String((payload as { path?: string }).path ?? '')); break;
        case 'save':
          void handleSave().then((ok) => {
            if ((payload as { forQuit?: boolean }).forQuit) void (ok ? host.quitReady() : host.quitCancel());
          });
          break;
        case 'saveAs': void handleSaveAs(); break;
        case 'import': void handleImport(); break;
        case 'export': {
          const format = String((payload as { format?: string }).format ?? 'md');
          const kind: ExportKind = format === 'html' ? 'html' : format === 'png' ? 'png' : format === 'word' ? 'word' : format === 'pdf' ? 'pdf' : 'md';
          void handleExport(kind);
          break;
        }
        case 'reveal': {
          const target = handlePath(fileHandle);
          if (target) void host.reveal(target);
          break;
        }
        case 'viewMode': updatePrefs({ view_mode: (payload as { mode?: ViewMode }).mode }); break;
        case 'undo': runUndo(); break;
        case 'redo': runRedo(); break;
        case 'find': openFind(); break;
        case 'outline': setOutlineOpen((v) => !v); break;
        case 'shortcuts': setShortcutsOpen(true); break;
        case 'fullscreen': toggleFullscreen(); break;
        case 'theme': updatePrefs({ theme: prefs.theme === 'light' ? 'dark' : 'light' }); break;
        case 'sidebar': updatePrefs({ sidebar_collapsed: !prefs.sidebar_collapsed }); break;
        case 'lang': updatePrefs({ lang: (payload as { code?: LangCode }).code }); break;
        case 'help': setHelpOpen(true); break;
        default: break;
      }
    });

    const offOpen = host.onOpenFiles((paths) => {
      const first = Array.isArray(paths) ? paths[0] : '';
      if (first) void openAbsolutePath(first);
    });

    return () => { offMenu(); offOpen(); };
  }, [
    fileHandle, handleExport, handleImport, handleNew, handleOpen, handleSave, handleSaveAs,
    openAbsolutePath, prefs.sidebar_collapsed, prefs.theme, runRedo, runUndo, openFind,
    toggleFullscreen, updatePrefs,
  ]);

  useEffect(() => { desktopBridge()?.setDirty(dirty); }, [dirty]);

  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${docName} — MarkDesk`;
  }, [docName, dirty]);

  // ---------- 分栏拖拽（SRS 3.5.6.3：20%–80%） ----------
  const startDrag = useCallback(() => {
    const container = splitRef.current;
    if (!container) return;
    const onMove = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const ratio = ((event.clientX - rect.left) / rect.width) * 100;
      setPrefs((current) => ({ ...current, split_ratio: Math.min(80, Math.max(20, Math.round(ratio))) }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setPrefs((current) => PrefService.patch({ split_ratio: current.split_ratio }));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const editable = prefs.view_mode !== 'preview';
  const showEditor = prefs.view_mode !== 'preview';
  const showPreview = prefs.view_mode !== 'edit';
  const editorWidth = prefs.view_mode === 'both' ? `${prefs.split_ratio}%` : '100%';

  return (
    <div className={`md-app${prefs.theme === 'dark' ? ' md-dark' : ''}`}>
      <TopBar
        docName={docName}
        dirty={dirty}
        retention="on"
        retentionLabel=""
        t={t}
        onDocNameChange={(next) => {
          if (/[\\/:*?"<>|]/.test(next)) { notify(t('tip.badName')); return; }
          setDocName(ensureExt(next, '.md'));
        }}
        onToggleSidebar={() => updatePrefs({ sidebar_collapsed: !prefs.sidebar_collapsed })}
        onSave={() => void handleSave()}
        onSaveAs={() => void handleSaveAs()}
        onImport={() => void handleImport()}
        onExport={(kind) => void handleExport(kind)}
      />

      <div className="md-body">
        {prefs.sidebar_collapsed ? null : (
          <Sidebar
            recent={recent}
            viewMode={prefs.view_mode}
            theme={prefs.theme}
            lang={lang}
            activeFile={docName}
            outlineOpen={outlineOpen}
            t={t}
            onOpen={() => void handleOpen()}
            onNew={handleNew}
            onToggleOutline={() => setOutlineOpen((v) => !v)}
            onOpenRecent={(record) => void handleOpenRecent(record)}
            onRemoveRecent={handleRemoveRecent}
            onViewMode={(mode) => updatePrefs({ view_mode: mode })}
            onOpenHelp={() => setHelpOpen(true)}
            onToggleTheme={() => updatePrefs({ theme: prefs.theme === 'light' ? 'dark' : 'light' })}
            onPickLang={(code) => updatePrefs({ lang: code })}
          />
        )}

        {outlineOpen ? (
          <OutlinePanel nodes={outline} activeLine={-1} t={t} onJump={jumpOutline} onClose={() => setOutlineOpen(false)} />
        ) : null}

        <main className="md-work">
          <FormatToolbar
            t={t}
            canUndo={history.canUndo() || historyTick < 0}
            canRedo={history.canRedo() || historyTick < 0}
            disabled={!editable}
            onUndo={runUndo}
            onRedo={runRedo}
            onCommand={handleFormatCommand}
            onFind={openFind}
            onShortcuts={() => setShortcutsOpen(true)}
            onSyntax={() => setHelpOpen(true)}
          />

          <div className="md-split" ref={splitRef}>
            {showEditor ? (
              <div className="md-pane md-editor" style={{ width: editorWidth }}>
                {findOpen ? (
                  <SearchPanel
                    t={t}
                    initial={findNeedle}
                    hitCount={hits.length}
                    current={hitIndex}
                    caseSensitive={findCase}
                    onClose={closeFind}
                    onSearch={(needle, cs) => { setFindCase(cs); runFind(needle, cs); }}
                    onMove={moveHit}
                    onReplace={handleReplace}
                    onToggleCase={() => { setFindCase((v) => { runFind(findNeedle, !v); return !v; }); }}
                  />
                ) : null}
                <EditorPane
                  ref={editorRef}
                  value={source}
                  assistEnabled={prefs.assist_enabled}
                  onChange={(next) => commit(next, 'key')}
                  onAssist={(next, selStart, selEnd) => commit(next, 'assist', selStart, selEnd)}
                  onPasteImage={pasteImage}
                  onScroll={(event) => syncTarget('editor', event.currentTarget)}
                />
              </div>
            ) : null}

            {showEditor && showPreview ? (
              <div className="md-splitter" onMouseDown={startDrag} title={t('view.both')} />
            ) : null}

            {showPreview ? (
              <div className="md-pane-wrap" style={{ width: showEditor ? `${100 - prefs.split_ratio}%` : '100%' }}>
                <PreviewPane
                  ref={previewRef}
                  html={html}
                  empty={source.trim() === ''}
                  emptyText={t('preview.empty')}
                  theme={prefs.theme}
                  t={t}
                  assetUrls={assetUrls}
                  onToggleTask={handleToggleTask}
                  onScroll={(event) => syncTarget('preview', event.currentTarget)}
                  onContentShift={handleContentShift}
                  onRewrite={handlePreviewRewrite}
                  onRewritingChange={handleRewritingChange}
                  onRewriteDropped={handleRewriteDropped}
                  revisionRef={sourceRevRef}
                />
              </div>
            ) : null}
          </div>

          {dragOver ? <div className="md-drop-mask">{t('tip.dropFile')}</div> : null}
        </main>
      </div>

      {helpOpen ? (
        <HelpPanel
          lang={lang}
          t={t}
          onRestoreWelcome={handleRestoreWelcome}
          onClearAll={handleClearAll}
          onClose={() => setHelpOpen(false)}
        />
      ) : null}
      {shortcutsOpen ? <ShortcutModal t={t} onClose={() => setShortcutsOpen(false)} /> : null}
      {linkAsk ? (
        <LinkPrompt
          initialText={linkAsk.prefill}
          t={t}
          onSubmit={submitLink}
          onCancel={() => setLinkAsk(null)}
        />
      ) : null}
      {imageAsk ? (
        <ImagePrompt
          initialText={imageAsk.prefill}
          busy={imageBusy}
          t={t}
          onSubmitUrl={submitImageUrl}
          onPickLocal={(alt) => void pickLocalImage(alt)}
          onCancel={() => setImageAsk(null)}
        />
      ) : null}
      {toast ? <div className="md-toast">{toast}</div> : null}
    </div>
  );
}
