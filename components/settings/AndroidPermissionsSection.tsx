import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  PhoneCall,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type { Language } from '../../types';
import { Collapse } from '../Collapse';
import {
  clearAndroidAlertTests,
  ensureAndroidAlertChannelsBootstrap,
  getAndroidAlertPermissionSnapshot,
  openAndroidAlertPermissionSettings,
  openAndroidVendorPermissionSetting,
  requestAndroidNotificationPermission,
  runAndroidIncomingCallTest,
  runAndroidMessageNotificationTest,
  type AndroidAlertPermissionItem,
  type AndroidAlertPermissionKey,
  type AndroidAlertPermissionSnapshot,
  type AndroidAlertPermissionState,
  type OemVendor,
} from '../../services/androidAlertPermissionService';
import type { VendorPermissionKey } from '../../services/androidAlarmService';

interface AndroidPermissionsSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: Language;
  sectionBorder: string;
  innerCardClass: string;
  ringtoneFileId?: string | null;
}

const ITEM_ORDER: AndroidAlertPermissionKey[] = [
  'notifications',
  'messagesChannel',
  'callsChannel',
  'exactAlarm',
  'fullScreenIntent',
];

const COPY = {
  zh: {
    title: 'Android 权限体检',
    desc: '检查通知、精准闹钟和来电弹窗是否真实可用。',
    ready: '后台提醒链路已就绪',
    needsSetup: '仍有权限需要配置',
    unknownOverall: '部分项目暂时未能确认',
    checking: '正在检测 Android 权限...',
    unsupported: '仅 Android 原生版需要此体检。',
    refresh: '重新检测',
    configure: '去配置',
    request: '申请权限',
    testMessage: '测试消息通知',
    testCall: '测试来电提醒',
    clearTests: '清理测试',
    submittedMessage: '已提交测试消息通知；请确认系统通知和短震动是否真的出现。',
    submittedCall: '已启动来电测试；请确认是否弹出来电页、响当前铃声并震动。',
    cleared: '测试通知已清理。',
    failed: '测试未通过，请先处理标红的权限项。',
    nativeFailed: '系统没有接受测试请求，请检查通知权限或系统限制。',
    timeoutMessage: '检测超时，已展示已拿到的部分结果；请稍后再次检测。',
    testTimeout: '测试请求 6 秒内未收到系统回执，请重新尝试或检查 OEM 后台限制。',
    partialNotice: '部分项目无法确认（以「未知」标记），系统可能繁忙或厂商接口未公开，请重新检测。',
    unknownHint: '当前显示「未知」时，请重新检测，或直接用下方的「真实测试」按钮验证。',
    callTestHint: '提示：请把 App 退到后台或锁屏后再点测试，这样才能验证锁屏弹窗。',
    callCountdownHint: (sec: number) => `准备触发来电…${sec} 秒后开始；请立刻按 Home 退到后台或锁屏，否则只能验证前台横幅。`,
    messageCountdownHint: (sec: number) => `准备触发消息通知…${sec} 秒后开始；可保持当前页或退到后台。`,
    abortedHint: '已取消测试。',
    abort: '取消',
    items: {
      notifications: ['通知总权限', 'Android 13+ 必须允许，否则所有通知和震动都可能静默。'],
      messagesChannel: ['消息通知渠道', '主动消息和文字提醒使用此渠道弹通知与短震动。'],
      callsChannel: ['来电通知渠道', '提醒来电使用此渠道触发铃声、震动和全屏意图。'],
      exactAlarm: ['精准闹钟', '定时提醒后台准点触发需要此权限。'],
      fullScreenIntent: ['全屏来电', 'Android 14+ 需要允许全屏通知，锁屏才能弹出来电页。'],
    },
    states: {
      granted: '已通过',
      denied: '未配置',
      unavailable: '不可用',
      unknown: '未知',
    },
    oem: {
      sectionTitle: '厂商额外检查',
      manualConfirm: '需手动确认',
      noPublicApi: 'Android 没有公开 API 让 App 自己读取这些开关，请按下方「去配置」逐项打开，并用上方测试按钮确认实际效果。',
      vendorLabels: {
        xiaomi: '小米 / Redmi / POCO（MIUI / HyperOS）',
        huawei: '华为（EMUI / HarmonyOS）',
        honor: '荣耀（Magic UI）',
        samsung: '三星（One UI）',
        oppo: 'OPPO / realme（ColorOS）',
        realme: 'realme（realme UI）',
        vivo: 'vivo / iQOO（OriginOS / FuntouchOS）',
        oneplus: 'OnePlus（OxygenOS / ColorOS）',
        meizu: '魅族（Flyme）',
        asus: '华硕（ROG UI / ZenUI）',
        lenovo: '联想 / Motorola',
        motorola: 'Motorola',
        nothing: 'Nothing OS',
        google: 'Google Pixel（原生 Android）',
        unknown: '其他厂商',
      } as Record<OemVendor, string>,
      vendorWarnings: {
        xiaomi: 'MIUI / HyperOS 默认拒绝第三方 App 在锁屏弹出和后台启动。需要全部开启「自启动」「锁屏显示」「后台弹出界面」，否则定时来电不会响。',
        huawei: 'EMUI / HarmonyOS 的 PowerGenie 会在 60 分钟后冻结后台 App。请把 Kumiko 加入「受保护应用」并关闭电池优化。',
        honor: '荣耀同样有 PowerGenie 类似机制，请加入「受保护应用」并关闭电池优化。',
        samsung: 'One UI 的「深度睡眠应用 / Sleeping apps」会冻结闲置 App，请把 Kumiko 加入「永不休眠」白名单。',
        oppo: 'ColorOS 默认禁止后台自启动，请开启「自启动」「关联启动」「后台弹窗」，并允许后台高耗电。',
        realme: 'realme UI 默认禁止后台自启动，请开启「自启动」「关联启动」「后台弹窗」，并允许后台高耗电。',
        vivo: 'OriginOS / FuntouchOS 默认禁止后台自启动，请开启「自启动」「后台高耗电」。',
        oneplus: 'OxygenOS（基于 ColorOS）默认禁止后台自启动，请开启「自启动」「后台高耗电」。',
        meizu: 'Flyme 默认禁止后台自启动，请开启「自启动」「后台高耗电」。',
        asus: '请关闭电池优化，并允许后台高耗电。',
        lenovo: '请关闭电池优化。',
        motorola: '请关闭电池优化。',
        nothing: '请关闭电池优化。',
        google: '原生 Android 不需要厂商额外配置，AOSP 权限即可生效。',
        unknown: '不识别的厂商，请按上方 AOSP 权限和系统电池优化界面排查。',
      } as Record<OemVendor, string>,
      actions: {
        showOnLock: '锁屏显示弹窗',
        autostart: '允许自启动',
        backgroundPopup: '允许后台弹窗',
        protectedApps: '受保护应用',
        ignoreBatteryOpt: '忽略电池优化',
        deviceCare: '设备维护 / 永不休眠',
        appDetails: 'App 详情页',
      },
      vendorAction: {
        opened: '已尝试打开对应设置页，请按提示开启对应开关后回到本页重新检测。',
        fallback: '系统未直接提供该入口，已为您打开 App 详情页，请手动找到对应权限项。',
        failed: '无法打开该设置项，请手动到系统「设置 - 应用 - Kumiko·Amadeus」中开启。',
      },
    },
  },
  en: {
    title: 'Android Permission Check',
    desc: 'Verify notifications, exact alarms, and incoming-call UI.',
    ready: 'Background alert pipeline is ready',
    needsSetup: 'Some permissions still need setup',
    unknownOverall: 'Some items could not be confirmed',
    checking: 'Checking Android permissions...',
    unsupported: 'Only the native Android build needs this check.',
    refresh: 'Refresh',
    configure: 'Configure',
    request: 'Request',
    testMessage: 'Test Message Notification',
    testCall: 'Test Incoming Call',
    clearTests: 'Clear Tests',
    submittedMessage: 'Test message notification submitted; confirm the system notification and short vibration appeared.',
    submittedCall: 'Incoming-call test started; confirm the call screen, selected ringtone, and vibration appeared.',
    cleared: 'Test notifications cleared.',
    failed: 'Test did not pass. Fix the highlighted permission first.',
    nativeFailed: 'Android did not accept the test request. Check notification permission or system restrictions.',
    timeoutMessage: 'Detection timed out; showing what we already collected. Try refreshing again.',
    testTimeout: 'No system response within 6s; please retry or check OEM background restrictions.',
    partialNotice: 'Some items could not be confirmed (shown as "Unknown"). The system may be busy or the OEM exposes no API. Please refresh.',
    unknownHint: 'When an item shows "Unknown", refresh again or use the real-world test buttons below.',
    callTestHint: 'Tip: send the app to background or lock the screen first, then run the test to verify lock-screen pop-ups.',
    callCountdownHint: (sec: number) => `Triggering the call test in ${sec}s. Press Home now or lock the screen, otherwise you only test the foreground heads-up.`,
    messageCountdownHint: (sec: number) => `Triggering the message test in ${sec}s. You can stay on this page or send the app to background.`,
    abortedHint: 'Test cancelled.',
    abort: 'Cancel',
    items: {
      notifications: ['Notification Permission', 'Required on Android 13+ or alerts and vibration may stay silent.'],
      messagesChannel: ['Message Channel', 'Proactive messages and text reminders use this channel.'],
      callsChannel: ['Call Channel', 'Reminder calls use this channel for ringtone, vibration, and full-screen intent.'],
      exactAlarm: ['Exact Alarms', 'Required for scheduled reminders to fire on time in the background.'],
      fullScreenIntent: ['Full-Screen Calls', 'Required on Android 14+ for call UI over the lock screen.'],
    },
    states: {
      granted: 'Ready',
      denied: 'Needs setup',
      unavailable: 'Unavailable',
      unknown: 'Unknown',
    },
    oem: {
      sectionTitle: 'OEM-specific checks',
      manualConfirm: 'Manual confirmation needed',
      noPublicApi: 'Android exposes no public API for these toggles. Open each item below, enable the corresponding switch, and verify with the test buttons above.',
      vendorLabels: {
        xiaomi: 'Xiaomi / Redmi / POCO (MIUI / HyperOS)',
        huawei: 'Huawei (EMUI / HarmonyOS)',
        honor: 'Honor (Magic UI)',
        samsung: 'Samsung (One UI)',
        oppo: 'OPPO / realme (ColorOS)',
        realme: 'realme (realme UI)',
        vivo: 'vivo / iQOO (OriginOS / FuntouchOS)',
        oneplus: 'OnePlus (OxygenOS / ColorOS)',
        meizu: 'Meizu (Flyme)',
        asus: 'ASUS (ROG UI / ZenUI)',
        lenovo: 'Lenovo / Motorola',
        motorola: 'Motorola',
        nothing: 'Nothing OS',
        google: 'Google Pixel (stock Android)',
        unknown: 'Other vendor',
      } as Record<OemVendor, string>,
      vendorWarnings: {
        xiaomi: 'MIUI / HyperOS blocks third-party apps from popping over the lock screen and starting in background by default. Enable Autostart, Show on lock screen, and Display pop-up windows or scheduled calls will not ring.',
        huawei: "Huawei's PowerGenie freezes background apps after 60 minutes. Add Kumiko to Protected apps and disable battery optimization.",
        honor: 'Honor uses a similar mechanism. Add Kumiko to Protected apps and disable battery optimization.',
        samsung: "Samsung One UI's Sleeping apps freeze idle apps. Add Kumiko to Never sleeping apps.",
        oppo: 'ColorOS blocks background autostart by default. Enable Autostart, Allow associated startup, Background pop-up, and high background battery usage.',
        realme: 'realme UI blocks background autostart by default. Enable Autostart, Allow associated startup, Background pop-up, and high background battery usage.',
        vivo: 'OriginOS / FuntouchOS blocks background autostart by default. Enable Autostart and high background battery usage.',
        oneplus: 'OxygenOS (ColorOS-based) blocks background autostart by default. Enable Autostart and high background battery usage.',
        meizu: 'Flyme blocks background autostart by default. Enable Autostart and high background battery usage.',
        asus: 'Disable battery optimization and allow high background battery usage.',
        lenovo: 'Disable battery optimization.',
        motorola: 'Disable battery optimization.',
        nothing: 'Disable battery optimization.',
        google: 'Stock Android needs no extra OEM configuration; AOSP permissions are sufficient.',
        unknown: 'Unrecognized vendor. Verify AOSP permissions above and check system battery optimization.',
      } as Record<OemVendor, string>,
      actions: {
        showOnLock: 'Show on lock screen',
        autostart: 'Allow autostart',
        backgroundPopup: 'Allow background pop-up',
        protectedApps: 'Protected apps',
        ignoreBatteryOpt: 'Ignore battery optimization',
        deviceCare: 'Device care / Never sleeping',
        appDetails: 'App details',
      },
      vendorAction: {
        opened: 'Opened the corresponding settings page. Enable the toggle, then come back and refresh.',
        fallback: 'The system did not provide a direct entry; opened the App details page instead. Locate the toggle manually.',
        failed: "Could not open that settings entry. Open Settings -> Apps -> Kumiko·Amadeus manually.",
      },
    },
  },
} as const;

