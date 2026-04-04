import React from 'react';
import { EmotionType, Language } from '../../types';
import { KumikoAvatar } from '../KumikoAvatar';
import { VoiceVisualizer } from '../VoiceVisualizer';

interface AppAvatarPanelProps {
  isDarkMode: boolean;
  isTalking: boolean;
  language: Language;
  currentEmotion: EmotionType;
  turnCount: number;
  summaryProgressText: string;
  statusText: string;
  avatarPanelBg: string;
  overlayClass: string;
  avatarGradient: string;
  statusTextColor: string;
  systemName: string;
  systemId: string;
  emotionLabel: string;
  turnsLabel: string;
  nextSyncLabel: string;
  voiceSyncLabel: string;
}

export const AppAvatarPanel: React.FC<AppAvatarPanelProps> = ({
  isDarkMode,
  isTalking,
  language,
  currentEmotion,
  turnCount,
  summaryProgressText,
  statusText,
  avatarPanelBg,
  overlayClass,
  avatarGradient,
  statusTextColor,
  systemName,
  systemId,
  emotionLabel,
  turnsLabel,
  nextSyncLabel,
  voiceSyncLabel
}) => {
  return (
    <div className={`absolute inset-0 z-0 md:relative md:w-1/2 lg:w-3/5 h-full flex items-center justify-center overflow-hidden transition-colors duration-500 ${avatarPanelBg}`}>
      <div className={overlayClass}></div>
      <div className={`absolute inset-0 ${avatarGradient}`}></div>

      <div className={`absolute top-20 left-4 md:top-10 md:left-10 md:max-w-[calc(100%-160px)] font-mono text-[10px] md:text-[10px] lg:text-xs z-0 md:z-30 p-2 md:p-0 rounded-lg md:rounded-none transition-all duration-500 pointer-events-none select-none ${statusTextColor}`}>
        <p className="font-bold opacity-80 truncate">{systemName}</p>
        <p className="opacity-60 truncate">{systemId}</p>
        <div className="h-px w-8 bg-current my-1 opacity-30"></div>
        <p className="truncate">{emotionLabel}: <span className="font-bold">{currentEmotion.toUpperCase()}</span></p>
        <p className="truncate">{turnsLabel}: {turnCount} ({nextSyncLabel}: {summaryProgressText})</p>
        <p className="mt-1 pt-1 border-t border-current border-opacity-30 font-bold md:hidden truncate">{statusText}</p>
      </div>

      <div className="hidden md:block absolute top-10 right-10 z-30 pointer-events-none">
        <VoiceVisualizer isTalking={isTalking} isDarkMode={isDarkMode} label={voiceSyncLabel} />
      </div>

      <KumikoAvatar isTalking={isTalking} emotion={currentEmotion} isDarkMode={isDarkMode} />
    </div>
  );
};
