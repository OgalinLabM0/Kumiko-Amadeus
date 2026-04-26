// components/onboarding/PermissionOnboardingWizard.tsx
//
// v2.14.23: first-launch Android permission walkthrough. The wizard
// drives the user through the seven settings that determine whether
// scheduled reminders + voice-call FSI actually work after the app is
// killed / locked / rebooted. We deliberately avoid the "passive
// settings page" approach because v2.14.22's analytics show users
// only flip ~half the toggles when left alone in 设置 → Android 权限
// 体检.
//
// Flow (one card per step, auto-advances on state change):
//   1. 通知总权限 (POST_NOTIFICATIONS, Android 13+)
//   2. 精准闹钟 (SCHEDULE_EXACT_ALARM, Android 12+)
//   3. 全屏来电 (USE_FULL_SCREEN_INTENT, Android 14+)
//   4. 电池优化白名单 (REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
//   5. 自管理通话账户 (Telecom self-managed PhoneAccount)
//   6. OEM 后台行为 (deep-link to vendor settings: MIUI 自启动 / EMUI 启动管理 /
//      One UI Sleeping apps / etc.)
//   7. 接听回放校验 (60s self-test placeholder reminder; user locks screen
//      and waits, wizard collects the four-stage report on resume)
//
// The wizard is mounted from App.tsx as a full-screen modal overlay
// when (a) we're on Capacitor Android, AND (b) the localStorage flag
// `kumiko_android_onboarding_v2_done` is unset. Setting prefers
// "this user has already finished the wizard once" over "every cold
// start re-runs it" because the latter is a UX disaster.
//
// Re-launchable: SettingsPanel exposes a "重新走一遍 / Walk me through
// again" button that clears the flag + remounts.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, ChevronLeft, ChevronRight, ExternalLink, X, AlertTriangle, Check, Clock, Info, PhoneCall, RefreshCw } from 'lucide-react';
import type { Language } from '../../types';
import {
  getAndroidAlertPermissionSnapshot,
  openAndroidAlertPermissionSettings,
  requestAndroidNotificationPermission,
  runAndroidIncomingCallTest,
  runAndroidMessageNotificationTest,
  type AndroidAlertPermissionKey,
  type AndroidAlertPermissionSnapshot,
  type AndroidAlertPermissionState,
  type AndroidAlertTestResult,
  type OemVendor,
} from '../../services/androidAlertPermissionService';
import {
  collectKumikoSelfTestReport,
  openVendorPermissionSetting,
  scheduleAndroidAlarm,
  cancelAndroidAlarm,
  startKumikoSelfTestProbe,
  type AlarmSelfTestReport,
  type VendorPermissionKey,
} from '../../services/androidAlarmService';
import { isCapacitorNative } from '../../services/environment';

const ONBOARDING_FLAG_KEY = 'kumiko_android_onboarding_v2_done';

export const isAndroidOnboardingCompleted = (): boolean => {
  try { return localStorage.getItem(ONBOARDING_FLAG_KEY) === '1'; } catch { return true; }
};

export const markAndroidOnboardingCompleted = (): void => {
  try { localStorage.setItem(ONBOARDING_FLAG_KEY, '1'); } catch { /* ignore */ }
};

export const resetAndroidOnboardingFlag = (): void => {
  try { localStorage.removeItem(ONBOARDING_FLAG_KEY); } catch { /* ignore */ }
};

type StepKind =
  | 'notifications'
  | 'exactAlarm'
  | 'fullScreenIntent'
  | 'batteryOptimizations'
  | 'phoneAccount'
  | 'oemBackground'
  | 'selfTest';

interface StepCopy {
  zh: { title: string; why: string; cta: string; tip: string };
  en: { title: string; why: string; cta: string; tip: string };
}

