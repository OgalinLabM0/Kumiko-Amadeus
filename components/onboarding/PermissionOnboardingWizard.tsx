// components/onboarding/PermissionOnboardingWizard.tsx
//
// v2.14.27: rebuilt as a 3-step walkthrough aligned with the new permission
// model. The pre-v2.14.27 version had 7 steps + a deep self-test + OEM-vendor
// long copy + bridge-status banners; users gave up halfway because every
// extra step introduced doubt. Now:
//
//   1. Notifications (POST_NOTIFICATIONS, Android 13+)
//   2. Alarms & Display — combines exact alarm + full-screen call + battery
//      optimisation in one screen with three "Open Settings" buttons and
//      a single "Verify / Continue" CTA.
//   3. One-tap Test — fires a LocalNotifications message + call to verify
//      end-to-end delivery; the user can lock the screen first.
//
// The wizard mounts from App.tsx as a full-screen modal when on Capacitor
// Android AND the localStorage flag `kumiko_android_onboarding_v2_done` is
// unset. Once finished, the flag is set; SettingsPanel exposes
// `resetAndroidOnboardingFlag` for re-runs.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  PhoneCall,
  RefreshCw,
  X,
  Zap,
} from 'lucide-react';
import type { Language } from '../../types';
import {
  getPermissionStatusSnapshot,
  openAndroidAlertPermissionSettings,
  requestAndroidNotificationPermission,
  runAndroidIncomingCallTest,
  runAndroidMessageNotificationTest,
  type PermissionState,
  type PermissionStatusSnapshot,
} from '../../services/androidAlertPermissionService';
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

type StepKind = 'notifications' | 'alarmsAndDisplay' | 'oneClickTest';

const STEPS: StepKind[] = ['notifications', 'alarmsAndDisplay', 'oneClickTest'];

