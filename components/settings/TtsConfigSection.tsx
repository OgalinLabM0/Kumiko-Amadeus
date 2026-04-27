import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronUp, Upload, Play, Square, Trash2, TestTube, Loader2, Volume2, ExternalLink, RotateCcw, Power, PowerOff, Cpu, Cloud, Settings2, Edit2, Sparkles } from 'lucide-react';
import { ThemedSelect, type ThemedSelectOption } from '../common/ThemedSelect';
import type { TtsConfig, VoiceMode, Language, TtsBackend } from '../../types';
import { UI_TRANSLATIONS, DEFAULT_TTS_CONFIG } from '../../constants';
import { synthesizeSpeech, type TtsErrorKind } from '../../services/fishAudioService';
import { checkGenieHealth, isSovitsV3V4Model } from '../../services/genieAudioService';
import { SettingsToggle } from './SettingsToggle';
import { SovitsRefPromptEditorModal } from './SovitsRefPromptEditorModal';
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
import { Collapse } from '../Collapse';
import { openExternalUrl } from '../../utils/openExternal';
import { primeAudioForUserGesture } from '../../utils/audioUnlock';
import { isCapacitorNative } from '../../services/environment';
import { ComposableInput } from '../common/ComposableInput';
// F2B.3: dropped `isMobilePwa` + `httpApi` imports. The PWA used to mirror
// PC's GPT-SoVITS process state via `genie:status` HTTP IPC + `genie:state`
// WS events; that bridge is gone (SoVITS is hidden on Capacitor anyway).

interface TtsTestErrorInfo {
  kind: TtsErrorKind;
  status?: number;
  message: string;
}

function renderTtsErrorKindLabel(kind: TtsErrorKind, language: Language): string {
  const t = UI_TRANSLATIONS[language] as any;
  switch (kind) {
    case 'auth': return t.ttsErrorAuth;
    case 'payment': return t.ttsErrorPayment;
    case 'validation': return t.ttsErrorValidation;
    case 'network': return t.ttsErrorNetwork;
    default: return t.ttsErrorUnknown;
  }
}