const STEP_COPY: Record<StepKind, StepCopy> = {
  notifications: {
    zh: {
      title: '允许通知',
      why: '没有通知权限,Kumiko 完全没办法在锁屏 / 后台告诉你「该出现了」。这是所有提醒的前提。',
      cta: '允许通知',
      tip: '系统会弹一次「Kumiko·Amadeus 想发送通知?」,选「允许」。',
    },
    en: {
      title: 'Allow notifications',
      why: 'Without notification permission, Kumiko can\'t reach you when the app is closed or the screen is locked. Every other reminder feature depends on this.',
      cta: 'Allow notifications',
      tip: 'Tap "Allow" in the system prompt that follows.',
    },
  },
  exactAlarm: {
    zh: {
      title: '精准闹钟',
      why: 'Android 12+ 的「精准闹钟」决定 Kumiko 的提醒是不是按你设的时间点准时触发。关掉就会被随机延迟 5–15 分钟。',
      cta: '打开精准闹钟设置',
      tip: '把「Kumiko·Amadeus」开关拨到右边,然后返回。',
    },
    en: {
      title: 'Exact alarms',
      why: 'On Android 12+, exact-alarm permission decides whether reminders fire at the time you set, or get randomly delayed by 5–15 minutes.',
      cta: 'Open exact-alarm settings',
      tip: 'Toggle Kumiko·Amadeus on, then come back.',
    },
  },
  fullScreenIntent: {
    zh: {
      title: '全屏来电通知',
      why: 'Android 14+ 上「全屏意图」是 Kumiko 在锁屏铺满全屏弹「来电」的唯一合法路径。关闭=只有横幅,不抢屏、不响铃。',
      cta: '打开全屏意图设置',
      tip: '开关亮起后返回,我会自动检测。',
    },
    en: {
      title: 'Full-screen call display',
      why: 'On Android 14+, full-screen-intent permission is the only sanctioned way for Kumiko to render a full-screen incoming-call card on the lock screen. Without it you get a banner only — no ringing, no auto-foreground.',
      cta: 'Open full-screen settings',
      tip: 'Flip the switch on and return. I\'ll detect the change automatically.',
    },
  },
  batteryOptimizations: {
    zh: {
      title: '加入电池白名单',
      why: '默认 Android 会在锁屏 30 分钟后冻结 Kumiko 的进程,导致提醒延迟甚至不触发。把 Kumiko 加进电池白名单可以显著减少漂移。',
      cta: '申请白名单',
      tip: '系统弹「忽略电池优化?」选「是」即可。',
    },
    en: {
      title: 'Battery optimisation allowlist',
      why: 'Android freezes Kumiko\'s process after about 30 minutes locked, which makes reminders late or skip entirely. Whitelisting reduces this drift dramatically.',
      cta: 'Request allowlist',
      tip: 'Tap "Yes" on the "Ignore battery optimisations?" prompt.',
    },
  },
  phoneAccount: {
    zh: {
      title: '通话账户',
      why: '注册 Kumiko 的「来电账户」之后,系统会用电话级别的通话样式渲染来电卡片,在小米/华为等激进 ROM 上更稳定。可选,关掉也能用旧版来电界面,只是不那么可靠。',
      cta: '注册并打开通话设置',
      tip: '在通话账户列表里找到 Kumiko·Amadeus,把开关打开。',
    },
    en: {
      title: 'Phone account',
      why: 'Registering Kumiko\'s call account lets the system render incoming calls with the same Telecom UI as native dialers — much more reliable on Xiaomi / Huawei. Optional; without it the legacy FSI activity still works, just less reliably.',
      cta: 'Register & open call accounts',
      tip: 'Find "Kumiko·Amadeus" in the list and enable it.',
    },
  },
  oemBackground: {
    zh: {
      title: '厂商后台行为',
      why: '小米/华为/三星/OPPO/vivo 在系统通知/精准闹钟之外还有一层私有限制(自启动/锁屏弹窗/不休眠应用)。这一步直达你设备品牌对应的关键开关。',
      cta: '打开厂商设置',
      tip: '把 Kumiko 加进对应清单,返回即可。',
    },
    en: {
      title: 'OEM background behaviour',
      why: 'Xiaomi / Huawei / Samsung / OPPO / vivo layer their own restrictions on top of AOSP (auto-start, lock-screen pop-up, never-sleeping apps). This step jumps to the screen most relevant for your brand.',
      cta: 'Open vendor settings',
      tip: 'Add Kumiko to the relevant list, then come back.',
    },
  },
  selfTest: {
    zh: {
      title: '锁屏 60 秒接听回放校验',
      why: '我会安排一个 60 秒后的占位提醒。请把屏幕锁上、放手机不动,等到响起按「接听」。等你回到 app 我会告诉你哪一段成功、哪一段没到。',
      cta: '开始 60 秒校验',
      tip: '锁屏后不要打开任何 app,等响铃时按接听。',
    },
    en: {
      title: 'Locked 60-second accept-playback test',
      why: 'I\'ll arm a placeholder reminder 60 seconds out. Lock your screen, leave the phone alone, and tap Accept when it rings. When you come back I\'ll show which stages worked.',
      cta: 'Start 60s test',
      tip: 'Don\'t open any apps after locking — tap Accept when it rings.',
    },
  },
};

