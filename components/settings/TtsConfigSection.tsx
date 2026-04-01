import React, { useState, useRef, useCallback, useEffect } from 'react';
import { ChevronDown, ChevronUp, Upload, Play, Square, Trash2, TestTube, Loader2, Volume2, ExternalLink, RotateCcw, Power, PowerOff, Cpu, Cloud } from 'lucide-react';
import type { TtsConfig, VoiceMode, Language, TtsBackend } from '../../types';
import { UI_TRANSLATIONS, DEFAULT_TTS_CONFIG } from '../../constants';
import { synthesizeSpeech } from '../../services/fishAudioService';
import { checkGenieHealth, loadGenieCharacter } from '../../services/genieAudioService';
import {
  saveRingtoneFile,
  loadRingtoneFileWithName,
  deleteRingtoneFile,
  isVoiceServiceAvailable,
  isBuiltInRingtoneId,
  isCustomRingtoneId,
  getBuiltInRingtoneUrl,
  getAudioMimeTypeForFileName,
} from '../../services/voiceFileService';

const BUILT_IN_RINGTONES = [
  { id: '01.mp3', displayNum: '01', nameZh: '115万km的胶片 - 黄前久美子', nameEn: '115-man Kilo no Film - Kumiko Oumae' },
  { id: '02.mp3', displayNum: '02', nameZh: '小小恋歌 - 秀久合唱', nameEn: 'Chiisana Koi no Uta - Shuichi & Kumiko' },
  { id: '03.mp3', displayNum: '03', nameZh: '天空的碎片 - 黄前久美子', nameEn: 'Sora no Kakera - Kumiko Oumae' },
  { id: '04.mp3', displayNum: '04', nameZh: 'ヘミソフィア - 黄前久美子', nameEn: 'Hemisphere - Kumiko Oumae' },
  { id: '05.mp3', displayNum: '05', nameZh: 'アンインストール - 黄前久美子', nameEn: 'Uninstall - Kumiko Oumae' },
  { id: '06.mp3', displayNum: '06', nameZh: 'DREAM SOLISTER - 黄前久美子', nameEn: 'DREAM SOLISTER - Kumiko Oumae' },
  { id: '07.mp3', displayNum: '07', nameZh: 'サウンドスケープ - 黄前久美子', nameEn: 'Soundscape - Kumiko Oumae' },
  { id: '08.mp3', displayNum: '08', nameZh: 'ReCoda - 黄前久美子', nameEn: 'ReCoda - Kumiko Oumae' },
];

interface TtsConfigSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: Language;
  sectionBorder: string;
  inputClass: string;
  labelClass: string;
  innerCardClass: string;
  ttsConfig: TtsConfig;
  onTtsConfigChange: (config: TtsConfig) => void;
}

