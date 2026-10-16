/**
 * 本地持久化：偏好 / 草稿 / 最近文件 / 记住目录 / 数据清理
 * 追溯：LLD V2.0 §十、§十二 ｜ SRS V2.0 F-3.7、F-3.9、F-6.3 ~ F-6.5
 */
import type { LangCode } from './lang';

const PREFIX = 'markdesk:';

export type ViewMode = 'both' | 'edit' | 'preview';
export type ThemeMode = 'light' | 'dark';

export interface Prefs {
  view_mode: ViewMode;
  theme: ThemeMode;
  lang: LangCode;
  split_ratio: number;
  sidebar_collapsed: boolean;
  assist_enabled: boolean;
}

export interface DraftRecord {
  text: string;
  baseline: string;
  saved_at: number;
  doc_name?: string;
}

export interface RecentRecord {
  name: string;
  path: string;
  visited_at: number;
}

export interface DirMemory {
  open?: string;
  save?: string;
}

export const DEFAULT_PREFS: Prefs = {
  view_mode: 'both',
  theme: 'light',
  lang: 'zh-CN',
  split_ratio: 50,
  sidebar_collapsed: false,
  assist_enabled: true,
};

export const RECENT_LIMIT = 10;

function readKey<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeKey(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    /* 静默：本地不可用不影响编辑 */
  }
}

export const PrefService = {
  get(): Prefs {
    const raw = window.localStorage.getItem(PREFIX + 'prefs');
    if (!raw) return { ...DEFAULT_PREFS };
    try {
      return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  },
  patch(partial: Partial<Prefs>): Prefs {
    const next = { ...this.get(), ...partial };
    writeKey('prefs', next);
    return next;
  },
};

export const DraftService = {
  load(): DraftRecord | null {
    return readKey<DraftRecord | null>('draft', null);
  },
  save(text: string, baseline: string, docName?: string): boolean {
    return writeKey('draft', { text, baseline, saved_at: Date.now(), doc_name: docName } as DraftRecord);
  },
  clear(): void {
    removeKey('draft');
  },
};

export const RecentService = {
  list(): RecentRecord[] {
    return readKey<RecentRecord[]>('recent', []);
  },
  touch(record: { name: string; path: string }): RecentRecord[] {
    const current = this.list().filter((item) => item.path !== record.path);
    const next = [{ ...record, visited_at: Date.now() }, ...current].slice(0, RECENT_LIMIT);
    writeKey('recent', next);
    return next;
  },
  remove(path: string): RecentRecord[] {
    const next = this.list().filter((item) => item.path !== path);
    writeKey('recent', next);
    return next;
  },
};

/** 记住目录：上次打开 / 上次写入两条（SRS 3.5.3.7） */
export const DirService = {
  read(kind: keyof DirMemory): string | null {
    const value = readKey<DirMemory>('dirs', {})[kind];
    return value || null;
  },
  remember(kind: keyof DirMemory, dir: string | undefined | null): void {
    if (!dir) return;
    writeKey('dirs', { ...readKey<DirMemory>('dirs', {}), [kind]: dir });
  },
  clear(): void {
    removeKey('dirs');
  },
};

/** 本地数据清理（SRS 3.5.3.9）：只清本机留存，不触碰磁盘文档与资源夹 */
export type ClearScope = 'content' | 'settings' | 'files' | 'all';

export const ClearService = {
  /** 返回需要清除的键名，供宿主侧同步清理（桌面端 prefs 文件等） */
  run(scope: ClearScope): ClearScope[] {
    if (scope === 'content' || scope === 'all') removeKey('draft');
    if (scope === 'settings' || scope === 'all') {
      removeKey('prefs');
    }
    if (scope === 'files' || scope === 'all') {
      removeKey('recent');
      removeKey('dirs');
    }
    return [scope];
  },
};