const COPY = {
  zh: {
    title: 'Android 权限引导',
    subtitle: (cur: number, total: number) => `第 ${cur} / ${total} 步`,
    skip: '跳过',
    back: '上一步',
    next: '下一步',
    verify: '验证',
    finish: '完成',
    close: '关闭',
    openSettings: '打开系统设置',
    notifications: {
      title: '允许通知',
      desc: '没有通知权限，Kumiko 完全无法在锁屏 / 后台告诉你「该出现了」。这是所有提醒的基础，必须开启。',
      cta: '允许通知',
      tip: '系统会弹一次「Kumiko·Amadeus 想发送通知?」，请选「允许」。',
      stateGranted: '通知权限已开启',
      stateDenied: '通知权限被拒绝',
      stateUnknown: '通知权限尚未确认',
    },
    alarmsAndDisplay: {
      title: '闹钟、来电、后台',
      desc: '把以下 3 个开关都打开后，定时提醒才能在锁屏 / 后台准点弹出。每个按钮跳转到对应的系统页，配置完返回本页点「验证」。',
      exactAlarmLabel: '精准闹钟',
      exactAlarmDesc: 'Android 12+ 决定提醒是否准点；关闭后会被随机延迟 5–15 分钟。',
      fullScreenLabel: '全屏来电',
      fullScreenDesc: 'Android 14+ 决定来电卡片能否覆盖锁屏；关闭后只有横幅，不抢屏。',
      batteryLabel: '电池优化白名单',
      batteryDesc: '把 Kumiko 加入「不限制后台」名单，避免长时间锁屏被休眠杀掉。',
      verify: '我已配置完，验证',
      verifying: '验证中…',
      partialNotice: '精准闹钟和全屏来电任一未开启会影响提醒可靠性；建议都开启再继续。',
      allGood: '✓ 验证通过：精准闹钟 + 全屏来电均已开启。',
      allGoodWithBattery: '电池优化白名单无法自动验证；如已加入,本步可继续。',
    },
    oneClickTest: {
      title: '一键测试',
      desc: '推送 1 条消息通知 + 1 条来电通知到通知栏。建议先按 Home 键退到后台，或锁屏，验证锁屏弹窗是否真的出现。',
      runButton: '推送测试通知',
      running: '正在测试…',
      success: '✓ 两条测试通知已发出，请检查通知栏 / 锁屏。',
      messageOnly: '✓ 消息通知已发出；来电通知失败 — 请确认通知权限。',
      callOnly: '✓ 来电通知已发出；消息通知失败 — 请确认通知权限。',
      bothFailed: '✗ 两条测试通知都未能发出。请回到上面把通知权限打开。',
      finishHint: '看到通知就完成了。如果没看到，请回到第 1 步检查通知权限，或在第 2 步打开锁屏弹窗 / 后台运行权限。',
    },
  },
  en: {
    title: 'Android Permission Setup',
    subtitle: (cur: number, total: number) => `Step ${cur} of ${total}`,
    skip: 'Skip',
    back: 'Back',
    next: 'Next',
    verify: 'Verify',
    finish: 'Finish',
    close: 'Close',
    openSettings: 'Open System Settings',
    notifications: {
      title: 'Allow Notifications',
      desc: 'Without notification permission, Kumiko cannot reach you when the screen is locked or the app is backgrounded. Required for every other reminder feature.',
      cta: 'Allow Notifications',
      tip: 'Tap "Allow" in the system prompt that follows.',
      stateGranted: 'Notifications granted',
      stateDenied: 'Notifications denied',
      stateUnknown: 'Notifications not yet confirmed',
    },
    alarmsAndDisplay: {
      title: 'Alarms, Calls & Background',
      desc: 'Enable all three switches so timed reminders pop punctually on lock screen / in background. Each button deep-links to the matching system page; tap "Verify" when you return.',
      exactAlarmLabel: 'Exact Alarms',
      exactAlarmDesc: 'Android 12+ — decides whether reminders fire on time. Without it, expect 5-15 min random delay.',
      fullScreenLabel: 'Full-screen Call',
      fullScreenDesc: 'Android 14+ — decides whether a call card can cover the lock screen. Without it, only a banner appears.',
      batteryLabel: 'Battery Optimization',
      batteryDesc: 'Whitelist Kumiko in battery-optimization so the app survives long lock-screen sessions.',
      verify: 'Done, verify',
      verifying: 'Verifying…',
      partialNotice: 'Exact alarm or full-screen call still off; reliability suffers. Recommend granting both before continuing.',
      allGood: '✓ Verified: exact alarms + full-screen call are both enabled.',
      allGoodWithBattery: 'Battery optimization cannot be auto-verified. If you whitelisted Kumiko, this step is done.',
    },
    oneClickTest: {
      title: 'One-tap Test',
      desc: 'Posts a message + a call notification. For lock-screen verification, press Home / lock the screen first, then tap the button.',
      runButton: 'Send test notifications',
      running: 'Testing…',
      success: '✓ Both test notifications posted. Please check the tray / lock screen.',
      messageOnly: '✓ Message notification posted; call notification failed — confirm notification permission.',
      callOnly: '✓ Call notification posted; message notification failed — confirm notification permission.',
      bothFailed: '✗ Both test notifications failed. Return to step 1 and enable notifications.',
      finishHint: 'Seeing the notifications means setup succeeded. If nothing appeared, revisit step 1 / step 2 to confirm permissions.',
    },
  },
} as const;

interface PermissionOnboardingWizardProps {
  language: Language;
  onClose: () => void;
  ringtoneFileId?: string | null;
}

