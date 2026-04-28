// components/app/BlockBanner.tsx
//
// v2.14.29 Reactive — top-strip banner shown while
// `blockRuntime.activeUntilMs > now`. Shows "拉黑中 · 剩 MM:SS" and
// can expand to show the original reason + start time. NOT manually
// dismissable — the only way out is the regulator's expiry path.
//
// Wording is intentionally neutral / status-line ("拉黑中" / "Blocked")
// rather than third-person narration ("她在生气") per user feedback.

import React, { useEffect, useState } from 'react';
import { useAppStore } from '../../store';
import type { Language } from '../../types';

const formatRemaining = (untilMs: number, now: number): string => {
  const totalSeconds = Math.max(0, Math.floor((untilMs - now) / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const formatStartedAt = (startedAtMs: number, language: Language): string => {
  const d = new Date(startedAtMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return language === 'en' ? `started ${hh}:${mm}` : `起始 ${hh}:${mm}`;
};

interface BlockBannerProps {
  isDarkMode: boolean;
  language: Language;
}

export const BlockBanner: React.FC<BlockBannerProps> = ({ isDarkMode, language }) => {
  const blockRuntime = useAppStore(s => s.blockRuntime);
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);

  // 1Hz tick — only when banner is visible.
  useEffect(() => {
    if (!blockRuntime) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [blockRuntime?.startedAt]);

  if (!blockRuntime) return null;

  const expired = blockRuntime.activeUntilMs <= now;
  // Recovery transition phase. Once the regulator's proactive lands it
  // will null out blockRuntime; until then we want to show
  // "即将解除…" so the user understands the timer is gone but
  // resolution is in flight.
  if (expired) {
    return (
      <div
        role="status"
        className={`flex items-center justify-between px-4 py-2 text-sm border-b transition-opacity duration-300 ${
          isDarkMode ? 'bg-slate-800/80 border-slate-700 text-slate-200' : 'bg-slate-200 border-slate-300 text-slate-700'
        }`}
      >
        <span className="font-mono opacity-90">
          {language === 'en' ? 'Lifting…' : '即将解除…'}
        </span>
      </div>
    );
  }

  const remaining = formatRemaining(blockRuntime.activeUntilMs, now);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`border-b transition-colors ${
        isDarkMode ? 'bg-slate-800/80 border-slate-700 text-slate-100' : 'bg-slate-100 border-slate-300 text-slate-800'
      }`}
    >
      <div className="flex items-center justify-between px-4 h-9">
        <div className="flex items-center gap-2 text-sm">
          {/* ⊘ block / forbidden glyph — kept ASCII so it renders even
              if a glyph fallback is missing on the user's system font. */}
          <span aria-hidden className="font-mono">⊘</span>
          <span className="font-mono">
            {language === 'en' ? `Blocked · ${remaining} left` : `拉黑中 · 剩 ${remaining}`}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(prev => !prev)}
          className={`text-xs font-mono px-2 py-0.5 rounded transition-colors ${
            isDarkMode ? 'hover:bg-slate-700/70 text-slate-300' : 'hover:bg-slate-200 text-slate-600'
          }`}
        >
          {expanded
            ? (language === 'en' ? 'Hide reason ▴' : '收起 ▴')
            : (language === 'en' ? 'Show reason ▾' : '查看原因 ▾')}
        </button>
      </div>
      {expanded && (
        <div
          className={`px-4 pb-2 text-xs font-mono ${
            isDarkMode ? 'text-slate-300' : 'text-slate-600'
          }`}
        >
          {(blockRuntime.reason || (language === 'en' ? '(no reason given)' : '（未提供原因）'))}
          <span className="opacity-60"> · {formatStartedAt(blockRuntime.startedAt, language)}</span>
        </div>
      )}
    </div>
  );
};
