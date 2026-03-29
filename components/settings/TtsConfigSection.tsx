import React, { useState, useRef, useCallback } from 'react';
import { ChevronDown, ChevronUp, Upload, Play, Square, Trash2, TestTube, Loader2, Volume2 } from 'lucide-react';
import type { TtsConfig, VoiceMode, Language } from '../../types';
import { UI_TRANSLATIONS, DEFAULT_TTS_CONFIG } from '../../constants';
import { synthesizeSpeech } from '../../services/fishAudioService';
import { saveRingtoneFile, loadRingtoneFile, deleteRingtoneFile, isVoiceServiceAvailable } from '../../services/voiceFileService';

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
  const [hasRingtone, setHasRingtone] = useState(!!ttsConfig.ringtoneFileId);
  const [isRingtonePlaying, setIsRingtonePlaying] = useState(false);
  const ringtoneInputRef = useRef<HTMLInputElement>(null);
  const ringtoneAudioRef = useRef<HTMLAudioElement | null>(null);
  const ringtoneUrlRef = useRef<string | null>(null);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);

  const update = useCallback((patch: Partial<TtsConfig>) => {
    onTtsConfigChange({ ...ttsConfig, ...patch });
  }, [ttsConfig, onTtsConfigChange]);

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
    }
    if (ringtoneInputRef.current) ringtoneInputRef.current.value = '';
  }, [update]);

  const handleRingtoneDelete = useCallback(async () => {
    await deleteRingtoneFile();
    update({ ringtoneFileId: undefined });
    setHasRingtone(false);
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

  return (
    <div className={`flex flex-col rounded-lg border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between p-4 w-full">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isDarkMode ? 'bg-amber-900/30 text-amber-400' : 'bg-amber-100 text-amber-700'}`}>
            <Volume2 size={20} />
          </div>
          <div className="text-left">
            <h3 className={`font-bold text-sm ${isDarkMode ? 'text-yellow-100' : 'text-gray-900'}`}>{t.ttsSection}</h3>
            {!isOpen && <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.ttsSectionDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {isOpen && (
        <div className="px-3 pb-3 flex flex-col gap-3">
          <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.ttsSectionDesc}</p>

          {!desktopAvailable && (
            <div className="text-[11px] text-amber-500 bg-amber-500/10 rounded px-2 py-1">
              TTS requires the desktop (Electron) version.
            </div>
          )}

          <div>
            <div className={labelClass}>{t.ttsVoiceMode}</div>
            <div className="flex gap-2 mt-1">
              {modeOptions.map(opt => (
                <button key={opt.value}
                  onClick={() => handleVoiceModeChange(opt.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    ttsConfig.voiceMode === opt.value
                      ? 'bg-purple-600 text-white'
                      : isDarkMode ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}>
                  {opt.label}
                </button>
              ))}
            </div>
            {(() => {
              const active = modeOptions.find(o => o.value === ttsConfig.voiceMode);
              return active?.desc ? (
                <div className={`text-[10px] mt-1.5 leading-relaxed ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                  {active.desc}
                </div>
              ) : null;
            })()}
          </div>

          <div>
            <label className={labelClass}>{t.ttsFishApiKey}</label>
            <input type="password" value={ttsConfig.fishAudioApiKey} onChange={e => update({ fishAudioApiKey: e.target.value })}
              className={`${inputClass} w-full mt-1`} placeholder="sk-..." />
          </div>

          <div>
            <label className={labelClass}>{t.ttsFishReferenceId}</label>
            <input type="text" value={ttsConfig.fishAudioReferenceId} onChange={e => update({ fishAudioReferenceId: e.target.value })}
              className={`${inputClass} w-full mt-1`} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
            <div className={`text-[10px] mt-0.5 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
              {t.ttsFishReferenceIdHint} — <a href="https://fish.audio" target="_blank" rel="noreferrer" className="text-purple-400 hover:underline">fish.audio</a>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className={labelClass}>{t.ttsFishModel}</label>
              <select value={ttsConfig.fishAudioModel} onChange={e => update({ fishAudioModel: e.target.value as 's1' | 's2-pro' })}
                className={`${inputClass} w-full mt-1`}>
                <option value="s2-pro">S2-Pro (recommended)</option>
                <option value="s1">S1</option>
              </select>
            </div>
            <div className="flex-1">
              <label className={labelClass}>{t.ttsLatency}</label>
              <select value={ttsConfig.latency} onChange={e => update({ latency: e.target.value as 'balanced' | 'normal' })}
                className={`${inputClass} w-full mt-1`}>
                <option value="normal">Normal</option>
                <option value="balanced">Balanced</option>
              </select>
            </div>
          </div>

          <div>
            <label className={labelClass}>{t.ttsSpeed}: {ttsConfig.speed.toFixed(1)}x</label>
            <input type="range" min="0.5" max="2.0" step="0.1" value={ttsConfig.speed}
              onChange={e => update({ speed: parseFloat(e.target.value) })}
              className="w-full mt-1 accent-purple-500" />
          </div>

          <div className={`text-[10px] ${isDarkMode ? 'text-gray-500' : 'text-gray-400'} border-t ${sectionBorder} pt-2`}>
            {t.ttsTranslationNote}
            <div className="mt-2">
              <label className={labelClass}>{(t as any).ttsTranslatorModel || 'TTS Translator Model (Optional)'}</label>
              <input type="text" value={ttsConfig.model_translator || ''} onChange={e => update({ model_translator: e.target.value })}
                className={`${inputClass} w-full mt-1`} placeholder={(t as any).ttsTranslatorModelHint || 'Leave empty to use main chat model'} />
            </div>
          </div>

          <div className={`${innerCardClass} p-2 rounded-lg`}>
            <div className={labelClass}>{t.ttsRingtone}</div>
            <div className={`text-[10px] mt-0.5 mb-1.5 leading-relaxed ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
              {(t as any).ttsRingtoneDesc || ''}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <input ref={ringtoneInputRef} type="file" accept=".mp3,.wav,.ogg" className="hidden" onChange={handleRingtoneUpload} />
              <button onClick={() => ringtoneInputRef.current?.click()}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] ${isDarkMode ? 'bg-gray-700 hover:bg-gray-600 text-gray-300' : 'bg-gray-100 hover:bg-gray-200 text-gray-600'}`}>
                <Upload size={12} /> {t.ttsRingtoneUpload}
              </button>
              {hasRingtone && (
                <>
                  <button onClick={handleRingtonePreview}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${isRingtonePlaying ? 'text-amber-400 hover:text-amber-300 bg-amber-500/10' : 'text-purple-400 hover:text-purple-300'}`}>
                    {isRingtonePlaying ? <Square size={12} /> : <Play size={12} />}
                    {isRingtonePlaying ? (language === 'zh' ? '停止' : 'Stop') : t.ttsRingtonePreview}
                  </button>
                  <button onClick={handleRingtoneDelete}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-red-400 hover:text-red-300">
                    <Trash2 size={12} /> {t.ttsRingtoneDelete}
                  </button>
                </>
              )}
              {!hasRingtone && (
                <span className={`text-[10px] ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>{t.ttsRingtoneDefault}</span>
              )}
            </div>
          </div>

          <button onClick={handleTestVoice} disabled={isTesting || !ttsConfig.fishAudioApiKey}
            className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
              isTesting ? 'opacity-50 cursor-wait' : ''
            } ${ttsConfig.fishAudioApiKey
                ? 'bg-purple-600 hover:bg-purple-700 text-white'
                : isDarkMode ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}>
            {isTesting ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
            {isTesting ? t.ttsTestPlaying : t.ttsTestButton}
          </button>
          {testStatus === 'playing' && (
            <div className={`p-3 rounded-lg border animate-in fade-in ${isDarkMode ? 'bg-purple-900/20 border-purple-500/30' : 'bg-purple-50 border-purple-200'}`}>
              <div className="flex items-center gap-2 mb-2">
                <div className="flex items-center gap-0.5">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="w-0.5 bg-purple-400 rounded-full animate-pulse"
                      style={{ height: `${8 + Math.random() * 10}px`, animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
                <span className={`text-[11px] font-bold ${isDarkMode ? 'text-purple-300' : 'text-purple-600'}`}>
                  {language === 'zh' ? '正在播放测试语音...' : 'Playing test voice...'}
                </span>
                <button onClick={() => {
                  if (testAudioRef.current) { testAudioRef.current.onended = null; testAudioRef.current.onerror = null; testAudioRef.current.pause(); testAudioRef.current.src = ''; }
                  setTestStatus('idle'); setIsTesting(false);
                }} className="ml-auto p-1 rounded hover:bg-purple-500/20">
                  <Square size={10} className="text-purple-400" />
                </button>
              </div>
              <div className={`text-[11px] leading-relaxed ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                <div className="font-mono">「全国大会を目指す日々は、決して楽な道のりではありません。しかし、仲間と共に努力する喜びが、私たちを強くしてくれました。」</div>
                <div className={`mt-1 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                  {language === 'zh'
                    ? '(以全国大赛为目标的每一天，绝不是一段轻松的路程。但是，与伙伴们共同努力的喜悦，让我们变得更加坚强。)'
                    : '(The days spent aiming for the national competition were never an easy road. But the joy of working hard alongside our friends made us stronger.)'}
                </div>
              </div>
            </div>
          )}
          {testStatus === 'error' && (
            <div className="text-[11px] text-red-400">{language === 'zh' ? 'TTS 测试失败，请检查 API Key 和角色 ID。' : 'TTS test failed. Check API Key and Reference ID.'}</div>
          )}
        </div>
      )}
    </div>
  );
};