export const TtsConfigSection: React.FC<TtsConfigSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  language,
  sectionBorder,
  inputClass,
  labelClass,
  innerCardClass,
  ttsConfig,
  onTtsConfigChange,
}) => {
  const CUSTOM_RINGTONE_PREVIEW_ID = '__custom__';
  const t = UI_TRANSLATIONS[language];
  const [isTesting, setIsTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'playing' | 'error'>('idle');
  const [hasRingtone, setHasRingtone] = useState(false);
  const [customRingtoneId, setCustomRingtoneId] = useState<string | null>(null);
  const [ringtoneFileName, setRingtoneFileName] = useState<string | null>(null);
  const [isRingtonePlaying, setIsRingtonePlaying] = useState(false);
  const [previewingRingtoneId, setPreviewingRingtoneId] = useState<string | null>(null);
  const [ringtoneDurations, setRingtoneDurations] = useState<Record<string, string>>({});
  const [ringtoneCurrentTime, setRingtoneCurrentTime] = useState<string>('');
  const ringtoneInputRef = useRef<HTMLInputElement>(null);
  const ringtoneAudioRef = useRef<HTMLAudioElement | null>(null);
  const ringtoneUrlRef = useRef<string | null>(null);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);
  const testAudioUrlRef = useRef<string | null>(null);

  const [genieStatus, setGenieStatus] = useState<'off' | 'starting' | 'ready' | 'error'>('off');
  const [genieError, setGenieError] = useState<string | null>(null);
  const [geniePid, setGeniePid] = useState<number | null>(null);

  const update = useCallback((patch: Partial<TtsConfig>) => {
    onTtsConfigChange({ ...ttsConfig, ...patch });
  }, [ttsConfig, onTtsConfigChange]);

  const getReadableCustomRingtoneName = useCallback((rawName?: string | null) => {
    if (!rawName || isCustomRingtoneId(rawName)) {
      return language === 'zh' ? '自定义铃声' : 'Custom ringtone';
    }
    return rawName;
  }, [language]);

  const stopRingtonePlayback = useCallback(() => {
    if (ringtoneAudioRef.current) {
      ringtoneAudioRef.current.pause();
      ringtoneAudioRef.current.currentTime = 0;
      ringtoneAudioRef.current.onended = null;
      ringtoneAudioRef.current.onerror = null;
      ringtoneAudioRef.current.ontimeupdate = null;
      ringtoneAudioRef.current.onloadedmetadata = null;
      ringtoneAudioRef.current.src = '';
      ringtoneAudioRef.current = null;
    }
    if (ringtoneUrlRef.current?.startsWith('blob:')) {
      URL.revokeObjectURL(ringtoneUrlRef.current);
    }
    ringtoneUrlRef.current = null;
    setIsRingtonePlaying(false);
    setPreviewingRingtoneId(null);
    setRingtoneCurrentTime('');
  }, []);

  const stopTestVoicePlayback = useCallback(() => {
    if (testAudioRef.current) {
      testAudioRef.current.pause();
      testAudioRef.current.currentTime = 0;
      testAudioRef.current.onended = null;
      testAudioRef.current.onerror = null;
      testAudioRef.current.src = '';
      testAudioRef.current = null;
    }
    if (testAudioUrlRef.current) {
      URL.revokeObjectURL(testAudioUrlRef.current);
      testAudioUrlRef.current = null;
    }
    setTestStatus('idle');
    setIsTesting(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const syncRingtoneState = async () => {
      const ipc = (window as any)?.electronAPI;
      if (!ipc) {
        const fallbackCustomId = isCustomRingtoneId(ttsConfig.ringtoneFileId)
          ? ttsConfig.ringtoneFileId || null
          : null;
        if (!cancelled) {
          setHasRingtone(!!fallbackCustomId);
          setCustomRingtoneId(fallbackCustomId);
          setRingtoneFileName(fallbackCustomId ? getReadableCustomRingtoneName(fallbackCustomId) : null);
        }
        return;
      }

      try {
        const result = await ipc.invoke('ringtone:get-info');
        if (cancelled) return;
        const exists = result?.exists === true;
        setHasRingtone(exists);
        setCustomRingtoneId(exists ? (result?.fileName || null) : null);
        setRingtoneFileName(exists ? getReadableCustomRingtoneName(result?.displayName || result?.fileName || null) : null);
      } catch {
        if (!cancelled) {
          setHasRingtone(false);
          setCustomRingtoneId(null);
          setRingtoneFileName(null);
        }
      }
    };

    if (isOpen) {
      syncRingtoneState();
    }

    return () => {
      cancelled = true;
    };
  }, [getReadableCustomRingtoneName, isOpen, ttsConfig.ringtoneFileId]);

  useEffect(() => {
    if (!isOpen || !hasRingtone || ringtoneDurations[CUSTOM_RINGTONE_PREVIEW_ID]) return;

    let cancelled = false;
    let cleanupUrl: string | null = null;
    const preloadCustomDuration = async () => {
      const loaded = await loadRingtoneFileWithName();
      if (!loaded || cancelled) return;
      const blob = new Blob([loaded.buffer], { type: getAudioMimeTypeForFileName(loaded.fileName) });
      cleanupUrl = URL.createObjectURL(blob);
      const audio = new Audio(cleanupUrl);
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        if (cancelled) return;
        const duration = audio.duration;
        const mins = Math.floor(duration / 60);
        const secs = Math.floor(duration % 60);
        setRingtoneDurations(prev => prev[CUSTOM_RINGTONE_PREVIEW_ID]
          ? prev
          : { ...prev, [CUSTOM_RINGTONE_PREVIEW_ID]: `${mins}:${secs.toString().padStart(2, '0')}` });
      };
      audio.onerror = () => {
        if (cleanupUrl?.startsWith('blob:')) URL.revokeObjectURL(cleanupUrl);
        cleanupUrl = null;
      };
      audio.load();
    };

    preloadCustomDuration();

    return () => {
      cancelled = true;
      if (cleanupUrl?.startsWith('blob:')) URL.revokeObjectURL(cleanupUrl);
    };
  }, [CUSTOM_RINGTONE_PREVIEW_ID, hasRingtone, isOpen, ringtoneDurations, ringtoneFileName]);

  useEffect(() => {
    if (isOpen) return;
    stopRingtonePlayback();
    stopTestVoicePlayback();
  }, [isOpen, stopRingtonePlayback, stopTestVoicePlayback]);

  useEffect(() => {
    return () => {
      stopRingtonePlayback();
      stopTestVoicePlayback();
    };
  }, [stopRingtonePlayback, stopTestVoicePlayback]);

  useEffect(() => {
    if (!isOpen) return;
    const missingRingtoneIds = BUILT_IN_RINGTONES
      .map(ringtone => ringtone.id)
      .filter(ringtoneId => !ringtoneDurations[ringtoneId]);
    if (missingRingtoneIds.length === 0) return;

    let cancelled = false;
    const cleanups: HTMLAudioElement[] = [];

    missingRingtoneIds.forEach(ringtoneId => {
      const url = getBuiltInRingtoneUrl(ringtoneId);
      if (!url) return;
      const audio = new Audio(url);
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        if (cancelled) return;
        const duration = audio.duration;
        const mins = Math.floor(duration / 60);
        const secs = Math.floor(duration % 60);
        setRingtoneDurations(prev => prev[ringtoneId]
          ? prev
          : { ...prev, [ringtoneId]: `${mins}:${secs.toString().padStart(2, '0')}` });
      };
      cleanups.push(audio);
      audio.load();
    });

    return () => {
      cancelled = true;
      cleanups.forEach(audio => {
        audio.onloadedmetadata = null;
        audio.onerror = null;
      });
    };
  }, [isOpen, ringtoneDurations]);

  useEffect(() => {
    if (!isOpen) return;
    const ipc = (window as any)?.electronAPI;
    if (!ipc) return;
    ipc.invoke('genie:status').then((s: any) => {
      if (s?.running) { setGenieStatus('ready'); setGeniePid(s.pid); }
    }).catch(() => {});
    const handler = (_: any, data: any) => {
      if (!data?.running) { setGenieStatus('off'); setGeniePid(null); }
    };
    ipc.on('genie:status-changed', handler);
    return () => { ipc.removeListener('genie:status-changed', handler); };
  }, [isOpen]);

  const handleGenieStart = useCallback(async () => {
    const ipc = (window as any)?.electronAPI;
    if (!ipc) return;
    setGenieStatus('starting');
    setGenieError(null);
    try {
      const result = await ipc.invoke('genie:start', {
        pythonPath: ttsConfig.geniePythonPath || 'python',
        port: ttsConfig.genieServerPort || 8000,
      });
      if (result?.success) {
        setGeniePid(result.pid || null);
        const baseUrl = `http://127.0.0.1:${ttsConfig.genieServerPort || 8000}`;
        if (ttsConfig.genieModelDir) {
          const loadResult = await loadGenieCharacter(baseUrl, {
            characterName: ttsConfig.genieCharacterName || 'kumiko',
            modelDir: ttsConfig.genieModelDir,
            language: ttsConfig.genieLanguage || 'jp',
          });
          if (!loadResult.success) {
            setGenieStatus('error');
            setGenieError(loadResult.error || 'Model load failed');
            return;
          }
        }
        setGenieStatus('ready');
      } else {
        setGenieStatus('error');
        setGenieError(result?.error || 'Unknown error');
      }
    } catch (e: any) {
      setGenieStatus('error');
      setGenieError(e.message);
    }
  }, [ttsConfig]);

  const handleGenieStop = useCallback(async () => {
    const ipc = (window as any)?.electronAPI;
    if (!ipc) return;
    await ipc.invoke('genie:stop');
    setGenieStatus('off');
    setGeniePid(null);
    setGenieError(null);
  }, []);

  const selectedBuiltInRingtone = BUILT_IN_RINGTONES.find(ringtone => ringtone.id === ttsConfig.ringtoneFileId);
  const isCustomRingtoneSelected = !!customRingtoneId && ttsConfig.ringtoneFileId === customRingtoneId;
  const genericCustomRingtoneLabel = language === 'zh' ? '自定义铃声' : 'Custom ringtone';
  const selectedRingtoneLabel = selectedBuiltInRingtone
    ? `${selectedBuiltInRingtone.displayNum} · ${language === 'zh' ? selectedBuiltInRingtone.nameZh : selectedBuiltInRingtone.nameEn}`
    : (isCustomRingtoneSelected && ringtoneFileName
      ? (ringtoneFileName === genericCustomRingtoneLabel
        ? ringtoneFileName
        : (language === 'zh' ? `自定义铃声 · ${ringtoneFileName}` : `Custom ringtone · ${ringtoneFileName}`))
      : null);

  const openExternalUrl = useCallback(async (url: string) => {
    const ipc = (window as any)?.electronAPI;
    if (ipc) {
      await ipc.invoke('app:open-external', { url });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const handleVoiceModeChange = useCallback((mode: VoiceMode) => {
    update({ voiceMode: mode });
  }, [update]);

  const handleTestVoice = useCallback(async () => {
    if (isTesting) return;
    if (!ttsConfig.fishAudioApiKey) { setTestStatus('error'); return; }
    setIsTesting(true);
    setTestStatus('idle');
    try {
      const testText = '全国大会を目指す日々は、決して楽な道のりではありません。しかし、仲間と共に努力する喜びが、私たちを強くしてくれました。';
      const result = await synthesizeSpeech(testText, ttsConfig);
      const blob = new Blob([result.audio], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      stopTestVoicePlayback();
      testAudioUrlRef.current = url;
      const audio = new Audio(url);
      testAudioRef.current = audio;
      audio.onended = () => { stopTestVoicePlayback(); };
      audio.onerror = () => {
        stopTestVoicePlayback();
        setTestStatus('error');
      };
      await audio.play();
      setTestStatus('playing');
    } catch {
      setTestStatus('error');
      setIsTesting(false);
    }
  }, [isTesting, stopTestVoicePlayback, ttsConfig]);

  const handleRingtoneUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() || 'mp3';
    const buf = await file.arrayBuffer();
    const ok = await saveRingtoneFile(buf, ext, file.name);
    if (ok) {
      const customId = `custom.${ext}`;
      stopRingtonePlayback();
      update({ ringtoneFileId: customId });
      setHasRingtone(true);
      setCustomRingtoneId(customId);
      setRingtoneFileName(file.name);
      setRingtoneDurations(prev => {
        const next = { ...prev };
        delete next[CUSTOM_RINGTONE_PREVIEW_ID];
        return next;
      });
      window.dispatchEvent(new CustomEvent('kumiko:ringtone-storage-changed'));
    }
    if (ringtoneInputRef.current) ringtoneInputRef.current.value = '';
  }, [CUSTOM_RINGTONE_PREVIEW_ID, stopRingtonePlayback, update]);

  const handleRingtoneDelete = useCallback(async () => {
    stopRingtonePlayback();
    await deleteRingtoneFile();
    update({ ringtoneFileId: DEFAULT_TTS_CONFIG.ringtoneFileId });
    setHasRingtone(false);
    setCustomRingtoneId(null);
    setRingtoneFileName(null);
    setRingtoneDurations(prev => {
      const next = { ...prev };
      delete next[CUSTOM_RINGTONE_PREVIEW_ID];
      return next;
    });
    window.dispatchEvent(new CustomEvent('kumiko:ringtone-storage-changed'));
  }, [CUSTOM_RINGTONE_PREVIEW_ID, stopRingtonePlayback, update]);

  const handleResetReferenceId = useCallback(() => {
    update({ fishAudioReferenceId: DEFAULT_TTS_CONFIG.fishAudioReferenceId });
  }, [update]);

  const handleRingtonePreview = useCallback(async () => {
    const isCustomPreviewing = previewingRingtoneId === CUSTOM_RINGTONE_PREVIEW_ID && isRingtonePlaying;
    if (isCustomPreviewing && ringtoneAudioRef.current) {
      stopRingtonePlayback();
      return;
    }
    stopRingtonePlayback();
    const loaded = await loadRingtoneFileWithName();
    if (!loaded) return;
    const blob = new Blob([loaded.buffer], { type: getAudioMimeTypeForFileName(loaded.fileName) });
    const url = URL.createObjectURL(blob);
    ringtoneUrlRef.current = url;
    const audio = new Audio(url);
    ringtoneAudioRef.current = audio;
    audio.onloadedmetadata = () => {
      const duration = audio.duration || 0;
      const mins = Math.floor(duration / 60);
      const secs = Math.floor(duration % 60);
      setRingtoneDurations(prev => ({ ...prev, [CUSTOM_RINGTONE_PREVIEW_ID]: `${mins}:${secs.toString().padStart(2, '0')}` }));
    };
    audio.ontimeupdate = () => {
      const current = audio.currentTime;
      const duration = audio.duration || 0;
      const currentMins = Math.floor(current / 60);
      const currentSecs = Math.floor(current % 60);
      const durationMins = Math.floor(duration / 60);
      const durationSecs = Math.floor(duration % 60);
      setRingtoneCurrentTime(`${currentMins}:${currentSecs.toString().padStart(2, '0')} / ${durationMins}:${durationSecs.toString().padStart(2, '0')}`);
    };
    audio.onended = () => { stopRingtonePlayback(); };
    audio.onerror = () => { stopRingtonePlayback(); };
    setIsRingtonePlaying(true);
    setPreviewingRingtoneId(CUSTOM_RINGTONE_PREVIEW_ID);
    audio.play().catch(() => { stopRingtonePlayback(); });
  }, [CUSTOM_RINGTONE_PREVIEW_ID, getAudioMimeTypeForFileName, isRingtonePlaying, previewingRingtoneId, stopRingtonePlayback]);

  const handleBuiltInRingtonePreview = useCallback(async (ringtoneId: string) => {
    if (previewingRingtoneId === ringtoneId && isRingtonePlaying) {
      stopRingtonePlayback();
      return;
    }
    stopRingtonePlayback();
    const url = getBuiltInRingtoneUrl(ringtoneId);
    if (!url) {
      return;
    }
    const audio = new Audio(url);
    ringtoneAudioRef.current = audio;
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      const mins = Math.floor(duration / 60);
      const secs = Math.floor(duration % 60);
      setRingtoneDurations(prev => ({ ...prev, [ringtoneId]: `${mins}:${secs.toString().padStart(2, '0')}` }));
    };
    audio.ontimeupdate = () => {
      const current = audio.currentTime;
      const duration = audio.duration || 0;
      const currentMins = Math.floor(current / 60);
      const currentSecs = Math.floor(current % 60);
      const durationMins = Math.floor(duration / 60);
      const durationSecs = Math.floor(duration % 60);
      setRingtoneCurrentTime(`${currentMins}:${currentSecs.toString().padStart(2, '0')} / ${durationMins}:${durationSecs.toString().padStart(2, '0')}`);
    };
    audio.onended = () => { stopRingtonePlayback(); };
    audio.onerror = () => { stopRingtonePlayback(); };
    setPreviewingRingtoneId(ringtoneId);
    setIsRingtonePlaying(true);
    audio.play().catch(() => { stopRingtonePlayback(); });
  }, [previewingRingtoneId, isRingtonePlaying, stopRingtonePlayback]);

  const modeOptions: { value: VoiceMode; label: string; desc: string }[] = [
    { value: 'text', label: t.ttsModeText, desc: (t as any).ttsModeTextDesc || '' },
    { value: 'full', label: t.ttsModeFull, desc: (t as any).ttsModeFullDesc || '' },
    { value: 'hybrid', label: t.ttsModeHybrid, desc: t.ttsModeHybridDesc },
  ];

  const desktopAvailable = isVoiceServiceAvailable();
  const sectionTitleClass = isDarkMode ? 'ka-section-title text-[#f5ebdc]' : 'ka-section-title text-[#49301f]';
  const sectionDescClass = isDarkMode ? 'ka-section-desc text-[#b69f87]' : 'ka-section-desc text-[#8f7458]';
  const helperClass = isDarkMode ? 'ka-copy-sm text-[#b69f87]' : 'ka-copy-sm text-[#8f7458]';
  const actionChipClass = isDarkMode ? 'bg-[#211912] hover:bg-[#2a2018] text-[#dccab6] border border-[#4f3b2a]' : 'bg-white hover:bg-[#faf5ee] text-[#6f5438] border border-[#e6ddcf]';
  const fieldLabelClass = isDarkMode ? 'ka-setting-item-title text-[#f1e6d7]' : 'ka-setting-item-title text-[#54402d]';
  const externalLinkClass = isDarkMode
    ? 'text-[#d8ba81] hover:text-[#f3d59a] hover:bg-white/5'
    : 'text-[#a06b22] hover:text-[#84551a] hover:bg-[#fff8ea]';
  const resetButtonClass = isDarkMode
    ? 'border-[#5a4635] text-[#d8c2a8] hover:bg-white/5'
    : 'border-[#e2d6c7] text-[#8b6b45] hover:bg-[#faf5ee]';

  return (
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border ${isDarkMode ? 'border-amber-500/20 bg-amber-900/20 text-amber-300' : 'border-amber-200 bg-amber-50/90 text-amber-700'}`}>
            <Volume2 size={18} />
          </div>
          <div className="text-left">
            <h3 className={sectionTitleClass}>{t.ttsSection}</h3>
            {!isOpen && <p className={sectionDescClass}>{t.ttsSectionDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      {isOpen && (
        <div className="px-4 pb-4 flex flex-col gap-4">
          <p className={sectionDescClass}>{t.ttsSectionDesc}</p>

          {!desktopAvailable && (
            <div className="ka-micro text-amber-500 bg-amber-500/10 rounded px-2 py-1.5">
              TTS requires the desktop (Electron) version.
            </div>
          )}

          <div>
            <div className={fieldLabelClass}>{t.ttsVoiceMode}</div>
            <div className="grid grid-cols-1 gap-2 mt-2 sm:grid-cols-3">
              {modeOptions.map(opt => (
                <button key={opt.value}
                  onClick={() => handleVoiceModeChange(opt.value)}
                  className={`px-3 py-2 rounded-xl ka-copy-sm font-semibold transition-colors ${
                    ttsConfig.voiceMode === opt.value
                      ? (isDarkMode ? 'bg-[#d4a852] text-[#21150a] shadow-[0_10px_20px_rgba(212,168,82,0.18)]' : 'bg-[#fff5e3] text-[#8a6122] border border-[#e0c58f] shadow-[0_8px_18px_rgba(138,97,34,0.10)]')
                      : actionChipClass
                  }`}>
                  {opt.label}
                </button>
              ))}
            </div>
            {(() => {
              const active = modeOptions.find(o => o.value === ttsConfig.voiceMode);
              return active?.desc ? (
                <div className={`${helperClass} mt-1.5 leading-relaxed`}>
                  {active.desc}
                </div>
              ) : null;
            })()}
          </div>

          <div>
            <div className={fieldLabelClass}>{language === 'zh' ? 'TTS 引擎' : 'TTS Engine'}</div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              {([
                { value: 'fish' as TtsBackend, label: 'Fish Audio', desc: language === 'zh' ? '云端 · 需 API Key' : 'Cloud · API Key required', icon: Cloud },
                { value: 'genie' as TtsBackend, label: 'Genie-TTS', desc: language === 'zh' ? '本地 · GPT-SoVITS' : 'Local · GPT-SoVITS', icon: Cpu },
              ]).map(opt => (
                <button key={opt.value}
                  onClick={() => update({ ttsBackend: opt.value })}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl ka-copy-sm font-semibold transition-colors text-left ${
                    (ttsConfig.ttsBackend || 'fish') === opt.value
                      ? (isDarkMode ? 'bg-[#d4a852] text-[#21150a] shadow-[0_10px_20px_rgba(212,168,82,0.18)]' : 'bg-[#fff5e3] text-[#8a6122] border border-[#e0c58f] shadow-[0_8px_18px_rgba(138,97,34,0.10)]')
                      : actionChipClass
                  }`}>
                  <opt.icon size={16} />
                  <div>
                    <div>{opt.label}</div>
                    <div className={`text-[10px] font-normal ${(ttsConfig.ttsBackend || 'fish') === opt.value ? 'opacity-70' : 'opacity-50'}`}>{opt.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {(ttsConfig.ttsBackend || 'fish') === 'genie' && (
            <div className={`${innerCardClass} p-4 rounded-[1.15rem] flex flex-col gap-3`}>
              <div className="flex items-center justify-between">
                <div className={fieldLabelClass}>{language === 'zh' ? 'Genie-TTS 本地配置' : 'Genie-TTS Local Config'}</div>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${
                    genieStatus === 'ready' ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]'
                    : genieStatus === 'starting' ? 'bg-yellow-400 animate-pulse'
                    : genieStatus === 'error' ? 'bg-red-400'
                    : (isDarkMode ? 'bg-gray-600' : 'bg-gray-300')
                  }`} />
                  <span className={`text-[10px] font-mono ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    {genieStatus === 'ready' ? (language === 'zh' ? `就绪 PID:${geniePid}` : `Ready PID:${geniePid}`)
                     : genieStatus === 'starting' ? (language === 'zh' ? '启动中...' : 'Starting...')
                     : genieStatus === 'error' ? (language === 'zh' ? '错误' : 'Error')
                     : (language === 'zh' ? '未启动' : 'Off')}
                  </span>
                </div>
              </div>

              <div>
                <label className={fieldLabelClass}>Python {language === 'zh' ? '路径' : 'Path'}</label>
                <input type="text" value={ttsConfig.geniePythonPath || 'python'}
                  onChange={e => update({ geniePythonPath: e.target.value })}
                  className={`${inputClass} w-full mt-1`}
                  placeholder={language === 'zh' ? '例：python 或 C:\\Python311\\python.exe' : 'e.g. python or C:\\Python311\\python.exe'} />
                <div className={`${helperClass} mt-0.5`}>{language === 'zh' ? '需已安装 genie-tts (pip install genie-tts)' : 'Requires genie-tts installed (pip install genie-tts)'}</div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={fieldLabelClass}>{language === 'zh' ? '端口' : 'Port'}</label>
                  <input type="number" value={ttsConfig.genieServerPort || 8000}
                    onChange={e => update({ genieServerPort: parseInt(e.target.value) || 8000 })}
                    className={`${inputClass} w-full mt-1`} />
                </div>
                <div>
                  <label className={fieldLabelClass}>{language === 'zh' ? '角色名' : 'Character'}</label>
                  <input type="text" value={ttsConfig.genieCharacterName || 'kumiko'}
                    onChange={e => update({ genieCharacterName: e.target.value })}
                    className={`${inputClass} w-full mt-1`} />
                </div>
              </div>

              <div>
                <label className={fieldLabelClass}>{language === 'zh' ? 'ONNX 模型目录' : 'ONNX Model Directory'}</label>
                <input type="text" value={ttsConfig.genieModelDir || ''}
                  onChange={e => update({ genieModelDir: e.target.value })}
                  className={`${inputClass} w-full mt-1`}
                  placeholder={language === 'zh' ? '例：D:\\Models\\kumiko-genie\\model' : 'e.g. D:\\Models\\kumiko-genie\\model'} />
              </div>

              <div>
                <label className={fieldLabelClass}>{language === 'zh' ? '参考音频目录' : 'Reference Audio Directory'}</label>
                <input type="text" value={ttsConfig.genieRefAudioDir || ''}
                  onChange={e => update({ genieRefAudioDir: e.target.value })}
                  className={`${inputClass} w-full mt-1`}
                  placeholder={language === 'zh' ? '例：D:\\Models\\kumiko-genie\\reference' : 'e.g. D:\\Models\\kumiko-genie\\reference'} />
                <div className={`${helperClass} mt-0.5`}>
                  {language === 'zh'
                    ? '需包含情绪 WAV 文件：neutral.wav, happy.wav, gentle.wav, resigned.wav, serious.wav, sad.wav, angry.wav, shy.wav, sleepy.wav, surprised.wav'
                    : 'Must contain emotion WAV files: neutral.wav, happy.wav, gentle.wav, resigned.wav, serious.wav, sad.wav, angry.wav, shy.wav, sleepy.wav, surprised.wav'}
                </div>
              </div>

              <div className="flex items-center gap-2 mt-1">
                {genieStatus === 'off' || genieStatus === 'error' ? (
                  <button onClick={handleGenieStart}
                    disabled={!ttsConfig.genieModelDir}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-xl ka-copy-sm font-semibold transition-colors ${
                      ttsConfig.genieModelDir
                        ? 'bg-green-600 hover:bg-green-700 text-white'
                        : isDarkMode ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    }`}>
                    <Power size={14} />
                    {language === 'zh' ? '启动 Genie 服务器' : 'Start Genie Server'}
                  </button>
                ) : genieStatus === 'starting' ? (
                  <button disabled className="flex items-center gap-2 px-4 py-2.5 rounded-xl ka-copy-sm font-semibold bg-yellow-600/50 text-yellow-200 cursor-wait">
                    <Loader2 size={14} className="animate-spin" />
                    {language === 'zh' ? '启动中...' : 'Starting...'}
                  </button>
                ) : (
                  <button onClick={handleGenieStop}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl ka-copy-sm font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors">
                    <PowerOff size={14} />
                    {language === 'zh' ? '停止服务器' : 'Stop Server'}
                  </button>
                )}
              </div>

              {genieError && (
                <div className="ka-micro text-red-400 bg-red-500/10 rounded px-2 py-1.5">{genieError}</div>
              )}
            </div>
          )}

          {(ttsConfig.ttsBackend || 'fish') !== 'genie' && (
            <>
          <div>
            <label className={fieldLabelClass}>{t.ttsFishApiKey}</label>
            <input type="password" value={ttsConfig.fishAudioApiKey} onChange={e => update({ fishAudioApiKey: e.target.value })}
              className={`${inputClass} w-full mt-1`} placeholder="sk-..." />
          </div>

          <div>
            <div className="flex items-center justify-between gap-3">
              <label className={fieldLabelClass}>{t.ttsFishReferenceId}</label>
              <button
                type="button"
                onClick={handleResetReferenceId}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ka-micro font-semibold transition-colors ${resetButtonClass}`}
              >
                <RotateCcw size={11} />
                {language === 'zh' ? '恢复默认久美子 ID' : 'Restore Kumiko Default ID'}
              </button>
            </div>
            <input type="text" value={ttsConfig.fishAudioReferenceId} onChange={e => update({ fishAudioReferenceId: e.target.value })}
              className={`${inputClass} w-full mt-1`} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
            <div className={`${helperClass} mt-1 flex flex-wrap items-center gap-2`}>
              <span>{t.ttsFishReferenceIdHint}</span>
              <button
                type="button"
                onClick={() => openExternalUrl('https://fish.audio')}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors ${externalLinkClass}`}
              >
                <ExternalLink size={11} />
                fish.audio
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex-1">
              <label className={fieldLabelClass}>{t.ttsFishModel}</label>
              <select value={ttsConfig.fishAudioModel} onChange={e => update({ fishAudioModel: e.target.value as 's1' | 's2-pro' })}
                className={`${inputClass} w-full mt-1`}>
                <option value="s2-pro">S2-Pro</option>
                <option value="s1">S1</option>
              </select>
            </div>
            <div className="flex-1">
              <label className={fieldLabelClass}>{t.ttsLatency}</label>
              <select value={ttsConfig.latency} onChange={e => update({ latency: e.target.value as 'balanced' | 'normal' })}
                className={`${inputClass} w-full mt-1`}>
                <option value="normal">Normal</option>
                <option value="balanced">Balanced</option>
              </select>
            </div>
          </div>

          <div>
            <label className={fieldLabelClass}>{t.ttsSpeed}: {ttsConfig.speed.toFixed(1)}x</label>
            <input type="range" min="0.5" max="2.0" step="0.1" value={ttsConfig.speed}
              onChange={e => update({ speed: parseFloat(e.target.value) })}
              className="w-full mt-1 accent-[#c79a2f]" />
          </div>
            </>
          )}
          <div className={`${innerCardClass} p-4 rounded-[1.15rem]`}>
            <div className="flex items-center justify-between gap-3">
              <div className={fieldLabelClass}>{t.ttsRingtone}</div>
              {selectedRingtoneLabel && (
                <div className={`${helperClass} rounded-full px-2.5 py-1 border ${isDarkMode ? 'border-[#4f3b2a] bg-[#211912]' : 'border-[#eadfce] bg-white/85'}`}>
                  {language === 'zh' ? `当前来电铃声：${selectedRingtoneLabel}` : `Current ringtone: ${selectedRingtoneLabel}`}
                </div>
              )}
            </div>
            <div className={`${helperClass} mt-0.5 mb-3 leading-relaxed`}>
              {language === 'zh' ? '选择内置铃声或上传自定义铃声' : 'Select built-in ringtones or upload custom ringtone'}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              {BUILT_IN_RINGTONES.map(ringtone => {
                const isSelected = ttsConfig.ringtoneFileId === ringtone.id;
                const isDefault = ringtone.id === '01.mp3';
                const isPreviewing = previewingRingtoneId === ringtone.id && isRingtonePlaying;
                const cardStateClass = isPreviewing
                  ? (isDarkMode
                    ? 'bg-sky-500/12 border-sky-400/60 shadow-[0_0_0_1px_rgba(56,189,248,0.18),0_0_12px_rgba(56,189,248,0.12)]'
                    : 'bg-sky-50 border-sky-400 shadow-[0_0_0_1px_rgba(56,189,248,0.16),0_8px_18px_rgba(56,189,248,0.08)]')
                  : isSelected
                    ? (isDarkMode
                      ? 'bg-amber-500/20 border-amber-500/50 shadow-[0_0_8px_rgba(212,168,82,0.3)]'
                      : 'bg-amber-50 border-amber-400 shadow-[0_0_6px_rgba(212,168,82,0.2)]')
                    : (isDarkMode ? 'bg-[#1a1510] border-[#3d3020] hover:border-[#5d4830]' : 'bg-white border-gray-200 hover:border-gray-300');
                return (
                  <div key={ringtone.id} className="relative group">
                    <button
                      onClick={() => update({ ringtoneFileId: ringtone.id })}
                      className={`w-full p-2 rounded-lg border transition-all text-left ${cardStateClass}`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className={`text-sm font-bold ${
                          isPreviewing
                            ? (isDarkMode ? 'text-sky-200' : 'text-sky-700')
                            : isSelected
                              ? (isDarkMode ? 'text-amber-300' : 'text-amber-700')
                              : (isDarkMode ? 'text-gray-300' : 'text-gray-700')
                        }`}>
                          {ringtone.displayNum}
                        </div>
                        {isDefault && !isSelected && (
                          <span className={`text-[8px] px-1 py-0.5 rounded ${isDarkMode ? 'bg-gray-700 text-gray-400' : 'bg-gray-100 text-gray-500'}`}>
                            DEFAULT
                          </span>
                        )}
                        {isPreviewing && (
                          <span className={`text-[8px] px-1 py-0.5 rounded ${isDarkMode ? 'bg-sky-500/30 text-sky-200' : 'bg-sky-100 text-sky-700'}`}>
                            {language === 'zh' ? '播放中' : 'PLAYING'}
                          </span>
                        )}
                        {isSelected && (
                          <span className={`text-[8px] px-1 py-0.5 rounded ${isDarkMode ? 'bg-amber-500/30 text-amber-300' : 'bg-amber-200 text-amber-700'}`}>
                            {language === 'zh' ? '使用中' : 'ACTIVE'}
                          </span>
                        )}
                      </div>
                      <div className={`text-[10px] truncate ${
                        isPreviewing
                          ? (isDarkMode ? 'text-sky-300/90' : 'text-sky-700')
                          : isSelected
                            ? (isDarkMode ? 'text-amber-400/90' : 'text-amber-600')
                            : (isDarkMode ? 'text-gray-500' : 'text-gray-500')
                      }`}
                        title={language === 'zh' ? ringtone.nameZh : ringtone.nameEn}>
                        {language === 'zh' ? ringtone.nameZh : ringtone.nameEn}
                      </div>
                      {ringtoneDurations[ringtone.id] && (
                        <div className={`text-[9px] mt-0.5 ${
                          isPreviewing
                            ? (isDarkMode ? 'text-sky-300/80' : 'text-sky-600')
                            : isSelected
                              ? (isDarkMode ? 'text-amber-500/70' : 'text-amber-500')
                              : (isDarkMode ? 'text-gray-600' : 'text-gray-400')
                        }`}>
                          {isPreviewing && ringtoneCurrentTime ? ringtoneCurrentTime : ringtoneDurations[ringtone.id]}
                        </div>
                      )}
                    </button>
                    <button
                      onClick={() => handleBuiltInRingtonePreview(ringtone.id)}
                      className={`absolute top-1 right-1 p-1.5 rounded-full transition-all opacity-0 group-hover:opacity-100 ${
                        isPreviewing
                          ? 'bg-red-500 text-white'
                          : (isDarkMode ? 'bg-black/60 text-white hover:bg-amber-500' : 'bg-black/40 text-white hover:bg-amber-500')
                      }`}
                      title={isPreviewing ? (language === 'zh' ? '停止' : 'Stop') : (language === 'zh' ? '试听' : 'Preview')}
                    >
                      {isPreviewing ? <Square size={10} /> : <Play size={10} />}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-2 mt-2 pt-3 border-t border-gray-500/10">
              <input ref={ringtoneInputRef} type="file" accept=".mp3,.wav,.ogg" className="hidden" onChange={handleRingtoneUpload} />
              <button onClick={() => ringtoneInputRef.current?.click()}
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded ka-copy-sm font-semibold ${actionChipClass}`}>
                <Upload size={12} /> {language === 'zh' ? '自定义上传' : 'Upload Custom'}
              </button>
              {hasRingtone && (
                <>
                  {(() => {
                    const isCustomPreviewing = previewingRingtoneId === CUSTOM_RINGTONE_PREVIEW_ID && isRingtonePlaying;
                    const customRingtoneTimeLabel = isCustomPreviewing && ringtoneCurrentTime
                      ? ringtoneCurrentTime
                      : ringtoneDurations[CUSTOM_RINGTONE_PREVIEW_ID];
                    return (
                      <>
                  {customRingtoneId && !isCustomRingtoneSelected && (
                    <button
                      onClick={() => update({ ringtoneFileId: customRingtoneId })}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded ka-copy-sm font-semibold ${actionChipClass}`}
                    >
                      <Volume2 size={12} />
                      {language === 'zh' ? '设为铃声' : 'Use as ringtone'}
                    </button>
                  )}
                  <button onClick={handleRingtonePreview}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded ka-copy-sm font-semibold transition-colors ${isCustomPreviewing ? 'text-sky-500 hover:text-sky-400 bg-sky-500/10' : (isDarkMode ? 'text-[#d8ba81] hover:text-[#eed29f]' : 'text-[#a06b22] hover:text-[#8a5b1d]')}`}>
                    {isCustomPreviewing ? <Square size={12} /> : <Play size={12} />}
                    {isCustomPreviewing ? (language === 'zh' ? '停止' : 'Stop') : t.ttsRingtonePreview}
                  </button>
                  <button onClick={handleRingtoneDelete}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded ka-copy-sm font-semibold text-red-400 hover:text-red-300">
                    <Trash2 size={12} /> {t.ttsRingtoneDelete}
                  </button>
                  <span className={helperClass}>
                    {language === 'zh' ? `已上传 · ${ringtoneFileName}` : `Uploaded · ${ringtoneFileName}`}
                    {customRingtoneTimeLabel ? ` · ${customRingtoneTimeLabel}` : ''}
                  </span>
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          </div>

          {(ttsConfig.ttsBackend || 'fish') !== 'genie' && (
          <button onClick={handleTestVoice} disabled={isTesting || !ttsConfig.fishAudioApiKey}
            className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl ka-copy-sm font-semibold transition-colors ${
              isTesting ? 'opacity-50 cursor-wait' : ''
            } ${ttsConfig.fishAudioApiKey
                ? 'bg-[#c79a2f] hover:bg-[#b6881f] text-white'
                : isDarkMode ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}>
            {isTesting ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
            {isTesting ? t.ttsTestPlaying : t.ttsTestButton}
          </button>
          )}
          {testStatus === 'playing' && (
            <div className={`p-3 rounded-lg border animate-in fade-in ${isDarkMode ? 'bg-[#2a2116] border-[#7e6338]/40' : 'bg-[#fff8eb] border-[#ecd4a9]'}`}>
              <div className="flex items-center gap-2 mb-2">
                <div className="flex items-center gap-0.5">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="w-0.5 bg-purple-400 rounded-full animate-pulse"
                      style={{ height: `${8 + Math.random() * 10}px`, animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
                <span className={`ka-micro font-semibold ${isDarkMode ? 'text-[#e5c98f]' : 'text-[#a06b22]'}`}>
                  {language === 'zh' ? '正在播放测试语音...' : 'Playing test voice...'}
                </span>
                <button onClick={() => {
                  stopTestVoicePlayback();
                }} className="ml-auto p-1 rounded hover:bg-amber-500/20">
                  <Square size={10} className="text-amber-500" />
                </button>
              </div>
              <div className={`ka-copy-sm leading-relaxed ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                <div className="ka-copy-sm">「全国大会を目指す日々は、決して楽な道のりではありません。しかし、仲間と共に努力する喜びが、私たちを強くしてくれました。」</div>
                <div className={`mt-1 ${helperClass}`}>
                  {language === 'zh'
                    ? '(以全国大赛为目标的每一天，绝不是一段轻松的路程。但是，与伙伴们共同努力的喜悦，让我们变得更加坚强。)'
                    : '(The days spent aiming for the national competition were never an easy road. But the joy of working hard alongside our friends made us stronger.)'}
                </div>
              </div>
            </div>
          )}
          {testStatus === 'error' && (
            <div className="ka-micro text-red-400">{language === 'zh' ? 'TTS 测试失败，请检查 API Key 和角色 ID。' : 'TTS test failed. Check API Key and Reference ID.'}</div>
          )}
        </div>
      )}
    </div>
  );
};