interface PermissionOnboardingWizardProps {
  language: Language;
  onClose: () => void;
  /** v2.14.24: forwarded from App.tsx ttsConfig.ringtoneFileId so the inline
   *  "立即推送一次测试来电" button can ring the user's configured ringtone,
   *  matching the production reminder-call experience. */
  ringtoneFileId?: string | null;
}

// v2.14.24: copy for the inline "立即测试" buttons added to the notifications
// and selfTest steps. These let the user verify a notification actually
// shows up without first walking through the entire 60-second deep self
// test — which is the most common reason users gave up on the wizard in
// v2.14.23 ("我不知道是不是已经能用了").
const TEST_COPY = {
  zh: {
    msgButton: '立即推送一条测试通知',
    callButton: '立即推送一次测试来电',
    busy: '测试中…',
    posted: '已下发,请在系统通知栏确认是否真的弹出+短震动。',
    callPosted: '已下发,请确认是否弹出来电卡片+长震动+铃声。',
    failed: '测试未通过,请回到上面把权限项配置好。',
    nativeFailed: '系统拒绝了测试,请检查通知权限或厂商后台限制。',
    timeout: '6 秒内未收到系统回执,请重试或检查 OEM 后台限制。',
    notificationsHint: '建议先在第 1 步把通知权限打开,否则测试也不会有声音。',
    callHint: '建议先在第 3 步把全屏来电打开,这次只测能不能弹出来电卡片。',
  },
  en: {
    msgButton: 'Send a test notification now',
    callButton: 'Trigger a test incoming call now',
    busy: 'Testing…',
    posted: 'Submitted — verify a heads-up + short vibration appeared in the system tray.',
    callPosted: 'Submitted — verify the call card + long vibration + ringtone appeared.',
    failed: 'Test failed. Fix the highlighted permission first.',
    nativeFailed: 'Android rejected the test. Check notification permission or OEM background restrictions.',
    timeout: 'No system response within 6s. Retry or check OEM background restrictions.',
    notificationsHint: 'Tip: enable notification permission in step 1 first; otherwise the test will be silent.',
    callHint: 'Tip: grant full-screen call permission in step 3 first. This only verifies the call card pops.',
  },
} as const;