const stateTone = (state: AndroidAlertPermissionState, isDarkMode: boolean) => {
  if (state === 'granted') {
    return isDarkMode ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-emerald-200 bg-emerald-50 text-emerald-700';
  }
  if (state === 'denied') {
    return isDarkMode ? 'border-rose-500/35 bg-rose-500/10 text-rose-200' : 'border-rose-200 bg-rose-50 text-rose-700';
  }
  return isDarkMode ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-700';
};

interface VendorAction {
  id: string;
  label: string;
  vendorKey: VendorPermissionKey;
}

const VENDOR_ACTIONS: Record<OemVendor, (actions: typeof COPY.zh.oem.actions) => VendorAction[]> = {
  xiaomi: (a) => [
    { id: 'autostart', label: a.autostart, vendorKey: 'xiaomi.autostart' },
    { id: 'showOnLock', label: a.showOnLock, vendorKey: 'xiaomi.permEditor' },
    { id: 'backgroundPopup', label: a.backgroundPopup, vendorKey: 'xiaomi.permEditor' },
    { id: 'ignoreBatteryOpt', label: a.ignoreBatteryOpt, vendorKey: 'generic.ignoreBatteryOptimizations' },
  ],
  huawei: (a) => [
    { id: 'protectedApps', label: a.protectedApps, vendorKey: 'huawei.protectedApps' },
    { id: 'ignoreBatteryOpt', label: a.ignoreBatteryOpt, vendorKey: 'huawei.batteryOptimizations' },
  ],
  honor: (a) => [
    { id: 'protectedApps', label: a.protectedApps, vendorKey: 'honor.protectedApps' },
    { id: 'ignoreBatteryOpt', label: a.ignoreBatteryOpt, vendorKey: 'huawei.batteryOptimizations' },
  ],
  samsung: (a) => [
    { id: 'deviceCare', label: a.deviceCare, vendorKey: 'samsung.deviceCare' },
    { id: 'batteryUsage', label: a.ignoreBatteryOpt, vendorKey: 'samsung.batteryUsage' },
  ],
  oppo: (a) => [
    { id: 'startup', label: a.autostart, vendorKey: 'oppo.startup' },
    { id: 'ignoreBatteryOpt', label: a.ignoreBatteryOpt, vendorKey: 'oppo.batteryOptimizations' },
  ],
  realme: (a) => [
    { id: 'startup', label: a.autostart, vendorKey: 'realme.startup' },
    { id: 'ignoreBatteryOpt', label: a.ignoreBatteryOpt, vendorKey: 'oppo.batteryOptimizations' },
  ],
  oneplus: (a) => [
    { id: 'startup', label: a.autostart, vendorKey: 'oneplus.startup' },
    { id: 'ignoreBatteryOpt', label: a.ignoreBatteryOpt, vendorKey: 'oppo.batteryOptimizations' },
  ],
  vivo: (a) => [
    { id: 'backgroundStartup', label: a.autostart, vendorKey: 'vivo.backgroundStartup' },
    { id: 'ignoreBatteryOpt', label: a.ignoreBatteryOpt, vendorKey: 'vivo.batteryOptimizations' },
  ],
  meizu: (a) => [
    { id: 'appDetails', label: a.appDetails, vendorKey: 'generic.appDetails' },
    { id: 'ignoreBatteryOpt', label: a.ignoreBatteryOpt, vendorKey: 'generic.ignoreBatteryOptimizations' },
  ],
  asus: (a) => [
    { id: 'ignoreBatteryOpt', label: a.ignoreBatteryOpt, vendorKey: 'generic.ignoreBatteryOptimizations' },
  ],
  lenovo: (a) => [
    { id: 'ignoreBatteryOpt', label: a.ignoreBatteryOpt, vendorKey: 'generic.ignoreBatteryOptimizations' },
  ],
  motorola: (a) => [
    { id: 'ignoreBatteryOpt', label: a.ignoreBatteryOpt, vendorKey: 'generic.ignoreBatteryOptimizations' },
  ],
  nothing: (a) => [
    { id: 'ignoreBatteryOpt', label: a.ignoreBatteryOpt, vendorKey: 'generic.ignoreBatteryOptimizations' },
  ],
  google: () => [],
  unknown: (a) => [
    { id: 'appDetails', label: a.appDetails, vendorKey: 'generic.appDetails' },
  ],
};

