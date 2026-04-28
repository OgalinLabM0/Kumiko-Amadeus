// components/app/AffectionBars.tsx
//
// v2.14.29 Reactive — visual indicator for the two new axes:
//   - Mood (-100..+100): centred bar with a circular indicator that
//     drifts left (cold) or right (playful). Friend-coded vocabulary
//     in the band labels per plan section "Anti-girlfriend guardrail".
//   - Affection (0..100): standard left-to-right fill bar with a
//     band label.
//
// Both bars are read-only — we deliberately don't show
// delta history or per-turn numbers (the plan calls this "no game
// system surface"; users can't reverse-engineer how to grind affection).
//
// Used inside ProfilePanel after the PsycheBar block.

import React from 'react';
import type { Language } from '../../types';
import { getAffectionBand, getAffectionBandLabelLocalized } from '../../services/affectionService';
import { getMoodBand, getMoodBandLabelLocalized } from '../../services/moodService';

interface AffectionBarsProps {
  mood: number | undefined;
  affection: number | undefined;
  isDarkMode: boolean;
  language: Language;
}

// Mood is signed; map -100..+100 onto 0..100% horizontal position so
// the indicator can land at the correct side.
const moodToPct = (m: number): number => {
  const clamped = Math.max(-100, Math.min(100, m));
  return ((clamped + 100) / 200) * 100;
};

export const AffectionBars: React.FC<AffectionBarsProps> = ({ mood, affection, isDarkMode, language }) => {
  const moodVal = typeof mood === 'number' ? Math.round(mood) : 0;
  const affectionVal = typeof affection === 'number' ? Math.round(affection) : 50;
  const moodBand = getMoodBand(moodVal);
  const affectionBand = getAffectionBand(affectionVal);
  const moodLabel = getMoodBandLabelLocalized(moodBand, language);
  const affectionLabel = getAffectionBandLabelLocalized(affectionBand, language);
  const moodPct = moodToPct(moodVal);

  // Color logic: mood at the cold end skews red, neutral skews grey,
  // playful skews warm yellow. Affection low → blue-grey, high → warm
  // orange. None of these intentionally lean cuddly-pink.
  const moodIndicatorColor = moodBand === 'fuming'
    ? (isDarkMode ? 'bg-red-500/80' : 'bg-red-500')
    : moodBand === 'cold'
      ? (isDarkMode ? 'bg-blue-400/70' : 'bg-blue-500')
      : moodBand === 'playful'
        ? (isDarkMode ? 'bg-amber-400/80' : 'bg-amber-500')
        : moodBand === 'bright'
          ? (isDarkMode ? 'bg-yellow-400/70' : 'bg-yellow-500')
          : (isDarkMode ? 'bg-gray-400/70' : 'bg-gray-500');
  const affectionFillColor = affectionBand === 'distrusting'
    ? (isDarkMode ? 'bg-slate-500/70' : 'bg-slate-500')
    : affectionBand === 'cool'
      ? (isDarkMode ? 'bg-blue-400/60' : 'bg-blue-400')
      : affectionBand === 'fond'
        ? (isDarkMode ? 'bg-amber-400/70' : 'bg-amber-400')
        : affectionBand === 'unguarded'
          ? (isDarkMode ? 'bg-orange-400/80' : 'bg-orange-400')
          : (isDarkMode ? 'bg-yellow-500/60' : 'bg-yellow-500');

  return (
    <div className="space-y-3">
      {/* Mood bar — signed, centred 0 line */}
      <div className="flex items-center gap-3">
        <span className={`ka-micro font-bold uppercase text-right flex-shrink-0 min-w-[3.25rem] whitespace-nowrap ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          {language === 'zh' ? '心情' : 'Mood'}
        </span>
        <div className={`relative flex-1 h-2 rounded-full min-w-0 ${isDarkMode ? 'bg-gray-800' : 'bg-gray-200/80'}`}>
          {/* 0 centre line */}
          <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-px h-3 ${isDarkMode ? 'bg-gray-600' : 'bg-gray-400'}`} />
          {/* moving indicator */}
          <div
            className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full transition-all duration-500 ${moodIndicatorColor}`}
            style={{ left: `${moodPct}%` }}
          />
        </div>
        <span className={`ka-micro font-mono w-12 text-right flex-shrink-0 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          {moodVal > 0 ? `+${moodVal}` : moodVal}
        </span>
      </div>
      <div className={`ka-micro flex justify-between ${isDarkMode ? 'text-gray-500' : 'text-gray-400'} pl-[3.65rem]`}>
        <span>-100</span>
        <span>{moodLabel}</span>
        <span>+100</span>
      </div>

      {/* Affection bar — 0..100 fill */}
      <div className="flex items-center gap-3 pt-1">
        <span className={`ka-micro font-bold uppercase text-right flex-shrink-0 min-w-[3.25rem] whitespace-nowrap ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          {language === 'zh' ? '好感度' : 'Affection'}
        </span>
        <div className={`flex-1 h-2 rounded-full min-w-0 ${isDarkMode ? 'bg-gray-800' : 'bg-gray-200/80'}`}>
          <div
            className={`h-full rounded-full transition-all duration-500 ${affectionFillColor}`}
            style={{ width: `${Math.max(0, Math.min(100, affectionVal))}%` }}
          />
        </div>
        <span className={`ka-micro font-mono w-12 text-right flex-shrink-0 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          {affectionVal} / 100
        </span>
      </div>
      <div className={`ka-micro flex justify-between ${isDarkMode ? 'text-gray-500' : 'text-gray-400'} pl-[3.65rem]`}>
        <span>0</span>
        <span>{affectionLabel}</span>
        <span>100</span>
      </div>
    </div>
  );
};