export const PermissionOnboardingWizard: React.FC<PermissionOnboardingWizardProps> = ({ language, onClose, ringtoneFileId }) => {
  const [snapshot, setSnapshot] = useState<AndroidAlertPermissionSnapshot | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<Set<StepKind>>(new Set());
  const [selfTestStage, setSelfTestStage] = useState<'idle' | 'arming' | 'waiting' | 'collected'>('idle');
  const [selfTestReport, setSelfTestReport] = useState<AlarmSelfTestReport | null>(null);
  const [selfTestStartedAt, setSelfTestStartedAt] = useState<number | null>(null);
  // v2.14.24: inline test feedback. testKind selects the most-recent button
  // pressed; testStatus drives the visual state machine; testMessage is the
  // human-readable result line displayed below the buttons.
  const [testKind, setTestKind] = useState<'message' | 'call' | null>(null);
  const [testStatus, setTestStatus] = useState<'idle' | 'busy' | 'done'>('idle');
  const [testMessage, setTestMessage] = useState<string>('');
  const probeReminderIdRef = useRef<string | null>(null);
  const ttRef = useRef<number | null>(null);

  const refreshSnapshot = useCallback(async () => {
    try {
      const next = await getAndroidAlertPermissionSnapshot();
      setSnapshot(next);
    } catch (e) {
      console.warn('[onboardingWizard] refresh snapshot failed:', e);
    }
  }, []);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  // Re-probe whenever the app resumes. Users will be flipping toggles
  // in system settings then coming back; that's the moment we need a
  // fresh snapshot to advance the wizard.
  useEffect(() => {
    if (!isCapacitorNative()) return;
    let detach: (() => void) | null = null;
    void (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const sub = await App.addListener('appStateChange', (s) => {
          if (s.isActive) void refreshSnapshot();
        });
        detach = () => sub.remove();
      } catch (e) {
        console.warn('[onboardingWizard] App listener failed:', e);
      }
    })();
    return () => { try { detach?.(); } catch { /* ignore */ } };
  }, [refreshSnapshot]);

  const oemVendor: OemVendor = snapshot?.oem?.vendor || 'unknown';

  const oemStep = useMemo(() => {
    const v = oemVendor;
    let key: VendorPermissionKey | null = null;
    if (v === 'xiaomi') key = 'xiaomi.permEditor';
    else if (v === 'huawei') key = 'huawei.startup';
    else if (v === 'honor') key = 'honor.protectedApps';
    else if (v === 'samsung') key = 'samsung.sleepingApps';
    else if (v === 'oppo') key = 'oppo.startup';
    else if (v === 'realme') key = 'realme.startup';
    else if (v === 'vivo') key = 'vivo.backgroundStartup';
    else if (v === 'oneplus') key = 'oneplus.startup';
    else key = 'generic.appDetails';
    return key;
  }, [oemVendor]);

  const stepStateFor = (kind: StepKind): AndroidAlertPermissionState | 'optional' => {
    if (!snapshot) return 'unknown';
    const map: Record<Exclude<StepKind, 'oemBackground' | 'selfTest'>, AndroidAlertPermissionKey> = {
      notifications: 'notifications',
      exactAlarm: 'exactAlarm',
      fullScreenIntent: 'fullScreenIntent',
      batteryOptimizations: 'batteryOptimizations',
      phoneAccount: 'phoneAccount',
    };
    if (kind === 'oemBackground' || kind === 'selfTest') return 'optional';
    return snapshot.items[map[kind]].state;
  };

  const allSteps: StepKind[] = [
    'notifications', 'exactAlarm', 'fullScreenIntent',
    'batteryOptimizations', 'phoneAccount', 'oemBackground', 'selfTest',
  ];

  const currentStep = allSteps[stepIndex];

  const handlePrimary = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      switch (currentStep) {
        case 'notifications':
          await requestAndroidNotificationPermission();
          break;
        case 'exactAlarm':
          await openAndroidAlertPermissionSettings('exactAlarm');
          break;
        case 'fullScreenIntent':
          await openAndroidAlertPermissionSettings('fullScreenIntent');
          break;
        case 'batteryOptimizations':
          await openAndroidAlertPermissionSettings('batteryOptimizations');
          break;
        case 'phoneAccount':
          await openAndroidAlertPermissionSettings('phoneAccount');
          break;
        case 'oemBackground':
          if (oemStep) {
            await openVendorPermissionSetting(oemStep);
          }
          break;
        case 'selfTest':
          await runSelfTest();
          break;
      }
      await refreshSnapshot();
    } catch (e) {
      console.warn('[onboardingWizard] primary action failed:', e);
    } finally {
      setBusy(false);
    }
  }, [busy, currentStep, oemStep, refreshSnapshot]);

  const runSelfTest = useCallback(async () => {
    setSelfTestStage('arming');
    setSelfTestReport(null);
    const reminderId = `onboarding-selftest-${Date.now()}`;
    probeReminderIdRef.current = reminderId;
    try {
      await startKumikoSelfTestProbe(reminderId);
      const triggerAt = Date.now() + 60_000;
      await scheduleAndroidAlarm({
        reminderId,
        at: triggerAt,
        event: language === 'zh' ? '深度自检' : 'Self-test',
        text: language === 'zh' ? '锁屏 60 秒后会响,响起后按接听' : 'Locks for 60s, tap Accept when it rings',
        wantsCall: true,
        ringtoneFileId: '',
      });
      setSelfTestStartedAt(Date.now());
      setSelfTestStage('waiting');
    } catch (e) {
      console.warn('[onboardingWizard] self-test arm failed:', e);
      setSelfTestStage('idle');
      probeReminderIdRef.current = null;
    }
  }, [language]);

  // v2.14.24: inline message/call test triggers. Reuse the same native
  // postTestMessageNotification / postTestIncomingCall paths as the
  // settings panel — single source of truth, both surfaces verify the
  // exact same channels.
  const interpretTestResult = useCallback((result: AndroidAlertTestResult, kind: 'message' | 'call'): string => {
    const t = TEST_COPY[language === 'zh' ? 'zh' : 'en'];
    if (result.ok) return kind === 'message' ? t.posted : t.callPosted;
    if (result.reason === 'timeout') return t.timeout;
    if (result.reason === 'native-failed') return t.nativeFailed;
    return t.failed;
  }, [language]);

  const runMessageTest = useCallback(async () => {
    setTestKind('message');
    setTestStatus('busy');
    setTestMessage(TEST_COPY[language === 'zh' ? 'zh' : 'en'].busy);
    try {
      const result = await runAndroidMessageNotificationTest();
      setTestMessage(interpretTestResult(result, 'message'));
    } catch (e) {
      console.warn('[onboardingWizard] runMessageTest failed:', e);
      setTestMessage(TEST_COPY[language === 'zh' ? 'zh' : 'en'].nativeFailed);
    } finally {
      setTestStatus('done');
    }
  }, [interpretTestResult, language]);

  const runCallTest = useCallback(async () => {
    setTestKind('call');
    setTestStatus('busy');
    setTestMessage(TEST_COPY[language === 'zh' ? 'zh' : 'en'].busy);
    try {
      const result = await runAndroidIncomingCallTest(ringtoneFileId);
      setTestMessage(interpretTestResult(result, 'call'));
    } catch (e) {
      console.warn('[onboardingWizard] runCallTest failed:', e);
      setTestMessage(TEST_COPY[language === 'zh' ? 'zh' : 'en'].nativeFailed);
    } finally {
      setTestStatus('done');
    }
  }, [interpretTestResult, language, ringtoneFileId]);

  const collectReport = useCallback(async () => {
    const id = probeReminderIdRef.current;
    if (!id) return;
    try {
      const r = await collectKumikoSelfTestReport();
      setSelfTestReport(r);
      setSelfTestStage('collected');
      try { await cancelAndroidAlarm(id); } catch { /* ignore */ }
    } catch (e) {
      console.warn('[onboardingWizard] collect report failed:', e);
    }
  }, []);

  // Auto-collect the self-test report on app resume after we've armed it.
  useEffect(() => {
    if (selfTestStage !== 'waiting') return;
    if (!isCapacitorNative()) return;
    let detach: (() => void) | null = null;
    void (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const sub = await App.addListener('appStateChange', (s) => {
          if (s.isActive && Date.now() - (selfTestStartedAt || 0) > 30_000) {
            void collectReport();
          }
        });
        detach = () => sub.remove();
      } catch (e) {
        console.warn('[onboardingWizard] selfTest App listener failed:', e);
      }
    })();
    return () => { try { detach?.(); } catch { /* ignore */ } };
  }, [selfTestStage, selfTestStartedAt, collectReport]);

  // Progress timer for waiting stage
  useEffect(() => {
    if (selfTestStage !== 'waiting' || !selfTestStartedAt) return;
    const tick = () => {
      const elapsed = Date.now() - selfTestStartedAt;
      if (elapsed > 90_000) {
        // 90s without resume: auto-collect anyway so the user isn't
        // stuck staring at a "锁屏中" UI.
        void collectReport();
        return;
      }
      ttRef.current = window.setTimeout(tick, 1000);
    };
    ttRef.current = window.setTimeout(tick, 1000);
    return () => { if (ttRef.current) window.clearTimeout(ttRef.current); };
  }, [selfTestStage, selfTestStartedAt, collectReport]);

  const isCurrentSatisfied = (): boolean => {
    const k = currentStep;
    if (k === 'selfTest') return selfTestStage === 'collected';
    if (k === 'oemBackground') return skipped.has(k);
    const s = stepStateFor(k);
    if (s === 'granted') return true;
    if (s === 'unavailable') return true; // SDK doesn't apply
    return skipped.has(k);
  };

  const handleNext = () => {
    if (stepIndex < allSteps.length - 1) {
      setStepIndex(stepIndex + 1);
    } else {
      markAndroidOnboardingCompleted();
      onClose();
    }
  };

  const handleSkip = () => {
    setSkipped((s) => new Set(s).add(currentStep));
    handleNext();
  };

  const handleBack = () => {
    if (stepIndex > 0) setStepIndex(stepIndex - 1);
  };

  const copy = STEP_COPY[currentStep][language === 'zh' ? 'zh' : 'en'];

  const stateBadge = () => {
    if (currentStep === 'selfTest') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-blue-500/10 text-blue-300">
          {selfTestStage === 'idle' && <Clock size={12} />}
          {selfTestStage === 'arming' && <RefreshCw size={12} className="animate-spin" />}
          {selfTestStage === 'waiting' && <Clock size={12} />}
          {selfTestStage === 'collected' && <Check size={12} />}
          {selfTestStage === 'idle' && (language === 'zh' ? '未开始' : 'Idle')}
          {selfTestStage === 'arming' && (language === 'zh' ? '正在排程' : 'Arming')}
          {selfTestStage === 'waiting' && (language === 'zh' ? '锁屏等待中' : 'Waiting')}
          {selfTestStage === 'collected' && (language === 'zh' ? '已收报告' : 'Report ready')}
        </span>
      );
    }
    const s = stepStateFor(currentStep);
    if (s === 'granted') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-emerald-500/10 text-emerald-300">
          <Check size={12} />{language === 'zh' ? '已授予' : 'Granted'}
        </span>
      );
    }
    if (s === 'denied') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-red-500/10 text-red-300">
          <AlertTriangle size={12} />{language === 'zh' ? '未授予' : 'Not granted'}
        </span>
      );
    }
    if (s === 'optional') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-zinc-500/10 text-zinc-300">
          <Info size={12} />{language === 'zh' ? '可选项' : 'Optional'}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-zinc-500/10 text-zinc-400">
        <Clock size={12} />{language === 'zh' ? '需要测试' : 'Needs test'}
      </span>
    );
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md max-h-[90vh] overflow-y-auto bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl">
        <div className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur px-5 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-zinc-300">
            <span className="font-semibold">{language === 'zh' ? '后台与提醒授权' : 'Background & reminder setup'}</span>
            <span className="text-zinc-500">{stepIndex + 1} / {allSteps.length}</span>
          </div>
          <button
            onClick={() => { markAndroidOnboardingCompleted(); onClose(); }}
            className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400"
            aria-label={language === 'zh' ? '关闭引导' : 'Close wizard'}
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-zinc-100">{copy.title}</h2>
            {stateBadge()}
          </div>
          <p className="text-sm text-zinc-400 mb-3 leading-relaxed">{copy.why}</p>
          <p className="text-xs text-zinc-500 mb-4">{copy.tip}</p>

          {currentStep === 'selfTest' && selfTestStage === 'waiting' && selfTestStartedAt && (
            <div className="mb-4 p-3 bg-blue-500/5 border border-blue-500/20 rounded text-xs text-blue-200">
              {language === 'zh'
                ? '请现在锁屏并把手机放下,60 秒后会响。响起按「接听」,然后回到 app。'
                : 'Lock your phone now and put it down. It rings in 60 seconds — tap Accept and return.'}
            </div>
          )}

          {currentStep === 'selfTest' && selfTestStage === 'collected' && selfTestReport && (
            <div className="mb-4 p-3 bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-300 space-y-1">
              <div className="font-semibold text-zinc-200 mb-1">
                {language === 'zh' ? '自检报告' : 'Self-test report'}
              </div>
              <div>{language === 'zh' ? 'AlarmManager 触发: ' : 'AlarmManager fired: '}
                {selfTestReport.alarmFiredAt ? '✓' : '—'}
              </div>
              <div>{language === 'zh' ? '通知/来电卡片: ' : 'Notification / call card: '}
                {selfTestReport.notifPostedAt ? '✓' : '—'}
              </div>
              <div>{language === 'zh' ? '全屏来电界面启动: ' : 'Full-screen call UI launched: '}
                {selfTestReport.fsiLaunchedAt ? '✓' : '—'}
              </div>
              <div>{language === 'zh' ? '接听回放: ' : 'Accept playback: '}
                {selfTestReport.acceptReceivedAt ? '✓' : '—'}
              </div>
              {!selfTestReport.acceptReceivedAt && (
                <div className="pt-2 text-amber-300">
                  {language === 'zh'
                    ? '没收到接听信号 — 如果你确实按了接听,可能是「电池白名单」或「锁屏弹窗」还没开。建议返回上一步重新配。'
                    : 'No accept signal — if you did tap Accept, the battery allowlist or lock-screen pop-up may still be off. Try the previous steps again.'}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <button
              onClick={handlePrimary}
              disabled={busy || (currentStep === 'selfTest' && selfTestStage === 'waiting')}
              className="w-full px-4 py-2.5 bg-zinc-100 hover:bg-zinc-200 disabled:bg-zinc-700 disabled:text-zinc-400 text-zinc-900 rounded-lg flex items-center justify-center gap-2 text-sm font-medium transition-colors"
            >
              {busy ? <RefreshCw size={14} className="animate-spin" /> : <ExternalLink size={14} />}
              {copy.cta}
            </button>

            {/* v2.14.24: inline 即时测试 buttons. The notifications step lets
                you fire a real heads-up the moment you've granted permission;
                the selfTest step gives a 3-second proof-of-call before the
                heavyweight 60-second locked self-test. This shaves the
                "我开了权限,但不知道有没有用" feedback loop from minutes to
                seconds — the most common drop-off cause we saw in v2.14.23. */}
            {(currentStep === 'notifications' || currentStep === 'selfTest') && (
              <div className="mt-1 flex flex-col gap-1.5">
                {currentStep === 'notifications' && (
                  <button
                    onClick={runMessageTest}
                    disabled={testStatus === 'busy'}
                    className="w-full px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 text-zinc-100 rounded-lg flex items-center justify-center gap-2 text-sm transition-colors"
                  >
                    {testStatus === 'busy' && testKind === 'message' ? <RefreshCw size={14} className="animate-spin" /> : <BellRing size={14} />}
                    {TEST_COPY[language === 'zh' ? 'zh' : 'en'].msgButton}
                  </button>
                )}
                {currentStep === 'selfTest' && selfTestStage !== 'waiting' && (
                  <button
                    onClick={runCallTest}
                    disabled={testStatus === 'busy'}
                    className="w-full px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 text-zinc-100 rounded-lg flex items-center justify-center gap-2 text-sm transition-colors"
                  >
                    {testStatus === 'busy' && testKind === 'call' ? <RefreshCw size={14} className="animate-spin" /> : <PhoneCall size={14} />}
                    {TEST_COPY[language === 'zh' ? 'zh' : 'en'].callButton}
                  </button>
                )}
                {testKind && testMessage && (
                  <p className="text-xs text-zinc-400 leading-relaxed mt-1">
                    {testMessage}
                  </p>
                )}
                {currentStep === 'notifications' && stepStateFor('notifications') !== 'granted' && (
                  <p className="text-[11px] text-amber-300/85 leading-relaxed">
                    {TEST_COPY[language === 'zh' ? 'zh' : 'en'].notificationsHint}
                  </p>
                )}
                {currentStep === 'selfTest' && stepStateFor('fullScreenIntent') !== 'granted' && (
                  <p className="text-[11px] text-amber-300/85 leading-relaxed">
                    {TEST_COPY[language === 'zh' ? 'zh' : 'en'].callHint}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="sticky bottom-0 bg-zinc-950/95 backdrop-blur px-5 py-3 border-t border-zinc-800 flex items-center justify-between gap-2">
          <button
            onClick={handleBack}
            disabled={stepIndex === 0}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={14} />{language === 'zh' ? '上一步' : 'Back'}
          </button>
          <div className="flex items-center gap-1">
            {!isCurrentSatisfied() && currentStep !== 'selfTest' && (
              <button
                onClick={handleSkip}
                className="px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-300"
              >
                {language === 'zh' ? '跳过' : 'Skip'}
              </button>
            )}
            <button
              onClick={handleNext}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-100"
            >
              {stepIndex < allSteps.length - 1
                ? (language === 'zh' ? '下一步' : 'Next')
                : (language === 'zh' ? '完成' : 'Done')}
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PermissionOnboardingWizard;
