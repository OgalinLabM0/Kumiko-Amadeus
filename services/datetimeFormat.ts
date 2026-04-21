// services/datetimeFormat.ts
//
// Phase 7 Part t14_datetime_format: unified, viewport-aware datetime
// helpers. MemoryPanel, TaskPanel, MessageCenterPanel, MobileAccess, the
// app-update bar, and MobileRemoteFileBrowser used to each hand-roll
// `new Date(ts).toLocaleString()` / `.toLocaleDateString` calls. On a
// narrow phone viewport those strings wrapped onto a second line and
// broke layouts; on desktop wide-screens the truncated variant looked
// cramped.
//
// This module centralizes the rule:
//
//   - Desktop (Electron OR viewport ≥ 1024px): FULL precision. Behaviour
//     unchanged vs the pre-Phase-7 baseline — callers that used to show
//     "2026/03/31 14:08:12" still do.
//   - Mobile (viewport < 1024px): compact precision, optionally dropping
//     the year when the timestamp is inside the current year and the
//     caller opts into `variant: 'chat'`.
//
// We expose three helpers:
//
//   - `formatCompactTime(ts, { lang, variant })` — human-facing, the
//     default for every call site listed above.
//   - `formatRelativeTime(ts, { lang })` — "5 分钟前" / "5 min ago",
//     used by MessageCenterPanel.
//   - `isWideViewport()` — predicate for callers that want to branch on
//     column count (e.g. TaskPanel's grid-cols-3 vs grid-cols-1).
//
// The helpers are synchronous and don't subscribe to resize events;
// React components should re-render via their normal state flow when
// the window resizes. We checked the relevant panels — they all either
// rebuild on viewport / flow changes or live inside a component that
// re-renders on open/close.

import { isElectron } from './environment';

export type CompactTimeVariant = 'chat' | 'full' | 'dateOnly' | 'timeOnly';
export type CompactLang = 'zh' | 'en';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

// Desktop Electron always runs this predicate to `true` (we never want
// to cramp desktop chrome). Mobile PWA + web-fallback browsers defer to
// the raw viewport width.
export function isWideViewport(): boolean {
  if (isElectron()) return true;
  if (typeof window === 'undefined') return true;
  const width = window.innerWidth;
  return width >= 1024;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function sameYear(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear();
}

function sameDay(a: Date, b: Date): boolean {
  return sameYear(a, b) && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isYesterday(a: Date, b: Date): boolean {
  const y = new Date(b);
  y.setDate(y.getDate() - 1);
  return sameDay(a, y);
}

export interface CompactTimeOptions {
  lang?: CompactLang;
  variant?: CompactTimeVariant;
  // Force compact even on wide viewports. Useful for cells inside grids
  // that are narrow even on desktop (e.g. TaskPanel card footer).
  forceCompact?: boolean;
}

export function formatCompactTime(
  input: number | Date | null | undefined,
  options: CompactTimeOptions = {},
): string {
  if (input === null || input === undefined) return '';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';

  const lang = options.lang ?? 'zh';
  const variant = options.variant ?? 'full';
  const compact = options.forceCompact || !isWideViewport();
  const now = new Date();

  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());

  if (variant === 'timeOnly') {
    return `${hh}:${mm}`;
  }

  if (variant === 'dateOnly') {
    if (compact && sameYear(date, now)) {
      return lang === 'zh' ? `${m}月${d}日` : `${m}/${d}`;
    }
    if (compact) {
      return lang === 'zh' ? `${y}/${m}/${d}` : `${y}/${m}/${d}`;
    }
    return lang === 'zh' ? `${y}年${m}月${d}日` : `${y}/${pad2(m)}/${pad2(d)}`;
  }

  // `full` and `chat` share the same core. `chat` drops seconds and,
  // on compact viewports, drops the year for same-year stamps so the
  // string fits in a single line inside a 64-char chat bubble footer.
  if (!compact) {
    if (variant === 'chat') {
      return lang === 'zh'
        ? `${y}/${pad2(m)}/${pad2(d)} ${hh}:${mm}`
        : `${y}/${pad2(m)}/${pad2(d)} ${hh}:${mm}`;
    }
    return lang === 'zh'
      ? `${y}/${pad2(m)}/${pad2(d)} ${hh}:${mm}:${ss}`
      : `${y}/${pad2(m)}/${pad2(d)} ${hh}:${mm}:${ss}`;
  }

  if (sameDay(date, now)) {
    return `${hh}:${mm}`;
  }
  if (isYesterday(date, now)) {
    return lang === 'zh' ? `昨天 ${hh}:${mm}` : `Yday ${hh}:${mm}`;
  }
  if (sameYear(date, now)) {
    return lang === 'zh' ? `${m}/${d} ${hh}:${mm}` : `${m}/${d} ${hh}:${mm}`;
  }
  return lang === 'zh' ? `${y}/${m}/${d}` : `${y}/${m}/${d}`;
}

export function formatRelativeTime(
  input: number | Date | null | undefined,
  options: { lang?: CompactLang } = {},
): string {
  if (input === null || input === undefined) return '';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  const lang = options.lang ?? 'zh';
  const now = Date.now();
  const delta = now - date.getTime();

  if (delta < 0) {
    return formatCompactTime(date, { lang, variant: 'chat' });
  }
  if (delta < MS_PER_MINUTE) {
    return lang === 'zh' ? '刚刚' : 'just now';
  }
  if (delta < MS_PER_HOUR) {
    const n = Math.floor(delta / MS_PER_MINUTE);
    return lang === 'zh' ? `${n} 分钟前` : `${n} min ago`;
  }
  if (delta < MS_PER_DAY) {
    const n = Math.floor(delta / MS_PER_HOUR);
    return lang === 'zh' ? `${n} 小时前` : `${n} hr ago`;
  }
  if (delta < MS_PER_DAY * 7) {
    const n = Math.floor(delta / MS_PER_DAY);
    return lang === 'zh' ? `${n} 天前` : `${n} d ago`;
  }
  return formatCompactTime(date, { lang, variant: 'dateOnly' });
}