export const PermissionOnboardingWizard: React.FC<PermissionOnboardingWizardProps> = ({
  language,
  onClose,
  ringtoneFileId,
}) => {
  const t = COPY[language === 'zh' ? 'zh' : 'en'];
  const [snapshot, setSnapshot] = useState<PermissionStatusSnapshot | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<'idle' | 'partial' | 'all-good'>('idle');
  const [testTone, setTestTone] = useState<'idle' | 'success' | 'partial' | 'fail'>('idle');
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const mountedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getPermissionStatusSnapshot();
      if (!mountedRef.current) return;
      setSnapshot(next);
    } catch (e) {
      console.warn('[onboardingWizard] refresh snapshot failed:', e);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => { mountedRef.current = false; };
  }, [refresh]);

  // Re-probe when the user comes back from system settings.
  useEffect(() => {
    if (!isCapacitorNative()) return;
    let detach: (() => void) | null = null;
    void (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const sub = await App.addListener('appStateChange', (s) => {
          if (s.isActive) void refresh();
        });
        detach = () => sub.remove();
      } catch (e) {
        console.warn('[onboardingWizard] App listener failed:', e);
      }
    })();
    return () => { try { detach?.(); } catch { /* ignore */ } };
  }, [refresh]);

  const currentStep = STEPS[stepIndex];

  const notificationState: PermissionState = snapshot?.items.notifications.state ?? 'unknown';
  const exactAlarmState: PermissionState = snapshot?.items.exactAlarm.state ?? 'unknown';
  const fullScreenState: PermissionState = snapshot?.items.fullScreenIntent.state ?? 'unknown';

  const handleRequestNotifications = useCallback(async () => {
    setBusy('request:notifications');
    try {
      const next = await requestAndroidNotificationPermission();
      if (mountedRef.current) setSnapshot(next);
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, []);

  const handleOpenAlarmSetting = useCallback(async (key: 'exactAlarm' | 'fullScreenIntent' | 'batteryOptimization') => {
    setBusy(`open:${key}`);
    try {
      await openAndroidAlertPermissionSettings(key);
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, []);

  const handleVerifyAlarms = useCallback(async () => {
    setBusy('verify:alarms');
    try {
      const next = await getPermissionStatusSnapshot();
      if (!mountedRef.current) return;
      setSnapshot(next);
      const exactGranted = next.items.exactAlarm.state === 'granted';
      const fsiGranted = next.items.fullScreenIntent.state === 'granted';
      setVerifyResult(exactGranted && fsiGranted ? 'all-good' : 'partial');
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, []);

  const handleRunTest = useCallback(async () => {
    setBusy('test');
    setTestTone('idle');
    setTestMessage(null);
    try {
      const [msgResult, callResult] = await Promise.all([
        runAndroidMessageNotificationTest(),
        runAndroidIncomingCallTest(ringtoneFileId || ''),
      ]);
      if (msgResult.ok && callResult.ok) {
        setTestTone('success');
        setTestMessage(t.oneClickTest.success);
      } else if (msgResult.ok) {
        setTestTone('partial');
        setTestMessage(t.oneClickTest.messageOnly);
      } else if (callResult.ok) {
        setTestTone('partial');
        setTestMessage(t.oneClickTest.callOnly);
      } else {
        setTestTone('fail');
        setTestMessage(t.oneClickTest.bothFailed);
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [ringtoneFileId, t.oneClickTest]);

  const isCurrentSatisfied = useMemo((): boolean => {
    if (currentStep === 'notifications') return notificationState === 'granted';
    if (currentStep === 'alarmsAndDisplay') return verifyResult === 'all-good';
    if (currentStep === 'oneClickTest') return testTone === 'success' || testTone === 'partial';
    return false;
  }, [currentStep, notificationState, verifyResult, testTone]);

  const handleNext = () => {
    if (stepIndex < STEPS.length - 1) {
      setStepIndex(stepIndex + 1);
    } else {
      markAndroidOnboardingCompleted();
      onClose();
    }
  };

  const handleBack = () => {
    if (stepIndex > 0) setStepIndex(stepIndex - 1);
  };

  const handleSkipAll = () => {
    markAndroidOnboardingCompleted();
    onClose();
  };

  const stateText = (state: PermissionState): string => {
    if (state === 'granted') return t.notifications.stateGranted;
    if (state === 'denied') return t.notifications.stateDenied;
    return t.notifications.stateUnknown;
  };

  const stateTone = (state: PermissionState): string => {
    if (state === 'granted') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
    if (state === 'denied') return 'bg-rose-500/15 text-rose-300 border-rose-500/40';
    return 'bg-amber-500/15 text-amber-300 border-amber-500/40';
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-3xl border border-[#5b4a37] bg-[#1a130d] text-[#f1e6d7] shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#3a2c20]">
          <div>
            <h2 className="text-lg font-semibold">{t.title}</h2>
            <p className="text-xs text-[#b69f87]">{t.subtitle(stepIndex + 1, STEPS.length)}</p>
          </div>
          <button
            onClick={handleSkipAll}
            className="p-2 rounded-full hover:bg-[#2a1f17] transition-colors"
            aria-label={t.close}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4">
          {currentStep === 'notifications' && (
            <>
              <h3 className="text-base font-semibold flex items-center gap-2">
                <BellRing size={18} className="text-amber-300" />
                {t.notifications.title}
              </h3>
              <p className="text-sm text-[#d9c1a4] leading-relaxed">{t.notifications.desc}</p>
              <p className="text-xs text-[#b69f87] italic">{t.notifications.tip}</p>
              <div className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-[12px] font-semibold ${stateTone(notificationState)}`}>
                {notificationState === 'granted' ? <Check size={12} /> : notificationState === 'denied' ? <X size={12} /> : <AlertTriangle size={12} />}
                {stateText(notificationState)}
              </div>
              <button
                onClick={handleRequestNotifications}
                disabled={!!busy}
                className="self-start inline-flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-500/25 transition-colors disabled:opacity-60"
              >
                {busy === 'request:notifications' ? <RefreshCw size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                {t.notifications.cta}
              </button>
            </>
          )}

          {currentStep === 'alarmsAndDisplay' && (
            <>
              <h3 className="text-base font-semibold flex items-center gap-2">
                <PhoneCall size={18} className="text-amber-300" />
                {t.alarmsAndDisplay.title}
              </h3>
              <p className="text-sm text-[#d9c1a4] leading-relaxed">{t.alarmsAndDisplay.desc}</p>

              <AlarmRow
                label={t.alarmsAndDisplay.exactAlarmLabel}
                desc={t.alarmsAndDisplay.exactAlarmDesc}
                state={exactAlarmState}
                stateText={stateText(exactAlarmState)}
                stateTone={stateTone(exactAlarmState)}
                buttonLabel={t.openSettings}
                busy={busy === 'open:exactAlarm'}
                onOpen={() => { void handleOpenAlarmSetting('exactAlarm'); }}
              />
              <AlarmRow
                label={t.alarmsAndDisplay.fullScreenLabel}
                desc={t.alarmsAndDisplay.fullScreenDesc}
                state={fullScreenState}
                stateText={stateText(fullScreenState)}
                stateTone={stateTone(fullScreenState)}
                buttonLabel={t.openSettings}
                busy={busy === 'open:fullScreenIntent'}
                onOpen={() => { void handleOpenAlarmSetting('fullScreenIntent'); }}
              />
              <AlarmRow
                label={t.alarmsAndDisplay.batteryLabel}
                desc={t.alarmsAndDisplay.batteryDesc}
                state={'unknown'}
                stateText={stateText('unknown')}
                stateTone={stateTone('unknown')}
                buttonLabel={t.openSettings}
                busy={busy === 'open:batteryOptimization'}
                onOpen={() => { void handleOpenAlarmSetting('batteryOptimization'); }}
              />

              <button
                onClick={handleVerifyAlarms}
                disabled={!!busy}
                className="self-start inline-flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-500/25 transition-colors disabled:opacity-60"
              >
                {busy === 'verify:alarms' ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
                {busy === 'verify:alarms' ? t.alarmsAndDisplay.verifying : t.alarmsAndDisplay.verify}
              </button>
              {verifyResult === 'all-good' && (
                <p className="text-sm text-emerald-300">
                  {t.alarmsAndDisplay.allGood}
                  <br />
                  <span className="text-xs text-emerald-300/80">{t.alarmsAndDisplay.allGoodWithBattery}</span>
                </p>
              )}
              {verifyResult === 'partial' && (
                <p className="text-sm text-amber-300">{t.alarmsAndDisplay.partialNotice}</p>
              )}
            </>
          )}

          {currentStep === 'oneClickTest' && (
            <>
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Zap size={18} className="text-amber-300" />
                {t.oneClickTest.title}
              </h3>
              <p className="text-sm text-[#d9c1a4] leading-relaxed">{t.oneClickTest.desc}</p>
              <button
                onClick={handleRunTest}
                disabled={!!busy}
                className="self-start inline-flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-500/25 transition-colors disabled:opacity-60"
              >
                {busy === 'test' ? <RefreshCw size={14} className="animate-spin" /> : <Zap size={14} />}
                {busy === 'test' ? t.oneClickTest.running : t.oneClickTest.runButton}
              </button>
              {testMessage && (
                <p className={`text-sm whitespace-pre-line ${
                  testTone === 'success' ? 'text-emerald-300'
                    : testTone === 'fail' ? 'text-rose-300'
                      : 'text-amber-300'
                }`}>
                  {testMessage}
                </p>
              )}
              <p className="text-xs text-[#b69f87] italic">{t.oneClickTest.finishHint}</p>
            </>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-[#3a2c20] gap-3">
          <button
            onClick={handleBack}
            disabled={stepIndex === 0}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-[#b69f87] hover:text-[#f1e6d7] hover:bg-[#2a1f17] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={14} />
            {t.back}
          </button>
          <div className="flex items-center gap-2">
            {!isCurrentSatisfied && stepIndex < STEPS.length - 1 && (
              <button
                onClick={handleNext}
                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-[#b69f87] hover:text-[#f1e6d7] hover:bg-[#2a1f17] transition-colors"
              >
                {t.skip}
              </button>
            )}
            <button
              onClick={handleNext}
              className="inline-flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-semibold bg-amber-500/15 border border-amber-500/40 text-amber-200 hover:bg-amber-500/25 transition-colors"
            >
              {stepIndex === STEPS.length - 1 ? t.finish : t.next}
              {stepIndex < STEPS.length - 1 && <ChevronRight size={14} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const AlarmRow: React.FC<{
  label: string;
  desc: string;
  state: PermissionState;
  stateText: string;
  stateTone: string;
  buttonLabel: string;
  busy: boolean;
  onOpen: () => void;
}> = ({ label, desc, state, stateText, stateTone, buttonLabel, busy, onOpen }) => {
  return (
    <div className="rounded-2xl border border-[#3a2c20] bg-[#120e0c]/60 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-sm text-[#f1e6d7]">{label}</span>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${stateTone}`}>
          {state === 'granted' ? <Check size={11} /> : state === 'denied' ? <X size={11} /> : <AlertTriangle size={11} />}
          {stateText}
        </span>
      </div>
      <p className="text-xs text-[#b69f87]">{desc}</p>
      <button
        onClick={onOpen}
        disabled={busy}
        className="self-start inline-flex items-center gap-2 rounded-lg border border-[#5b4a37] bg-[#1a130d] px-3 py-1.5 text-xs font-semibold text-[#f1e6d7] hover:bg-[#231a14] transition-colors disabled:opacity-60"
      >
        {busy ? <RefreshCw size={12} className="animate-spin" /> : <ExternalLink size={12} />}
        {buttonLabel}
      </button>
    </div>
  );
};