// v2.14.9 W.2.B: pick the right MIME for the actual encoded format. Hard-
// coding 'audio/mpeg' silently breaks decoding when ttsConfig.format is
// 'opus' or 'wav' on Android WebView (Chromium media engine refuses to
// auto-detect when the type tag conflicts with the bytestream).
function audioMimeForFormat(format?: string): string {
  switch (format) {
    case 'opus': return 'audio/ogg';
    case 'wav':  return 'audio/wav';
    case 'mp3':
    default:     return 'audio/mpeg';
  }
}

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
  isPanelOpen?: boolean;
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
  isPanelOpen = true,
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
  const [testError, setTestError] = useState<TtsTestErrorInfo | null>(null);
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

  // Host platform detection via preload-exposed property. `hostPlatform` is 'win32'
  // on Windows, 'linux' on Linux, 'darwin' on macOS, and falls back to 'web' when
  // the renderer is running outside Electron (e.g. vite dev server in a regular
  // browser tab). Only used to conditionally surface the Linux "BYO Python" UI.
  const hostPlatform: string = (window as any)?.electronAPI?.platform ?? 'web';
  const isLinuxHost = hostPlatform === 'linux';

  const [pythonTestStatus, setPythonTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [pythonTestMessage, setPythonTestMessage] = useState<string>('');
  const [showSovitsPromptEditor, setShowSovitsPromptEditor] = useState(false);

  const sovitsSplitOptions = useMemo<ThemedSelectOption[]>(
    () => [
      { value: 'cut0', label: language === 'zh' ? '不切' : 'No split' },
      { value: 'cut1', label: language === 'zh' ? '凑四句一切' : 'Every 4 sentences' },
      { value: 'cut2', label: language === 'zh' ? '凑50字一切' : 'Every 50 chars' },
      { value: 'cut3', label: language === 'zh' ? '按中文句号切' : 'Chinese period' },
      { value: 'cut4', label: language === 'zh' ? '按英文句号切' : 'English period' },
      { value: 'cut5', label: language === 'zh' ? '按标点符号切' : 'All punctuation' },
    ],
    [language],
  );

  const fishModelOptions = useMemo<ThemedSelectOption[]>(
    () => [
      { value: 's2-pro', label: 'S2-Pro' },
      { value: 's1', label: 'S1' },
    ],
    [],
  );

  const fishLatencyOptions = useMemo<ThemedSelectOption[]>(
    () => [
      { value: 'normal', label: 'Normal' },
      { value: 'balanced', label: 'Balanced' },
    ],
    [],
  );

  const vocuPresetOptions = useMemo<ThemedSelectOption[]>(
    () => [
      { value: 'balance', label: (t as any).ttsVocuPresetBalance || 'Balance' },
      { value: 'vivid', label: (t as any).ttsVocuPresetVivid || 'Vivid (V3.0 only)' },
    ],
    [t],
  );

  const update = useCallback((patch: Partial<TtsConfig>) => {
    onTtsConfigChange({ ...ttsConfig, ...patch });
  }, [ttsConfig, onTtsConfigChange]);

  // Upstream GPT-SoVITS (v3v4set) forbids ref-free mode on v3/v4 weights.
  // When detected we grey out the switch and force it ON at the UI layer;
  // the inference layer in genieAudioService applies the same lock so the
  // persisted preference stays untouched.
  const sovitsV3V4Locked = isSovitsV3V4Model(ttsConfig);
  const sovitsUseRefTextEffective = sovitsV3V4Locked || (ttsConfig.sovitsUseRefText ?? false);

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

  // Stop preview when EITHER the whole settings panel is closed, OR the TTS
  // accordion section is collapsed. Historically only `isOpen` (the accordion
  // flag) was watched, but the settings panel itself hides via opacity +
  // visibility without unmounting, so closing settings with the TTS block still
  // expanded would leave the ringtone preview playing forever. See audit
  // findings for the regression details.
  useEffect(() => {
    if (isOpen && isPanelOpen) return;
    stopRingtonePlayback();
    stopTestVoicePlayback();
  }, [isOpen, isPanelOpen, stopRingtonePlayback, stopTestVoicePlayback]);

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
    const applyStatus = (running: boolean, pid?: number | null) => {
      if (running) {
        setGenieStatus('ready');
        setGeniePid(typeof pid === 'number' ? pid : null);
      } else {
        setGenieStatus('off');
        setGeniePid(null);
      }
    };

    if (ipc) {
      ipc.invoke('genie:status').then((s: any) => {
        if (s?.running) applyStatus(true, s.pid);
      }).catch(() => {});
      const handler = (_: any, data: any) => {
        if (!data?.running) applyStatus(false);
      };
      ipc.on('genie:status-changed', handler);
      return () => { ipc.removeListener('genie:status-changed', handler); };
    }

    // F2B.3: PWA `genie:status` polling removed. SoVITS lives on PC's
    // 127.0.0.1:9880 — only Electron desktop can reach it.
    return undefined;
  }, [isOpen]);

  const [showAdvancedSovits, setShowAdvancedSovits] = useState(false);

  const handleGenieStart = useCallback(async () => {
    const ipc = (window as any)?.electronAPI;
    if (!ipc) return;
    setGenieStatus('starting');
    setGenieError(null);
    try {
      const result = await ipc.invoke('genie:start', {
        sovitsDir: ttsConfig.sovitsDir,
        port: ttsConfig.sovitsPort || 9880,
        gptWeights: ttsConfig.sovitsGptWeights || '',
        vitsWeights: ttsConfig.sovitsVitsWeights || '',
        // Linux/macOS BYO Python: the main process refuses to start SoVITS until
        // an authorized interpreter path is supplied. Ignored on Windows, where
        // the bundled runtime/python.exe is always used.
        pythonInterpreter: ttsConfig.sovitsPythonPath || '',
      });
      if (result?.success) {
        setGeniePid(result.pid || null);
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

  // Browse + authorize the GPT-SoVITS directory via the native dialog. Main process
  // performs fingerprint validation (runtime/python.exe, api_v2.py, tts_infer.yaml) and
  // persists the approval, so `genie:start` will be allowed to spawn from this path.
  // Without this step, genie:start now refuses to execute (P0 safety fix).
  const handlePickSovitsDir = useCallback(async () => {
    const ipc = (window as any)?.electronAPI;
    if (!ipc) return;
    try {
      const result = await ipc.invoke('genie:pick-sovits-dir');
      if (result?.canceled) return;
      if (result?.success && result.path) {
        update({ sovitsDir: result.path });
        setGenieError(null);
      } else {
        setGenieError(result?.error || (language === 'zh' ? '无法授权该目录' : 'Failed to authorize directory'));
      }
    } catch (e: any) {
      setGenieError(e?.message || 'IPC error');
    }
  }, [language, update]);

  const handleGenieStop = useCallback(async () => {
    const ipc = (window as any)?.electronAPI;
    if (!ipc) return;
    await ipc.invoke('genie:stop');
    setGenieStatus('off');
    setGeniePid(null);
    setGenieError(null);
  }, []);

  // Linux-only: authorize a user-supplied python interpreter via the native file
  // dialog. Main process validates the path is a real executable and persists
  // the approval; we just store the resulting absolute path in ttsConfig.
  const handlePickSovitsPython = useCallback(async () => {
    const ipc = (window as any)?.electronAPI;
    if (!ipc) return;
    try {
      const result = await ipc.invoke('genie:pick-sovits-python');
      if (result?.canceled) return;
      if (result?.success && result.path) {
        update({ sovitsPythonPath: result.path });
        setPythonTestStatus('idle');
        setPythonTestMessage('');
        setGenieError(null);
      } else {
        setGenieError(result?.error || (language === 'zh' ? '无法授权该 Python 解释器' : 'Failed to authorize Python interpreter'));
      }
    } catch (e: any) {
      setGenieError(e?.message || 'IPC error');
    }
  }, [language, update]);

  // Smoke-test the currently configured python interpreter by invoking
  // `python --version` through the main process. Surfaces the version string on
  // success and the captured stderr on failure so users can tell whether they
  // picked the right conda env.
  const handleTestSovitsPython = useCallback(async () => {
    const ipc = (window as any)?.electronAPI;
    if (!ipc) return;
    const target = ttsConfig.sovitsPythonPath || '';
    if (!target) {
      setPythonTestStatus('error');
      setPythonTestMessage(language === 'zh' ? '请先选择 Python 解释器' : 'Pick a Python interpreter first.');
      return;
    }
    setPythonTestStatus('testing');
    setPythonTestMessage('');
    try {
      const result = await ipc.invoke('genie:test-sovits-python', { pythonPath: target });
      if (result?.success) {
        setPythonTestStatus('ok');
        setPythonTestMessage(result.version || 'Python OK');
      } else {
        setPythonTestStatus('error');
        setPythonTestMessage(result?.error || (language === 'zh' ? '测试失败' : 'Test failed'));
      }
    } catch (e: any) {
      setPythonTestStatus('error');
      setPythonTestMessage(e?.message || 'IPC error');
    }
  }, [language, ttsConfig.sovitsPythonPath]);

  const handleTestSovitsVoice = useCallback(async () => {
    if (isTesting || genieStatus !== 'ready') return;

    // iOS Safari (mobile PWA) autoplay policy: an `audio.play()` call after
    // any `await` no longer counts as user-initiated and is rejected with
    // `NotAllowedError`. We synchronously prime an Audio element with a
    // tiny silent WAV inside this user-gesture frame, then later swap in
    // the real TTS source. See utils/audioUnlock.ts for the full rationale.
    stopTestVoicePlayback();
    const audio = new Audio();
    testAudioRef.current = audio;
    const unlockPromise = primeAudioForUserGesture(audio);

    setIsTesting(true);
    setTestStatus('idle');
    setTestError(null);
    try {
      const { synthesizeWithSovits } = await import('../../services/genieAudioService');
      const baseUrl = `http://127.0.0.1:${ttsConfig.sovitsPort || 9880}`;
      const refDir = ttsConfig.sovitsRefAudioDir || '';
      const sep = refDir.includes('/') ? '/' : '\\';
      const refPath = refDir ? `${refDir}${sep}neutral_casual.wav` : '';
      const promptText = '万が一ってこともあるし…ごめん奏ちゃん、あとお願いできる?';
      const testText = '全国大会を目指す日々は、決して楽な道のりではありません。しかし、仲間と共に努力する喜びが、私たちを強くしてくれました。';
      const result = await synthesizeWithSovits(testText, baseUrl, refPath, promptText, {
        speed: ttsConfig.speed,
        topK: ttsConfig.sovitsTopK,
        topP: ttsConfig.sovitsTopP,
        temperature: ttsConfig.sovitsTemperature,
        textSplitMethod: ttsConfig.sovitsTextSplitMethod,
        fragmentInterval: ttsConfig.sovitsFragmentInterval,
      });
      // Wait for the silent priming playback to settle so iOS doesn't reject
      // the real `play()` for racing with an in-flight one.
      await unlockPromise;
      // The user (or another effect) may have stopped the test in between;
      // if our element was swapped out, abort silently.
      if (testAudioRef.current !== audio) return;
      const blob = new Blob([result.audio], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      testAudioUrlRef.current = url;
      audio.onended = () => { stopTestVoicePlayback(); };
      audio.onerror = () => { stopTestVoicePlayback(); setTestStatus('error'); };
      audio.src = url;
      await audio.play();
      setTestStatus('playing');
    } catch (e: any) {
      console.error('[TTS-SoVITS Test]', e);
      setTestError({
        kind: (e?.kind as TtsErrorKind) ?? 'unknown',
        status: typeof e?.status === 'number' ? e.status : undefined,
        message: e?.message || String(e),
      });
      setTestStatus('error');
      setIsTesting(false);
    }
  }, [isTesting, genieStatus, ttsConfig, stopTestVoicePlayback]);

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

  const handleVoiceModeChange = useCallback((mode: VoiceMode) => {
    update({ voiceMode: mode });
  }, [update]);

  const handleTestVoice = useCallback(async () => {
    if (isTesting) return;
    if (!ttsConfig.fishAudioApiKey) {
      setTestError({
        kind: 'auth',
        message: language === 'zh' ? 'Fish Audio API Key 未配置' : 'Fish Audio API key is not configured',
      });
      setTestStatus('error');
      return;
    }

    // Synchronous priming inside the user-gesture frame — see the comment
    // in handleTestSovitsVoice for the iOS Safari autoplay rationale. The
    // mobile PWA path goes through `synthesizeSpeech`, which awaits an HTTP
    // round-trip via `tts:fish-synth`, so by the time we'd otherwise call
    // `audio.play()` the gesture is gone and Safari rejects with
    // "The request is not allowed by the user agent or the platform in
    // the current context, possibly because the user denied permission."
    stopTestVoicePlayback();
    const audio = new Audio();
    testAudioRef.current = audio;
    const unlockPromise = primeAudioForUserGesture(audio);

    setIsTesting(true);
    setTestStatus('idle');
    setTestError(null);
    try {
      const testText = '全国大会を目指す日々は、決して楽な道のりではありません。しかし、仲間と共に努力する喜びが、私たちを強くしてくれました。';
      const result = await synthesizeSpeech(testText, ttsConfig);
      await unlockPromise;
      if (testAudioRef.current !== audio) return;
      const blob = new Blob([result.audio], { type: audioMimeForFormat(ttsConfig.format) });
      const url = URL.createObjectURL(blob);
      testAudioUrlRef.current = url;
      audio.onended = () => { stopTestVoicePlayback(); };
      audio.onerror = () => {
        stopTestVoicePlayback();
        setTestStatus('error');
      };
      audio.src = url;
      await audio.play();
      setTestStatus('playing');
    } catch (e: any) {
      console.error('[TTS-Fish Test]', e);
      setTestError({
        kind: (e?.kind as TtsErrorKind) ?? 'unknown',
        status: typeof e?.status === 'number' ? e.status : undefined,
        message: e?.message || String(e),
      });
      setTestStatus('error');
      setIsTesting(false);
    }
  }, [isTesting, language, stopTestVoicePlayback, ttsConfig]);

  const handleTestVocuVoice = useCallback(async () => {
    if (isTesting) return;
    if (!ttsConfig.vocuApiKey || !ttsConfig.vocuVoiceId) {
      setTestError({
        kind: !ttsConfig.vocuApiKey ? 'auth' : 'validation',
        message: !ttsConfig.vocuApiKey
          ? (language === 'zh' ? 'Vocu API Key 未配置' : 'Vocu API key is not configured')
          : (language === 'zh' ? 'Vocu Voice ID 未配置' : 'Vocu Voice ID is not configured'),
      });
      setTestStatus('error');
      return;
    }

    // Same iOS Safari autoplay priming pattern as handleTestVoice /
    // handleTestSovitsVoice. Without this the awaited Vocu synth would
    // throw NotAllowedError on mobile PWA when we later call play().
    stopTestVoicePlayback();
    const audio = new Audio();
    testAudioRef.current = audio;
    const unlockPromise = primeAudioForUserGesture(audio);

    setIsTesting(true);
    setTestStatus('idle');
    setTestError(null);
    try {
      const { synthesizeWithVocu } = await import('../../services/vocuAudioService');
      const testText = '全国大会を目指す日々は、決して楽な道のりではありません。しかし、仲間と共に努力する喜びが、私たちを強くしてくれました。';
      const result = await synthesizeWithVocu(testText, ttsConfig, 'neutral');
      await unlockPromise;
      if (testAudioRef.current !== audio) return;
      const blob = new Blob([result.audio], { type: audioMimeForFormat(ttsConfig.format) });
      const url = URL.createObjectURL(blob);
      testAudioUrlRef.current = url;
      audio.onended = () => { stopTestVoicePlayback(); };
      audio.onerror = () => {
        stopTestVoicePlayback();
        setTestStatus('error');
      };
      audio.src = url;
      await audio.play();
      setTestStatus('playing');
    } catch (e: any) {
      console.error('[TTS-Vocu Test]', e);
      setTestError({
        kind: (e?.kind as TtsErrorKind) ?? 'unknown',
        status: typeof e?.status === 'number' ? e.status : undefined,
        message: e?.message || String(e),
      });
      setTestStatus('error');
      setIsTesting(false);
    }
  }, [isTesting, language, stopTestVoicePlayback, ttsConfig]);

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

  const handleResetVocuVoiceId = useCallback(() => {
    update({ vocuVoiceId: DEFAULT_TTS_CONFIG.vocuVoiceId });
  }, [update]);

  const handleRingtonePreview = useCallback(async () => {
    const isCustomPreviewing = previewingRingtoneId === CUSTOM_RINGTONE_PREVIEW_ID && isRingtonePlaying;
    if (isCustomPreviewing && ringtoneAudioRef.current) {
      stopRingtonePlayback();
      return;
    }
    // Synchronously prime an audio element inside this user-gesture frame so
    // iOS Safari allows the post-await `play()`. The custom ringtone path
    // awaits `loadRingtoneFileWithName()` (Dexie / HTTP on mobile) before
    // play, which severs the gesture link without this priming step.
    stopRingtonePlayback();
    const audio = new Audio();
    ringtoneAudioRef.current = audio;
    const unlockPromise = primeAudioForUserGesture(audio);
    const loaded = await loadRingtoneFileWithName();
    if (!loaded) {
      stopRingtonePlayback();
      return;
    }
    await unlockPromise;
    if (ringtoneAudioRef.current !== audio) return;
    const blob = new Blob([loaded.buffer], { type: getAudioMimeTypeForFileName(loaded.fileName) });
    const url = URL.createObjectURL(blob);
    ringtoneUrlRef.current = url;
    audio.src = url;
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
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border shrink-0 ${isDarkMode ? 'border-amber-500/20 bg-amber-900/20 text-amber-300' : 'border-amber-200 bg-amber-50/90 text-amber-700'}`}>
            <Volume2 size={18} />
          </div>
          <div className="text-left">
            <h3 className={sectionTitleClass}>{t.ttsSection}</h3>
            {!isOpen && <p className={sectionDescClass}>{t.ttsSectionDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen} duration={180}>
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
            <div className={`grid grid-cols-1 ${isCapacitorNative() ? 'sm:grid-cols-2' : 'sm:grid-cols-3'} gap-2 mt-2`}>
              {/*
                A3: GPT-SoVITS is a PC-only feature (PyTorch + CUDA + Python
                runtime + ~5 GB models live on PC's localhost). On Android
                Capacitor we hide the radio entirely; sanitizeTtsConfig clamps
                a migrated `ttsBackend: 'sovits'` to 'fish' so the picker
                doesn't render with the wrong selection.
              */}
              {([
                { value: 'fish' as TtsBackend, label: 'Fish Audio', desc: language === 'zh' ? '云端 · 需 API Key' : 'Cloud · API Key required', icon: Cloud },
                ...(isCapacitorNative() ? [] : [
                  { value: 'sovits' as TtsBackend, label: 'GPT-SoVITS', desc: language === 'zh' ? '本地推理' : 'Local inference', icon: Cpu },
                ]),
                { value: 'vocu' as TtsBackend, label: 'Vocu AI', desc: language === 'zh' ? '云端 · 需 API Key' : 'Cloud · API Key required', icon: Sparkles },
              ]).map(opt => (
                <button key={opt.value}
                  onClick={() => update({ ttsBackend: opt.value })}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl ka-copy-sm font-semibold transition-colors text-left ${
                    (ttsConfig.ttsBackend || 'fish') === opt.value
                      ? (isDarkMode ? 'bg-[#d4a852] text-[#21150a] shadow-[0_10px_20px_rgba(212,168,82,0.18)]' : 'bg-[#fff5e3] text-[#8a6122] border border-[#e0c58f] shadow-[0_8px_18px_rgba(138,97,34,0.10)]')
                      : actionChipClass
                  }`}>
                  <opt.icon size={16} />
                  <div className="min-w-0">
                    <div>{opt.label}</div>
                    <div className={`text-[10px] font-normal ${(ttsConfig.ttsBackend || 'fish') === opt.value ? 'opacity-70' : 'opacity-50'}`}>{opt.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {(ttsConfig.ttsBackend || 'fish') === 'sovits' && (
            <div className={`${innerCardClass} p-4 rounded-[1.15rem] flex flex-col gap-3`}>
              <div className="flex items-center justify-between">
                <div className={fieldLabelClass}>{language === 'zh' ? 'GPT-SoVITS 本地配置' : 'GPT-SoVITS Local Config'}</div>
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
                <label className={fieldLabelClass}>{language === 'zh' ? 'GPT-SoVITS 安装目录（必填）' : 'GPT-SoVITS Install Directory (required)'}</label>
                <div className="flex gap-2 mt-1">
                  <ComposableInput type="text" value={ttsConfig.sovitsDir || ''}
                    onChange={e => update({ sovitsDir: e.target.value })}
                    className={`${inputClass} flex-1`}
                    placeholder={isLinuxHost
                      ? (language === 'zh' ? '例：/home/you/AI/GPT-SoVITS' : 'e.g. /home/you/AI/GPT-SoVITS')
                      : (language === 'zh' ? '例：D:\\AI\\GPT-SoVITS\\GPT-SoVITS-v2pro-20250604' : 'e.g. D:\\AI\\GPT-SoVITS-v2pro')} />
                  <button type="button" onClick={handlePickSovitsDir}
                    className={`px-3 py-2 rounded-lg ka-copy-sm font-semibold transition-colors ${isDarkMode ? 'bg-[#3a2f23] hover:bg-[#4a3f33] text-[#ead8c1]' : 'bg-[#785A42] hover:bg-[#604a35] text-white'}`}>
                    {language === 'zh' ? '浏览…' : 'Browse…'}
                  </button>
                </div>
                <div className={`${helperClass} mt-0.5`}>
                  {isLinuxHost
                    ? (language === 'zh'
                        ? '需包含 api_v2.py 和 GPT_SoVITS/configs/tts_infer.yaml。首次使用请点击"浏览"通过系统对话框授权；手动粘贴路径启动会被拒绝。Linux 不使用打包内的 python，请在下方另行指定 Python 解释器。'
                        : 'Must contain api_v2.py and GPT_SoVITS/configs/tts_infer.yaml. First-time setup requires clicking "Browse" to authorize via the system dialog; a manually pasted path will be refused at startup. On Linux the bundled python runtime is NOT used — configure a Python interpreter below.')
                    : (language === 'zh'
                        ? '需包含 runtime/python.exe 和 api_v2.py。首次使用请点击"浏览"通过系统对话框选择并授权；手动粘贴路径启动会被拒绝。'
                        : 'Must contain runtime/python.exe and api_v2.py. First-time setup requires clicking "Browse" to pick + authorize via the system dialog; a manually pasted path will be refused at startup.')}
                </div>
              </div>

              {/* Linux-only: Python interpreter picker. On Windows the bundled
                  runtime/python.exe in the SoVITS install directory is used, so this
                  field is irrelevant. On Linux/macOS we require the user to supply
                  their own python (conda env / venv) because we don't ship a SoVITS
                  Linux runtime — the AppImage stays small and compatibility with
                  CUDA/torch versions is the user's choice. */}
              {isLinuxHost && (
                <div>
                  <label className={fieldLabelClass}>
                    {language === 'zh' ? 'Python 解释器路径（Linux 专用，必填）' : 'Python Interpreter Path (Linux only, required)'}
                  </label>
                  <div className="flex gap-2 mt-1">
                    <ComposableInput type="text" value={ttsConfig.sovitsPythonPath || ''}
                      onChange={e => update({ sovitsPythonPath: e.target.value })}
                      className={`${inputClass} flex-1`}
                      placeholder={language === 'zh' ? '例：/home/you/miniconda3/envs/GPTSoVits/bin/python' : 'e.g. /home/you/miniconda3/envs/GPTSoVits/bin/python'} />
                    <button type="button" onClick={handlePickSovitsPython}
                      className={`px-3 py-2 rounded-lg ka-copy-sm font-semibold transition-colors ${isDarkMode ? 'bg-[#3a2f23] hover:bg-[#4a3f33] text-[#ead8c1]' : 'bg-[#785A42] hover:bg-[#604a35] text-white'}`}>
                      {language === 'zh' ? '浏览…' : 'Browse…'}
                    </button>
                    <button type="button" onClick={handleTestSovitsPython}
                      disabled={pythonTestStatus === 'testing' || !ttsConfig.sovitsPythonPath}
                      className={`px-3 py-2 rounded-lg ka-copy-sm font-semibold transition-colors flex items-center gap-1.5 ${
                        pythonTestStatus === 'testing' || !ttsConfig.sovitsPythonPath
                          ? (isDarkMode ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed')
                          : (isDarkMode ? 'bg-[#2a3a2b] hover:bg-[#344a35] text-[#c7e6c9] border border-[#4c6a4e]' : 'bg-[#eaf5eb] hover:bg-[#d9ecda] text-[#3e6a42] border border-[#b8d4bb]')
                      }`}>
                      {pythonTestStatus === 'testing'
                        ? <Loader2 size={14} className="animate-spin" />
                        : <TestTube size={14} />}
                      {pythonTestStatus === 'testing'
                        ? (language === 'zh' ? '测试中…' : 'Testing…')
                        : (language === 'zh' ? '测试连通性' : 'Test')}
                    </button>
                  </div>
                  <div className={`${helperClass} mt-0.5`}>
                    {language === 'zh'
                      ? '自备 Python 环境：建议 conda/venv 且已安装 GPT-SoVITS 的依赖（torch、transformers 等）。点击"浏览"通过系统对话框授权——未授权的路径会被启动流程拒绝。'
                      : 'Bring your own Python: a conda env or venv with GPT-SoVITS dependencies (torch, transformers, etc). Click "Browse" to authorize via the system dialog — unauthorized paths are refused at startup.'}
                  </div>
                  {pythonTestStatus === 'ok' && pythonTestMessage && (
                    <div className={`ka-micro mt-1 rounded px-2 py-1.5 ${isDarkMode ? 'text-[#b4e6b7] bg-[#1b2a1c]' : 'text-[#3e6a42] bg-[#eaf5eb]'}`}>
                      {language === 'zh' ? `Python 可用 · ${pythonTestMessage}` : `Python OK · ${pythonTestMessage}`}
                    </div>
                  )}
                  {pythonTestStatus === 'error' && pythonTestMessage && (
                    <div className="ka-micro mt-1 text-red-400 bg-red-500/10 rounded px-2 py-1.5">
                      {language === 'zh' ? `测试失败：${pythonTestMessage}` : `Test failed: ${pythonTestMessage}`}
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className={fieldLabelClass}>{language === 'zh' ? '端口（默认即可）' : 'Port (default OK)'}</label>
                <input type="number" value={ttsConfig.sovitsPort || 9880}
                  onChange={e => update({ sovitsPort: parseInt(e.target.value) || 9880 })}
                  className={`${inputClass} w-full mt-1`} />
              </div>

              <div>
                <label className={fieldLabelClass}>{language === 'zh' ? 'GPT 模型路径 (.ckpt)' : 'GPT Model Path (.ckpt)'}</label>
                <ComposableInput type="text" value={ttsConfig.sovitsGptWeights || ''}
                  onChange={e => update({ sovitsGptWeights: e.target.value })}
                  className={`${inputClass} w-full mt-1`}
                  placeholder={language === 'zh' ? '例：GPT_weights_v2ProPlus/KMK.F.KA-e20.ckpt' : 'e.g. GPT_weights_v2ProPlus/model.ckpt'} />
                <div className={`${helperClass} mt-0.5`}>
                  {language === 'zh' ? '可选，填写后启动时自动切换模型。留空则使用 tts_infer.yaml 中的默认模型' : 'Optional. Auto-switches model on start. Leave empty to use tts_infer.yaml default'}
                </div>
              </div>

              <div>
                <label className={fieldLabelClass}>{language === 'zh' ? 'SoVITS 模型路径 (.pth)' : 'SoVITS Model Path (.pth)'}</label>
                <ComposableInput type="text" value={ttsConfig.sovitsVitsWeights || ''}
                  onChange={e => update({ sovitsVitsWeights: e.target.value })}
                  className={`${inputClass} w-full mt-1`}
                  placeholder={language === 'zh' ? '例：SoVITS_weights_v2ProPlus/KMK.F.KA_c8_s96.pth' : 'e.g. SoVITS_weights_v2ProPlus/model.pth'} />
              </div>

              <div>
                <label className={fieldLabelClass}>{language === 'zh' ? '参考音频目录（必填）' : 'Reference Audio Directory (required)'}</label>
                <ComposableInput type="text" value={ttsConfig.sovitsRefAudioDir || ''}
                  onChange={e => update({ sovitsRefAudioDir: e.target.value })}
                  className={`${inputClass} w-full mt-1`}
                  placeholder={language === 'zh' ? '例：D:\\Models\\kumiko\\reference' : 'e.g. D:\\Models\\kumiko\\reference'} />
                <div className={`${helperClass} mt-0.5`}>
                  {language === 'zh'
                    ? '需包含 25 个情绪变体 WAV 文件（由 GPT-SoVITS 模型包或单独的参考音频包提供）'
                    : 'Must contain 25 emotion variant WAV files (from GPT-SoVITS model pack or separate ref audio pack)'}
                </div>
              </div>

              <div className={`mt-1 rounded-xl border p-3 ${isDarkMode ? 'bg-[#1a1714] border-[#a88247]/55' : 'bg-white/70 border-[#e6ddcf]'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 pr-2 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <label className={fieldLabelClass}>
                        {t.sovitsUseRefTextLabel}
                      </label>
                      <span className={`ka-micro font-mono px-1.5 py-0.5 rounded border ${
                        sovitsUseRefTextEffective
                          ? (isDarkMode ? 'border-sky-700/60 bg-sky-900/30 text-sky-300' : 'border-sky-400/60 bg-sky-50 text-sky-700')
                          : (isDarkMode ? 'border-emerald-700/60 bg-emerald-900/30 text-emerald-300' : 'border-emerald-400/60 bg-emerald-50 text-emerald-700')
                      }`}>
                        {sovitsUseRefTextEffective
                          ? t.sovitsUseRefTextModePrecise
                          : t.sovitsUseRefTextModeSimple}
                      </span>
                    </div>
                    <p className={`${helperClass} mt-1`}>
                      {sovitsUseRefTextEffective
                        ? t.sovitsUseRefTextOnDesc
                        : t.sovitsUseRefTextOffDesc}
                    </p>
                    {sovitsV3V4Locked && (
                      <p className={`ka-copy-sm mt-1 font-semibold ${isDarkMode ? 'text-red-400' : 'text-red-600'}`}>
                        {t.sovitsV3V4LockNotice}
                      </p>
                    )}
                  </div>
                  <div className={`flex-shrink-0 pt-0.5 ${sovitsV3V4Locked ? 'opacity-60 pointer-events-none' : ''}`}>
                    <SettingsToggle
                      checked={sovitsUseRefTextEffective}
                      onClick={() => {
                        if (sovitsV3V4Locked) return;
                        update({ sovitsUseRefText: !ttsConfig.sovitsUseRefText });
                      }}
                      activeTrackClass={isDarkMode ? 'bg-sky-600/80' : 'bg-sky-500/90'}
                      inactiveTrackClass={isDarkMode ? 'bg-[#3e3429]' : 'bg-[#d7d2ca]'}
                      ariaLabel={t.sovitsUseRefTextLabel}
                    />
                  </div>
                </div>
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => setShowSovitsPromptEditor(true)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border ka-copy-sm transition-colors ${
                      isDarkMode
                        ? 'text-[#d4a852] border-[#4f3b2a] hover:bg-amber-900/20'
                        : 'text-[#8a6122] border-[#e0c58f] hover:bg-amber-50'
                    }`}
                  >
                    <Edit2 size={12} />
                    {t.sovitsEditPromptsButton}
                  </button>
                  <p className={`${helperClass} mt-1`}>
                    {t.sovitsEditPromptsHint}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {genieStatus === 'off' || genieStatus === 'error' ? (
                  (() => {
                    // On Linux we additionally require an authorized python interpreter;
                    // on Windows the bundled runtime/python.exe inside sovitsDir is used.
                    const canStart = !!ttsConfig.sovitsDir && (!isLinuxHost || !!ttsConfig.sovitsPythonPath);
                    return (
                      <button onClick={handleGenieStart}
                        disabled={!canStart}
                        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl ka-copy-sm font-semibold transition-colors ${
                          canStart
                            ? 'bg-green-600 hover:bg-green-700 text-white'
                            : isDarkMode ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                        }`}>
                        <Power size={14} />
                        {language === 'zh' ? '启动 GPT-SoVITS 服务器' : 'Start GPT-SoVITS Server'}
                      </button>
                    );
                  })()
                ) : genieStatus === 'starting' ? (
                  <button disabled className="flex items-center gap-2 px-4 py-2.5 rounded-xl ka-copy-sm font-semibold bg-yellow-600/50 text-yellow-200 cursor-wait">
                    <Loader2 size={14} className="animate-spin" />
                    {language === 'zh' ? '启动中（模型加载可能需要30-60秒）...' : 'Starting (model loading may take 30-60s)...'}
                  </button>
                ) : (
                  <button onClick={handleGenieStop}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl ka-copy-sm font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors">
                    <PowerOff size={14} />
                    {language === 'zh' ? '停止服务器' : 'Stop Server'}
                  </button>
                )}
                {testStatus === 'playing' ? (
                  <button onClick={stopTestVoicePlayback}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-xl ka-copy-sm font-semibold transition-colors ${
                      isDarkMode ? 'bg-sky-600 hover:bg-sky-700 text-white' : 'bg-sky-500 hover:bg-sky-600 text-white'
                    }`}>
                    <Square size={14} />
                    {language === 'zh' ? '停止播放' : 'Stop'}
                  </button>
                ) : (
                  <button onClick={handleTestSovitsVoice}
                    disabled={isTesting || genieStatus !== 'ready' || !ttsConfig.sovitsRefAudioDir}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-xl ka-copy-sm font-semibold transition-colors ${
                      isTesting ? 'opacity-50 cursor-wait' : ''
                    } ${genieStatus === 'ready' && ttsConfig.sovitsRefAudioDir
                        ? (isDarkMode ? 'bg-[#3a2f1e] hover:bg-[#4a3c28] text-[#d4a852] border border-[#5a4630]' : 'bg-white hover:bg-[#faf5ee] text-[#6f5438] border border-[#e6ddcf]')
                        : isDarkMode ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    }`}>
                    {isTesting ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
                    {isTesting ? (language === 'zh' ? '合成中...' : 'Synthesizing...') : (language === 'zh' ? '测试语音' : 'Test Voice')}
                  </button>
                )}
              </div>

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
                    <button onClick={stopTestVoicePlayback} className="ml-auto p-1 rounded hover:bg-amber-500/20">
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
              {testStatus === 'error' && testError && (
                <div className="ka-micro text-red-400 bg-red-500/10 rounded px-2 py-1.5 leading-relaxed break-words">
                  <div className="font-semibold">
                    {renderTtsErrorKindLabel(testError.kind, language)}
                    {typeof testError.status === 'number' ? ` (${testError.status})` : ''}
                  </div>
                  <div className="mt-0.5 font-mono opacity-80">
                    {(t as any).ttsErrorServerMessage}: {testError.message}
                  </div>
                </div>
              )}

              <div className={`${helperClass} leading-relaxed`}>
                {isLinuxHost
                  ? (language === 'zh'
                      ? '启动后不会弹出独立控制台窗口（SoVITS 作为后台进程运行）。点击"停止服务器"可结束进程组。'
                      : 'No separate console window appears on Linux — SoVITS runs as a background process. Use "Stop Server" to terminate the process group.')
                  : (language === 'zh'
                      ? '启动后将弹出命令行窗口，可查看加载进度。关闭窗口即停止服务器。'
                      : 'A console window will appear showing loading progress. Closing it stops the server.')}
              </div>

              {genieError && (
                <div className="ka-micro text-red-400 bg-red-500/10 rounded px-2 py-1.5">{genieError}</div>
              )}

              <div className="mt-1">
                <button
                  type="button"
                  onClick={() => setShowAdvancedSovits(!showAdvancedSovits)}
                  className={`flex items-center gap-1.5 ka-micro font-semibold transition-colors ${isDarkMode ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  <Settings2 size={12} />
                  {language === 'zh' ? '高级推理参数' : 'Advanced Inference Params'}
                  {showAdvancedSovits ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>

                {showAdvancedSovits && (
                  <div className="mt-2 flex flex-col gap-3 pl-1">
                    <div className="flex items-center justify-between">
                      <span className={`${helperClass}`}>{language === 'zh' ? '不懂就用默认值' : 'Use defaults if unsure'}</span>
                      <button
                        type="button"
                        onClick={() => update({
                          sovitsTopK: DEFAULT_TTS_CONFIG.sovitsTopK,
                          sovitsTopP: DEFAULT_TTS_CONFIG.sovitsTopP,
                          sovitsTemperature: DEFAULT_TTS_CONFIG.sovitsTemperature,
                          sovitsTextSplitMethod: DEFAULT_TTS_CONFIG.sovitsTextSplitMethod,
                          sovitsFragmentInterval: DEFAULT_TTS_CONFIG.sovitsFragmentInterval,
                        })}
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ka-micro font-semibold transition-colors ${resetButtonClass}`}
                      >
                        <RotateCcw size={10} />
                        {language === 'zh' ? '恢复默认' : 'Reset'}
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className={fieldLabelClass}>{language === 'zh' ? '切分方式' : 'Split Method'}</label>
                        <ThemedSelect
                          value={ttsConfig.sovitsTextSplitMethod || 'cut0'}
                          onChange={(val) => update({ sovitsTextSplitMethod: val })}
                          options={sovitsSplitOptions}
                          isDarkMode={isDarkMode}
                          className={`${inputClass} mt-1`}
                          ariaLabel={language === 'zh' ? '切分方式' : 'Split Method'}
                        />
                      </div>
                      <div>
                        <label className={fieldLabelClass}>{language === 'zh' ? '句间停顿 (秒)' : 'Fragment Interval (s)'}</label>
                        <input type="number" step="0.1" min="0" max="2"
                          value={ttsConfig.sovitsFragmentInterval ?? 0.3}
                          onChange={e => update({ sovitsFragmentInterval: parseFloat(e.target.value) || 0.3 })}
                          className={`${inputClass} w-full mt-1`} />
                      </div>
                    </div>

                    <div>
                      <label className={fieldLabelClass}>top_k: {ttsConfig.sovitsTopK ?? 15}</label>
                      <input type="range" min="1" max="50" step="1" value={ttsConfig.sovitsTopK ?? 15}
                        onChange={e => update({ sovitsTopK: parseInt(e.target.value) })}
                        className="w-full mt-1 accent-[#c79a2f]" />
                    </div>
                    <div>
                      <label className={fieldLabelClass}>top_p: {(ttsConfig.sovitsTopP ?? 1).toFixed(2)}</label>
                      <input type="range" min="0" max="1" step="0.05" value={ttsConfig.sovitsTopP ?? 1}
                        onChange={e => update({ sovitsTopP: parseFloat(e.target.value) })}
                        className="w-full mt-1 accent-[#c79a2f]" />
                    </div>
                    <div>
                      <label className={fieldLabelClass}>temperature: {(ttsConfig.sovitsTemperature ?? 1).toFixed(2)}</label>
                      <input type="range" min="0" max="1" step="0.05" value={ttsConfig.sovitsTemperature ?? 1}
                        onChange={e => update({ sovitsTemperature: parseFloat(e.target.value) })}
                        className="w-full mt-1 accent-[#c79a2f]" />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {(ttsConfig.ttsBackend || 'fish') === 'fish' && (
            <>
          <div>
            <label className={fieldLabelClass}>{t.ttsFishApiKey}</label>
            <ComposableInput type="password" value={ttsConfig.fishAudioApiKey} onChange={e => update({ fishAudioApiKey: e.target.value })}
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
            <ComposableInput type="text" value={ttsConfig.fishAudioReferenceId} onChange={e => update({ fishAudioReferenceId: e.target.value })}
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
              <ThemedSelect
                value={ttsConfig.fishAudioModel}
                onChange={(val) => update({ fishAudioModel: val as 's1' | 's2-pro' })}
                options={fishModelOptions}
                isDarkMode={isDarkMode}
                className={`${inputClass} mt-1`}
                ariaLabel={t.ttsFishModel}
              />
            </div>
            <div className="flex-1">
              <label className={fieldLabelClass}>{t.ttsLatency}</label>
              <ThemedSelect
                value={ttsConfig.latency}
                onChange={(val) => update({ latency: val as 'balanced' | 'normal' })}
                options={fishLatencyOptions}
                isDarkMode={isDarkMode}
                className={`${inputClass} mt-1`}
                ariaLabel={t.ttsLatency}
              />
            </div>
          </div>

          {testStatus === 'playing' ? (
            <button onClick={stopTestVoicePlayback}
              className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl ka-copy-sm font-semibold transition-colors ${
                isDarkMode ? 'bg-sky-600 hover:bg-sky-700 text-white' : 'bg-sky-500 hover:bg-sky-600 text-white'
              }`}>
              <Square size={14} />
              {language === 'zh' ? '停止播放' : 'Stop'}
            </button>
          ) : (
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
                <button onClick={stopTestVoicePlayback} className="ml-auto p-1 rounded hover:bg-amber-500/20">
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
          {testStatus === 'error' && testError && (
            <div className="ka-micro text-red-400 bg-red-500/10 rounded px-2 py-1.5 leading-relaxed break-words">
              <div className="font-semibold">
                {renderTtsErrorKindLabel(testError.kind, language)}
                {typeof testError.status === 'number' ? ` (${testError.status})` : ''}
              </div>
              <div className="mt-0.5 font-mono opacity-80">
                {(t as any).ttsErrorServerMessage}: {testError.message}
              </div>
            </div>
          )}

            </>
          )}

          {(ttsConfig.ttsBackend || 'fish') === 'vocu' && (
            <div className={`${innerCardClass} p-4 rounded-[1.15rem] flex flex-col gap-3`}>
              <div className="flex items-center justify-between">
                <div className={fieldLabelClass}>{language === 'zh' ? 'Vocu AI 配置' : 'Vocu AI Config'}</div>
                <button
                  type="button"
                  onClick={() => openExternalUrl('https://www.vocu.ai/apiKey')}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ka-micro transition-colors ${externalLinkClass}`}
                >
                  <ExternalLink size={11} />
                  vocu.ai
                </button>
              </div>

              <div>
                <label className={fieldLabelClass}>{(t as any).ttsVocuApiKey || 'Vocu AI API Key'}</label>
                <ComposableInput
                  type="password"
                  value={ttsConfig.vocuApiKey || ''}
                  onChange={e => update({ vocuApiKey: e.target.value })}
                  className={`${inputClass} w-full mt-1`}
                  placeholder="voc-..."
                />
              </div>

              <div>
                <div className="flex items-center justify-between gap-3">
                  <label className={fieldLabelClass}>{(t as any).ttsVocuVoiceId || 'Vocu Voice ID'}</label>
                  <button
                    type="button"
                    onClick={handleResetVocuVoiceId}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ka-micro font-semibold transition-colors ${resetButtonClass}`}
                  >
                    <RotateCcw size={11} />
                    {language === 'zh' ? '恢复默认久美子 ID' : 'Restore Kumiko Default ID'}
                  </button>
                </div>
                <ComposableInput
                  type="text"
                  value={ttsConfig.vocuVoiceId || ''}
                  onChange={e => update({ vocuVoiceId: e.target.value })}
                  className={`${inputClass} w-full mt-1`}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                />
                <div className={`${helperClass} mt-0.5`}>
                  {(t as any).ttsVocuVoiceIdHint || 'Copy the UUID after creating/selecting a voice on vocu.ai'}
                </div>
              </div>

              <div>
                <label className={fieldLabelClass}>{(t as any).ttsVocuPromptId || 'Prompt ID'}</label>
                <ComposableInput
                  type="text"
                  value={ttsConfig.vocuPromptId ?? 'default'}
                  onChange={e => update({ vocuPromptId: e.target.value })}
                  className={`${inputClass} w-full mt-1`}
                  placeholder="default"
                />
                <div className={`${helperClass} mt-0.5`}>
                  {(t as any).ttsVocuPromptIdHint || "Default 'default'; override for special emotion/style"}
                </div>
              </div>

              <div>
                <label className={fieldLabelClass}>{(t as any).ttsVocuPreset || 'Preset'}</label>
                <ThemedSelect
                  value={ttsConfig.vocuPreset || 'balance'}
                  onChange={(val) => update({ vocuPreset: val as 'balance' | 'vivid' })}
                  options={vocuPresetOptions}
                  isDarkMode={isDarkMode}
                  className={`${inputClass} mt-1`}
                  ariaLabel={(t as any).ttsVocuPreset || 'Preset'}
                />
              </div>

              <div className={`mt-1 rounded-xl border p-3 ${isDarkMode ? 'bg-[#1a1714] border-[#a88247]/55' : 'bg-white/70 border-[#e6ddcf]'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 pr-2 flex-1">
                    <label className={fieldLabelClass}>{(t as any).ttsVocuFlash || 'Low-latency mode'}</label>
                    <p className={`${helperClass} mt-1`}>
                      {(t as any).ttsVocuFlashDesc || 'Faster generation, may slightly reduce quality'}
                    </p>
                  </div>
                  <div className="flex-shrink-0 pt-0.5">
                    <SettingsToggle
                      checked={Boolean(ttsConfig.vocuFlash)}
                      onClick={() => update({ vocuFlash: !ttsConfig.vocuFlash })}
                      activeTrackClass={isDarkMode ? 'bg-sky-600/80' : 'bg-sky-500/90'}
                      inactiveTrackClass={isDarkMode ? 'bg-[#3e3429]' : 'bg-[#d7d2ca]'}
                      ariaLabel={(t as any).ttsVocuFlash || 'Low-latency mode'}
                    />
                  </div>
                </div>
              </div>

              <div className={`rounded-xl border p-3 ${isDarkMode ? 'bg-[#1a1714] border-[#a88247]/55' : 'bg-white/70 border-[#e6ddcf]'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 pr-2 flex-1">
                    <label className={fieldLabelClass}>{(t as any).ttsVocuEmotionBoost || 'Emotional expression boost'}</label>
                    <p className={`${helperClass} mt-1`}>
                      {(t as any).ttsVocuEmotionBoostDesc || 'V3.0 voices only; when enabled, happy/angry/sad/surprised switch to vivid preset automatically (others stay on balance)'}
                    </p>
                  </div>
                  <div className="flex-shrink-0 pt-0.5">
                    <SettingsToggle
                      checked={Boolean(ttsConfig.vocuEmotionBoost)}
                      onClick={() => update({ vocuEmotionBoost: !ttsConfig.vocuEmotionBoost })}
                      activeTrackClass={isDarkMode ? 'bg-amber-600/80' : 'bg-amber-500/90'}
                      inactiveTrackClass={isDarkMode ? 'bg-[#3e3429]' : 'bg-[#d7d2ca]'}
                      ariaLabel={(t as any).ttsVocuEmotionBoost || 'Emotional expression boost'}
                    />
                  </div>
                </div>
              </div>

              {testStatus === 'playing' ? (
                <button
                  onClick={stopTestVoicePlayback}
                  className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl ka-copy-sm font-semibold transition-colors ${
                    isDarkMode ? 'bg-sky-600 hover:bg-sky-700 text-white' : 'bg-sky-500 hover:bg-sky-600 text-white'
                  }`}>
                  <Square size={14} />
                  {language === 'zh' ? '停止播放' : 'Stop'}
                </button>
              ) : (
                <button
                  onClick={handleTestVocuVoice}
                  disabled={isTesting || !ttsConfig.vocuApiKey || !ttsConfig.vocuVoiceId}
                  className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl ka-copy-sm font-semibold transition-colors ${
                    isTesting ? 'opacity-50 cursor-wait' : ''
                  } ${ttsConfig.vocuApiKey && ttsConfig.vocuVoiceId
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
                    <button onClick={stopTestVoicePlayback} className="ml-auto p-1 rounded hover:bg-amber-500/20">
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
              {testStatus === 'error' && testError && (
                <div className="ka-micro text-red-400 bg-red-500/10 rounded px-2 py-1.5 leading-relaxed break-words">
                  <div className="font-semibold">
                    {renderTtsErrorKindLabel(testError.kind, language)}
                    {typeof testError.status === 'number' ? ` (${testError.status})` : ''}
                  </div>
                  <div className="mt-0.5 font-mono opacity-80">
                    {(t as any).ttsErrorServerMessage}: {testError.message}
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between gap-3">
              <label className={fieldLabelClass}>{t.ttsSpeed}: {ttsConfig.speed.toFixed(1)}x</label>
              {Math.abs(ttsConfig.speed - 1.0) > 0.001 && (
                <button
                  type="button"
                  onClick={() => update({ speed: 1.0 })}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition ${
                    isDarkMode
                      ? 'border-[#4e3d2e]/55 bg-[#241a12] text-[#d4c1a3] hover:bg-[#2c2118]'
                      : 'border-[#e8dfd1] bg-white/90 text-[#7a5d3a] hover:bg-[#fbf6ec]'
                  }`}
                >
                  <RotateCcw size={12} />
                  {(t as any).ttsSpeedRestore}
                </button>
              )}
            </div>
            <input type="range" min="0.5" max="2.0" step="0.1" value={ttsConfig.speed}
              onChange={e => update({ speed: parseFloat(e.target.value) })}
              className="w-full mt-1 accent-[#c79a2f]" />
            {(ttsConfig.speed < 0.7 || ttsConfig.speed > 1.5) && (
              <p className={`${helperClass} mt-1.5`}>
                {(t as any).ttsSpeedOutOfRangeHint}
              </p>
            )}
          </div>
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

        </div>
      </Collapse>

      <SovitsRefPromptEditorModal
        isOpen={showSovitsPromptEditor}
        onClose={() => setShowSovitsPromptEditor(false)}
        language={language}
        isDarkMode={isDarkMode}
        refTextEnabled={sovitsUseRefTextEffective}
        initialPrompts={ttsConfig.sovitsCustomPrompts ?? {}}
        onSave={(next) => update({ sovitsCustomPrompts: next })}
      />
    </div>
  );
};