const REFRESH_OVERALL_TIMEOUT_MS = 4_000;

export const AndroidPermissionsSection: React.FC<AndroidPermissionsSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  language,
  sectionBorder,
  innerCardClass,
  ringtoneFileId,
}) => {
  const copy = COPY[language];
  const [snapshot, setSnapshot] = useState<AndroidAlertPermissionSnapshot | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string>('');
  const isSupported = snapshot?.supported !== false;

  const refresh = useCallback(async () => {
    setIsChecking(true);
    let timedOut = false;
    const overallTimer = setTimeout(() => {
      timedOut = true;
      setIsChecking(false);
      setMessage(copy.timeoutMessage);
    }, REFRESH_OVERALL_TIMEOUT_MS);
    try {
      const next = await getAndroidAlertPermissionSnapshot();
      if (timedOut) {
        setSnapshot(next);
        return;
      }
      setSnapshot(next);
      if (next.partial) setMessage(copy.partialNotice);
    } catch (e) {
      console.warn('[AndroidPermissions] refresh failed:', e);
      if (!timedOut) setMessage(copy.timeoutMessage);
    } finally {
      clearTimeout(overallTimer);
      if (!timedOut) setIsChecking(false);
    }
  }, [copy.partialNotice, copy.timeoutMessage]);

  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      await ensureAndroidAlertChannelsBootstrap();
      void refresh();
    })();
  }, [isOpen, refresh]);

  useEffect(() => {
    const onReturn = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refresh();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [refresh]);

  const overallState = snapshot?.overall || 'unknown';
  const overallCopy = isChecking
    ? copy.checking
    : !isSupported
      ? copy.unsupported
      : overallState === 'granted'
        ? copy.ready
        : overallState === 'denied'
          ? copy.needsSetup
          : copy.unknownOverall;

  const rows = useMemo(() => (
    ITEM_ORDER.map((key) => snapshot?.items[key]).filter(Boolean) as AndroidAlertPermissionItem[]
  ), [snapshot]);

  const oem = snapshot?.oem || null;
  const vendorActions = useMemo(() => {
    if (!oem) return [] as VendorAction[];
    const builder = VENDOR_ACTIONS[oem.vendor] || VENDOR_ACTIONS.unknown;
    return builder(copy.oem.actions);
  }, [copy.oem.actions, oem]);

  const handleConfigure = useCallback(async (item: AndroidAlertPermissionItem) => {
    setBusyKey(item.key);
    setMessage('');
    try {
      if (item.key === 'notifications') {
        await requestAndroidNotificationPermission();
      } else {
        await openAndroidAlertPermissionSettings(item.key);
      }
      await refresh();
    } finally {
      setBusyKey(null);
    }
  }, [refresh]);

  const handleVendorAction = useCallback(async (action: VendorAction) => {
    setBusyKey(`vendor:${action.id}`);
    setMessage('');
    try {
      const result = await openAndroidVendorPermissionSetting(action.vendorKey);
      if (!result.opened) setMessage(copy.oem.vendorAction.failed);
      else if (result.usedFallback) setMessage(copy.oem.vendorAction.fallback);
      else setMessage(copy.oem.vendorAction.opened);
    } finally {
      setBusyKey(null);
    }
  }, [copy.oem.vendorAction.failed, copy.oem.vendorAction.fallback, copy.oem.vendorAction.opened]);

  const reasonText = useCallback((reason?: string) => {
    if (reason === 'native-failed') return copy.nativeFailed;
    if (reason === 'timeout') return copy.testTimeout;
    return copy.failed;
  }, [copy.failed, copy.nativeFailed, copy.testTimeout]);

  const countdownAbortRef = useRef<{ aborted: boolean } | null>(null);

  const cancelCountdown = useCallback(() => {
    if (countdownAbortRef.current) {
      countdownAbortRef.current.aborted = true;
    }
  }, []);

  const startCountdown = useCallback(async (
    seconds: number,
    formatter: (sec: number) => string,
  ): Promise<boolean> => {
    const token = { aborted: false };
    countdownAbortRef.current = token;
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      if (token.aborted) {
        countdownAbortRef.current = null;
        return false;
      }
      setMessage(formatter(remaining));
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (token.aborted) {
      countdownAbortRef.current = null;
      return false;
    }
    countdownAbortRef.current = null;
    return true;
  }, []);

  const handleTestMessage = useCallback(async () => {
    setBusyKey('test-message');
    setMessage('');
    try {
      const proceed = await startCountdown(3, copy.messageCountdownHint);
      if (!proceed) {
        setMessage(copy.abortedHint);
        return;
      }
      const result = await runAndroidMessageNotificationTest();
      setMessage(result.ok ? copy.submittedMessage : reasonText(result.reason));
      await refresh();
    } finally {
      setBusyKey(null);
    }
  }, [copy.abortedHint, copy.messageCountdownHint, copy.submittedMessage, reasonText, refresh, startCountdown]);

  const handleTestCall = useCallback(async () => {
    setBusyKey('test-call');
    setMessage(copy.callTestHint);
    try {
      const proceed = await startCountdown(5, copy.callCountdownHint);
      if (!proceed) {
        setMessage(copy.abortedHint);
        return;
      }
      const result = await runAndroidIncomingCallTest(ringtoneFileId);
      setMessage(result.ok ? copy.submittedCall : reasonText(result.reason));
      await refresh();
    } finally {
      setBusyKey(null);
    }
  }, [copy.abortedHint, copy.callCountdownHint, copy.callTestHint, copy.submittedCall, reasonText, refresh, ringtoneFileId, startCountdown]);

  const handleClearTests = useCallback(async () => {
    cancelCountdown();
    setBusyKey('clear-tests');
    try {
      await clearAndroidAlertTests();
      setMessage(copy.cleared);
    } finally {
      setBusyKey(null);
    }
  }, [cancelCountdown, copy.cleared]);

  const handleAbortCountdown = useCallback(() => {
    cancelCountdown();
    setBusyKey(null);
  }, [cancelCountdown]);

  const buttonClass = isDarkMode
    ? 'border-[#6a5239] bg-[#1b1410] text-[#ead0a0] hover:bg-[#2a2119]'
    : 'border-[#d8c7aa] bg-white text-[#7b5625] hover:bg-[#f6efe3]';
  const primaryButtonClass = isDarkMode
    ? 'border-[#e4b24f]/40 bg-[#e4b24f]/15 text-[#f8df9e] hover:bg-[#e4b24f]/25'
    : 'border-[#d2a348]/45 bg-[#fff8e6] text-[#8a611f] hover:bg-[#fff1c9]';

  return (
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border shrink-0 ${isDarkMode ? 'border-cyan-500/20 bg-cyan-900/20 text-cyan-200' : 'border-cyan-200 bg-cyan-50/90 text-cyan-700'}`}>
            <ShieldCheck size={18} />
          </div>
          <div className="text-left">
            <h3 className={`ka-section-title ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{copy.title}</h3>
            {!isOpen && <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{overallCopy}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen}>
        <div className="px-4 pb-4 pt-0">
          <div className={innerCardClass}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className={`ka-copy-sm ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{copy.desc}</p>
                <div className={`mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[12px] font-semibold ${stateTone(overallState, isDarkMode)}`}>
                  {overallState === 'granted' ? <CheckCircle2 size={14} /> : overallState === 'denied' ? <XCircle size={14} /> : <AlertTriangle size={14} />}
                  {overallCopy}
                  {snapshot?.sdkInt ? <span className="opacity-70">SDK {snapshot.sdkInt}</span> : null}
                </div>
              </div>
              <button
                type="button"
                onClick={refresh}
                disabled={isChecking}
                className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-60 ${buttonClass}`}
              >
                <RefreshCw size={14} className={isChecking ? 'animate-spin' : ''} />
                {copy.refresh}
              </button>
            </div>

            {isSupported && (
              <>
                <div className="mt-4 grid gap-3">
                  {rows.map((item) => {
                    const labels = copy.items[item.key];
                    const isBusy = busyKey === item.key;
                    return (
                      <div key={item.key} className={`rounded-2xl border p-3 ${isDarkMode ? 'border-[#4e3d2e]/55 bg-[#120e0c]/45' : 'border-[#e8dfd1] bg-[#fbf8f2]'}`}>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`ka-setting-item-title ${isDarkMode ? 'text-[#f1e6d7]' : 'text-[#54402d]'}`}>{labels[0]}</span>
                              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${stateTone(item.state, isDarkMode)}`}>
                                {item.state === 'granted' ? <CheckCircle2 size={12} /> : item.state === 'denied' ? <XCircle size={12} /> : <AlertTriangle size={12} />}
                                {copy.states[item.state]}
                              </span>
                            </div>
                            <p className={`ka-copy-sm mt-1 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{labels[1]}</p>
                          </div>
                          {item.state !== 'granted' && item.canOpenSettings && (
                            <button
                              type="button"
                              onClick={() => handleConfigure(item)}
                              disabled={!!busyKey}
                              className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-60 ${primaryButtonClass}`}
                            >
                              {isBusy ? <RefreshCw size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                              {item.key === 'notifications' ? copy.request : copy.configure}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {oem && (
                  <div className={`mt-4 rounded-2xl border p-3 ${isDarkMode ? 'border-[#4e3d2e]/55 bg-[#120e0c]/45' : 'border-[#e8dfd1] bg-[#fbf8f2]'}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`ka-setting-item-title ${isDarkMode ? 'text-[#f1e6d7]' : 'text-[#54402d]'}`}>{copy.oem.sectionTitle}</span>
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${stateTone(oem.vendor === 'google' ? 'granted' : 'unknown', isDarkMode)}`}>
                        {oem.vendor === 'google' ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                        {copy.oem.vendorLabels[oem.vendor]}
                      </span>
                    </div>
                    <p className={`ka-copy-sm mt-2 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
                      {copy.oem.vendorWarnings[oem.vendor]}
                    </p>
                    {oem.vendor !== 'google' && (
                      <p className={`ka-copy-sm mt-2 ${isDarkMode ? 'text-[#d9c1a4]' : 'text-[#785a42]'}`}>
                        {copy.oem.noPublicApi}
                      </p>
                    )}
                    {oem.vendor === 'xiaomi' && (
                      <div className={`mt-3 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold ${stateTone(oem.miuiShowOnLockState, isDarkMode)}`}>
                        {oem.miuiShowOnLockState === 'granted' ? <CheckCircle2 size={12} /> : oem.miuiShowOnLockState === 'denied' ? <XCircle size={12} /> : <AlertTriangle size={12} />}
                        <span>{copy.oem.actions.showOnLock}</span>
                        <span className="opacity-70">{
                          oem.miuiShowOnLockState === 'granted' ? copy.states.granted
                            : oem.miuiShowOnLockState === 'denied' ? copy.states.denied
                              : copy.oem.manualConfirm
                        }</span>
                      </div>
                    )}
                    {vendorActions.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {vendorActions.map((action) => {
                          const isBusy = busyKey === `vendor:${action.id}`;
                          return (
                            <button
                              key={action.id}
                              type="button"
                              onClick={() => handleVendorAction(action)}
                              disabled={!!busyKey}
                              className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-60 ${buttonClass}`}
                            >
                              {isBusy ? <RefreshCw size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                              {action.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {snapshot?.partial && (
                  <p className={`ka-copy-sm mt-3 ${isDarkMode ? 'text-amber-200' : 'text-amber-700'}`}>{copy.unknownHint}</p>
                )}

                <div className={`mt-4 rounded-2xl border p-3 ${isDarkMode ? 'border-[#4e3d2e]/55 bg-[#120e0c]/45' : 'border-[#e8dfd1] bg-[#fbf8f2]'}`}>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleTestMessage}
                      disabled={!!busyKey || isChecking}
                      className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-60 ${primaryButtonClass}`}
                    >
                      {busyKey === 'test-message' ? <RefreshCw size={14} className="animate-spin" /> : <BellRing size={14} />}
                      {copy.testMessage}
                    </button>
                    <button
                      type="button"
                      onClick={handleTestCall}
                      disabled={!!busyKey || isChecking}
                      className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-60 ${primaryButtonClass}`}
                    >
                      {busyKey === 'test-call' ? <RefreshCw size={14} className="animate-spin" /> : <PhoneCall size={14} />}
                      {copy.testCall}
                    </button>
                    <button
                      type="button"
                      onClick={handleClearTests}
                      disabled={busyKey === 'clear-tests' || busyKey === 'test-message' || busyKey === 'test-call'}
                      className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-60 ${buttonClass}`}
                    >
                      {busyKey === 'clear-tests' ? <RefreshCw size={14} className="animate-spin" /> : <XCircle size={14} />}
                      {copy.clearTests}
                    </button>
                    {(busyKey === 'test-message' || busyKey === 'test-call') && (
                      <button
                        type="button"
                        onClick={handleAbortCountdown}
                        className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors ${buttonClass}`}
                      >
                        <XCircle size={14} />
                        {copy.abort}
                      </button>
                    )}
                  </div>
                  {message && <p className={`ka-copy-sm mt-3 ${isDarkMode ? 'text-[#d9c1a4]' : 'text-[#785a42]'}`}>{message}</p>}
                </div>
              </>
            )}
          </div>
        </div>
      </Collapse>
    </div>
  );
};
