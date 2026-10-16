/**
 * 撤销与重做栈：源码结构性改动的统一回退通道
 * 追溯：LLD V2.0 §2.2 ｜ SRS V2.0 F-1.5（3.5.1.5）
 */
/** 变更来源：决定入栈是否合并、是否重置栈基线 */
export type Origin = 'key' | 'assist' | 'format' | 'rewrite' | 'replace' | 'external';

/** 单次源码变更的最小记录（区间替换式，正向/反向共用一套结构） */
export interface Change {
  start: number;
  before: string;
  after: string;
  selStart: number;
  selEnd: number;
  origin: Origin;
}

const MERGE_WINDOW_MS = 600;
const STACK_LIMIT = 200;

export function applyChange(text: string, change: Change): string {
  return text.slice(0, change.start) + change.after + text.slice(change.start + change.before.length);
}

export function invert(change: Change): Change {
  return { ...change, before: change.after, after: change.before, origin: change.origin };
}

/**
 * 求两段文本的最小差异区间。
 * 合并语义依赖它：以「批次基线 → 当前文本」整体重算 diff，
 * 因此连续输入只留一条记录，一次回退撤销一整段（SRS 3.5.1.5 业务规则）。
 */
export function diffChange(prev: string, next: string, selStart: number, selEnd: number, origin: Origin): Change | null {
  if (prev === next) return null;
  let head = 0;
  const minLen = Math.min(prev.length, next.length);
  while (head < minLen && prev[head] === next[head]) head += 1;
  let tail = 0;
  while (tail < minLen - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
  return {
    start: head,
    before: prev.slice(head, prev.length - tail),
    after: next.slice(head, next.length - tail),
    selStart,
    selEnd,
    origin,
  };
}

/**
 * 栈语义：
 * - commit() 由调用方在每次源码变更后调用；origin='key' 且与上一次相隔 <600ms 时并入同一条记录；
 * - 非 key 来源（格式操作、替换、改写）各自独立成一条，保证「一次操作整体回退」；
 * - 新改动清空重做侧；
 * - 回退终点为 reset 锚点，不可越过（canUndo 在栈空时为 false）；
 * - 条数超上限时丢弃最早记录并回报一次 degraded。
 */
export class UndoStack {
  private undoList: Change[] = [];

  private redoList: Change[] = [];

  private batchBase = '';

  private batchActive = false;

  private lastAt = 0;

  private dropped = false;

  /** 载入新文档 / 新建 / 恢复基线内容时调用：栈两侧清空 */
  reset(text: string): void {
    this.undoList = [];
    this.redoList = [];
    this.batchBase = text;
    this.batchActive = false;
    this.lastAt = 0;
    this.dropped = false;
  }

  /**
   * 记录一次源码变更。
   * @param prev 变更前的完整文本
   * @param next 变更后的完整文本
   */
  commit(prev: string, next: string, selStart: number, selEnd: number, origin: Origin): void {
    if (prev === next) return;
    const now = Date.now();
    const mergeable = origin === 'key' && this.batchActive && this.undoList.length > 0 && now - this.lastAt < MERGE_WINDOW_MS;

    if (mergeable) {
      // 以批次基线整体重算，替换栈顶：连续输入合并为一条
      const merged = diffChange(this.batchBase, next, selStart, selEnd, 'key');
      if (merged) {
        this.undoList[this.undoList.length - 1] = merged;
        this.redoList = [];
        this.lastAt = now;
        return;
      }
    }

    const change = diffChange(prev, next, selStart, selEnd, origin) ?? {
      start: 0,
      before: prev,
      after: next,
      selStart,
      selEnd,
      origin,
    };
    this.undoList.push(change);
    if (this.undoList.length > STACK_LIMIT) {
      this.undoList.shift();
      this.dropped = true;
    }
    // 批次基线固定为本批次「变更前」全文：合并时以它整体重算，一次回退撤销一整段
    this.batchBase = prev;
    this.batchActive = origin === 'key';
    this.lastAt = now;
    this.redoList = [];
  }

  canUndo(): boolean {
    return this.undoList.length > 0;
  }

  canRedo(): boolean {
    return this.redoList.length > 0;
  }

  /** 取出一次回退：返回应应用到当前文本的 Change */
  undo(currentText: string): Change | null {
    const change = this.undoList.pop();
    if (!change) return null;
    this.redoList.push(change);
    const result = applyChange(currentText, change);
    this.breakBatch(result);
    return invert(change);
  }

  redo(currentText: string): Change | null {
    const change = this.redoList.pop();
    if (!change) return null;
    this.undoList.push(change);
    const result = applyChange(currentText, change);
    this.breakBatch(result);
    return change;
  }

  /** 回退/恢复后打断合并，避免下一次输入并进刚回退的记录 */
  private breakBatch(text: string): void {
    this.batchBase = text;
    this.batchActive = false;
    this.lastAt = 0;
  }

  /** 取出「较早的修改不再可撤销」通知，取一次即清除 */
  takeDroppedNotice(): boolean {
    if (!this.dropped) return false;
    this.dropped = false;
    return true;
  }
}
