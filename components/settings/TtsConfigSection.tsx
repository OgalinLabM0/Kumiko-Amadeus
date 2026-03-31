import React, { useState, useRef, useCallback, useEffect } from 'react';
import { ChevronDown, ChevronUp, Upload, Play, Square, Trash2, TestTube, Loader2, Volume2, ExternalLink, RotateCcw } from 'lucide-react';
import type { TtsConfig, VoiceMode, Language } from '../../types';
import { UI_TRANSLATIONS, DEFAULT_TTS_CONFIG } from '../../constants';
import { synthesizeSpeech } from '../../services/fishAudioService';
import { saveRingtoneFile, loadRingtoneFile, deleteRingtoneFile, isVoiceServiceAvailable } from '../../services/voiceFileService';

const VALID_RINGTONE_FILE_RE = /^custom\.(mp3|wav|ogg|m4a|aac|flac)$/i;

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
  const t = UI_TRANSLATIONS[language];
  const [isTesting, setIsTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'playing' | 'error'>('idle');
  const [hasRingtone, setHasRingtone] = useState(false);
  const [ringtoneFileName, setRingtoneFileName] = useState<string | null>(null);
  const [isRingtonePlaying, setIsRingtonePlaying] = useState(false);
  const ringtoneInputRef = useRef<HTMLInputElement>(null);
  const ringtoneAudioRef = useRef<HTMLAudioElement | null>(null);
  const ringtoneUrlRef = useRef<string | null>(null);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);

  const update = useCallback((patch: Partial<TtsConfig>) => {
    onTtsConfigChange({ ...ttsConfig, ...patch });
  }, [ttsConfig, onTtsConfigChange]);

  useEffect(() => {
    let cancelled = false;

    const syncRingtoneState = async () => {
      const ipc = (window as any)?.electronAPI;
      if (!ipc) {
        const fallbackName = VALID_RINGTONE_FILE_RE.test(ttsConfig.ringtoneFileId || '')
          ? ttsConfig.ringtoneFileId || null
          : null;
        if (!cancelled) {
          setHasRingtone(!!fallbackName);
          setRingtoneFileName(fallbackName);
        }
        return;
      }

      try {
        const result = await ipc.invoke('ringtone:get-info');
        if (cancelled) return;
        const exists = result?.exists === true;
        setHasRingtone(exists);
        setRingtoneFileName(exists ? (result?.fileName || null) : null);
      } catch {
        if (!cancelled) {
          setHasRingtone(false);
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
  }, [isOpen, ttsConfig.ringtoneFileId]);

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
      if (testAudioRef.current) { testAudioRef.current.pause(); testAudioRef.current.src = ''; }
      const audio = new Audio(url);
      testAudioRef.current = audio;
      audio.onended = () => { setTestStatus('idle'); setIsTesting(false); URL.revokeObjectURL(url); };
      audio.onerror = () => { setTestStatus('error'); setIsTesting(false); URL.revokeObjectURL(url); };
      await audio.play();
      setTestStatus('playing');
    } catch {
      setTestStatus('error');
      setIsTesting(false);
    }
  }, [isTesting, ttsConfig]);

  const handleRingtoneUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() || 'mp3';
    const buf = await file.arrayBuffer();
    const ok = await saveRingtoneFile(buf, ext);
    if (ok) {
      update({ ringtoneFileId: `custom.${ext}` });
      setHasRingtone(true);
      setRingtoneFileName(`custom.${ext}`);
    }
    if (ringtoneInputRef.current) ringtoneInputRef.current.value = '';
  }, [update]);

  const handleRingtoneDelete = useCallback(async () => {
    await deleteRingtoneFile();
    update({ ringtoneFileId: undefined });
    setHasRingtone(false);
    setRingtoneFileName(null);
  }, [update]);

  const handleResetReferenceId = useCallback(() => {
    update({ fishAudioReferenceId: DEFAULT_TTS_CONFIG.fishAudioReferenceId });
  }, [update]);

  const handleRingtonePreview = useCallback(async () => {
    if (isRingtonePlaying && ringtoneAudioRef.current) {
      ringtoneAudioRef.current.pause();
      ringtoneAudioRef.current.currentTime = 0;
      setIsRingtonePlaying(false);
      if (ringtoneUrlRef.current) { URL.revokeObjectURL(ringtoneUrlRef.current); ringtoneUrlRef.current = null; }
      return;
    }
    const buf = await loadRingtoneFile();
    if (!buf) return;
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    ringtoneUrlRef.current = url;
    const audio = new Audio(url);
    ringtoneAudioRef.current = audio;
    audio.onended = () => { setIsRingtonePlaying(false); URL.revokeObjectURL(url); ringtoneUrlRef.current = null; };
    audio.onerror = () => { setIsRingtonePlaying(false); URL.revokeObjectURL(url); ringtoneUrlRef.current = null; };
    setIsRingtonePlaying(true);
    audio.play().catch(() => { setIsRingtonePlaying(false); URL.revokeObjectURL(url); ringtoneUrlRef.current = null; });
  }, [isRingtonePlaying]);

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
          <div className={`${innerCardClass} p-4 rounded-[1.15rem]`}>
            <div className={fieldLabelClass}>{t.ttsRingtone}</div>
            <div className={`${helperClass} mt-0.5 mb-1.5 leading-relaxed`}>
              {(t as any).ttsRingtoneDesc || ''}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <input ref={ringtoneInputRef} type="file" accept=".mp3,.wav,.ogg" className="hidden" onChange={handleRingtoneUpload} />
              <button onClick={() => ringtoneInputRef.current?.click()}
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded ka-copy-sm font-semibold ${actionChipClass}`}>
                <Upload size={12} /> {t.ttsRingtoneUpload}
              </button>
              {hasRingtone && (
                <>
                  <button onClick={handleRingtonePreview}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded ka-copy-sm font-semibold transition-colors ${isRingtonePlaying ? 'text-amber-400 hover:text-amber-300 bg-amber-500/10' : (isDarkMode ? 'text-[#d8ba81] hover:text-[#eed29f]' : 'text-[#a06b22] hover:text-[#8a5b1d]')}`}>
                    {isRingtonePlaying ? <Square size={12} /> : <Play size={12} />}
                    {isRingtonePlaying ? (language === 'zh' ? '停止' : 'Stop') : t.ttsRingtonePreview}
                  </button>
                  <button onClick={handleRingtoneDelete}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded ka-copy-sm font-semibold text-red-400 hover:text-red-300">
                    <Trash2 size={12} /> {t.ttsRingtoneDelete}
                  </button>
                </>
              )}
              {!hasRingtone && (
                <span className={helperClass}>{t.ttsRingtoneDefault}</span>
              )}
              {hasRingtone && ringtoneFileName && (
                <span className={helperClass}>
                  {language === 'zh' ? `已上传 · ${ringtoneFileName}` : `Uploaded · ${ringtoneFileName}`}
                </span>
              )}
            </div>
          </div>

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
                  if (testAudioRef.current) { testAudioRef.current.onended = null; testAudioRef.current.onerror = null; testAudioRef.current.pause(); testAudioRef.current.src = ''; }
                  setTestStatus('idle'); setIsTesting(false);
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
