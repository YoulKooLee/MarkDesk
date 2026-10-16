/**
 * 查找与替换：区间匹配、命中集合与替换变更生成
 * 追溯：LLD V2.0 §2.4 ｜ SRS V2.0 F-1.6（3.5.1.6）
 */
import type { Change } from './undoStack';

export interface Hit {
  start: number;
  end: number;
  index: number;
}

export const NEEDLE_LIMIT = 500;

/**
 * 单遍滑动匹配（不使用正则，避免回溯风险与元字符歧义）；命中互不重叠，按 start 升序。
 */
export function findHits(text: string, needle: string, caseSensitive: boolean): Hit[] {
  if (!needle || !text) return [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  const hits: Hit[] = [];
  let cursor = haystack.indexOf(target);
  while (cursor >= 0) {
    hits.push({ start: cursor, end: cursor + target.length, index: hits.length });
    cursor = haystack.indexOf(target, cursor + target.length);
    if (hits.length >= 10000) break;
  }
  return hits;
}

/** 替换单处：产出一条 Change，调用方据 hits 顺序推进 current */
export function replaceOne(text: string, hit: Hit, replacement: string): Change {
  return {
    start: hit.start,
    before: text.slice(hit.start, hit.end),
    after: replacement,
    selStart: hit.start + replacement.length,
    selEnd: hit.start + replacement.length,
    origin: 'replace',
  };
}

/**
 * 全部替换：倒序替换保证前序位置不失效，合并为一条 Change（SRS：整体可撤销）。
 * 返回 change 与替换处数；无命中时返回 null。
 */
export function replaceAll(text: string, hits: Hit[], replacement: string): { change: Change; count: number } | null {
  if (hits.length === 0) return null;
  let next = text;
  const first = hits[0];
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const hit = hits[i];
    next = next.slice(0, hit.start) + replacement + next.slice(hit.end);
  }
  const lastHit = hits[hits.length - 1];
  const tailOffset = hits.length * (replacement.length - (lastHit.end - lastHit.start));
  return {
    count: hits.length,
    change: {
      start: first.start,
      before: text.slice(first.start, lastHit.end),
      after: next.slice(first.start, lastHit.end + tailOffset),
      selStart: Math.min(first.start + replacement.length, next.length),
      selEnd: Math.min(first.start + replacement.length, next.length),
      origin: 'replace',
    },
  };
}
