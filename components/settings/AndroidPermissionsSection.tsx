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
import {
  type AlarmSelfTestReport,
  cancelAndroidAlarm,
  collectKumikoSelfTestReport,
  prewarmKumikoAlarmsPlugin,
  scheduleAndroidAlarm,
  startKumikoSelfTestProbe,
  type VendorPermissionKey,
} from '../../services/androidAlarmService';
import { resetAndroidOnboardingFlag } from '../onboarding/PermissionOnboardingWizard';
import { useAppStore } from '../../store';

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
  // v2.14.23: optional reliability boosters — surfaced separately in the
  // UI but not counted against the "core" overall pipeline state.
  'batteryOptimizations',
  'phoneAccount',
];

// v2.14.23: which items are "core" (block the overall pipeline being green)
// vs "boosters" (improve reliability but the app still works without them).
const CORE_KEYS: ReadonlySet<AndroidAlertPermissionKey> = new Set([
  'notifications', 'messagesChannel', 'callsChannel', 'exactAlarm', 'fullScreenIntent',
] as const);

const COPY = {
  zh: {
    title: 'Android 权限体检',
    desc: '检查通知、精准闹钟和来电弹窗是否真实可用。',
    ready: '后台提醒链路已就绪',
    readyAdvice: '主线路通畅。建议把可靠性增强项也开启，特别是「忽略电池优化」和「Telecom 通话账户」，能让锁屏闲置后的提醒更稳。',
    needsSetup: '仍有权限需要配置',
    needsSetupAdvice: '请逐项点击下方红色「去配置」，每开完一项回到本页会自动重新检测；全部绿色后再做测试或深度自检。',
    unknownOverall: '部分项目暂时未能确认',
    unknownOverallAdvice: '冷启动桥握手仍未完成，等几秒后点「重新检测」；如仍然未知，直接用「测试消息通知/来电提醒」实测验证。',
    checking: '正在检测 Android 权限...',
    unsupported: '仅 Android 原生版需要此体检。',
    refresh: '重新检测',
    configure: '去配置',
    request: '申请权限',
    testMessage: '测试消息通知',
    testCall: '测试来电提醒',
    deepSelfTest: '深度自检（端到端）',
    clearTests: '清理测试',
    submittedMessage: '已提交测试消息通知；请确认系统通知和短震动是否真的出现。',
    submittedCall: '已启动来电测试；请确认是否弹出来电页、响当前铃声并震动。',
    cleared: '测试通知已清理。',
    failed: '测试未通过，请先处理标红的权限项。',
    nativeFailed: '系统没有接受测试请求，请检查通知权限或系统限制。',
    timeoutMessage: '检测超时，已展示已拿到的部分结果；请稍后再次检测。',
    testTimeout: '测试请求 6 秒内未收到系统回执，请重新尝试或检查 OEM 后台限制。',
    partialNotice: '部分项目无法确认（以「未知」标记），系统可能繁忙或厂商接口未公开，请重新检测。',
    unknownHint: '「未知」并不等于失败，只是 native 桥还没回应；请用下方测试按钮直接验证（最权威）。',
    bridgeDeadTitle: '原生桥接 5 秒无响应',
    bridgeDeadDesc: '我们已经把所有桥接调用换到后台线程，但本设备（多见于小米 / HyperOS）的 WebView 仍可能阻塞自定义插件，导致测试超时；请尝试「立即重启应用」，重启后所有自检和测试会自动恢复正常路径。',
    bridgeDeadRestart: '立即重启应用',
    bridgeBadgeAlive: '原生桥：正常',
    bridgeBadgeDead: '原生桥：不响应（已切备用路径）',
    testResultSuccess: '✓ 已推送原生通知 — 请检查通知栏。',
    testResultSuccessFallback: '✓ 已通过备用路径送达 — 请检查通知栏（系统通知已发出，但原生桥失败）。',
    testResultFailFallbackTried: '✗ 原生桥与备用路径都失败 — 请重启应用后重试，或确认通知权限。',
    testResultFailGeneric: '✗ 测试失败：',
    callResultSuccess: '✓ 来电测试已发起 — 请确认弹出来电页 / 铃声 / 震动。',
    callResultSuccessFallback: '✓ 备用路径已发出来电通知 — 请检查通知栏（原生桥失败时来电全屏页可能无法弹出）。',
    callTestHint: '提示：请把 App 退到后台或锁屏后再点测试，这样才能验证锁屏弹窗。',
    callCountdownHint: (sec: number) => `准备触发来电…${sec} 秒后开始；请立刻按 Home 退到后台或锁屏，否则只能验证前台横幅。`,
    messageCountdownHint: (sec: number) => `准备触发消息通知…${sec} 秒后开始；可保持当前页或退到后台。`,
    deepSelfTestHint: '深度自检会创建一个 8 秒后的占位提醒，请马上锁屏；解锁回到 App 后会显示「闹钟到达 / 通知已发 / 全屏弹起 / 接听回放」四阶段是否到达。',
    deepSelfTestCountdown: (sec: number) => `${sec} 秒后开始记录，请立即锁屏…`,
    deepSelfTestRunning: '深度自检中。请保持锁屏，到点会响铃；接听后回到 App 自动展示报告。',
    deepSelfTestReportReady: '点击「查看报告」生成端到端可达性报告。',
    deepSelfTestSchedule: '安排自检',
    deepSelfTestCollect: '查看报告',
    rerunOnboarding: '重新打开授权引导',
    rerunOnboardingHint: '从首启的 8 步引导重新走一遍（适合换设备 / 换 ROM 后做一遍完整自检）。',
    abortedHint: '已取消测试。',
    abort: '取消',
    items: {
      notifications: ['通知总权限', 'Android 13+ 必须允许，否则所有通知和震动都可能静默。'],
      messagesChannel: ['消息通知渠道', '主动消息和文字提醒使用此渠道弹通知与短震动。'],
      callsChannel: ['来电通知渠道', '提醒来电使用此渠道触发铃声、震动和全屏意图。'],
      exactAlarm: ['精准闹钟', '定时提醒后台准点触发需要此权限。'],
      fullScreenIntent: ['全屏来电', 'Android 14+ 需要允许全屏通知，锁屏才能弹出来电页。'],
      batteryOptimizations: ['忽略电池优化', '强烈建议开启。Doze 模式 / OEM 杀进程会延迟或丢失提醒；加入忽略列表能显著降低风险。'],
      phoneAccount: ['Telecom 通话账户', '可选。注册后系统把久美子来电视作系统级通话，OEM 拦截更弱；未启用时自动 fallback 到通用全屏通知路径。'],
    },
    unknownItemDesc: '（Native 桥未返回；请用测试按钮直接验证）',
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
    readyAdvice: 'Core path is healthy. We recommend turning on the optional reliability boosters too — especially Ignore battery optimization and Telecom calling account — to reduce drift after a long lock.',
    needsSetup: 'Some permissions still need setup',
    needsSetupAdvice: 'Click each red "Configure" below; we re-check automatically when you return. Once everything is green, run the test buttons or the deep self-test.',
    unknownOverall: 'Some items could not be confirmed',
    unknownOverallAdvice: 'The cold-start bridge handshake is still pending. Wait a few seconds and tap Refresh. If still unknown, just verify with the test buttons below.',
    checking: 'Checking Android permissions...',
    unsupported: 'Only the native Android build needs this check.',
    refresh: 'Refresh',
    configure: 'Configure',
    request: 'Request',
    testMessage: 'Test Message Notification',
    testCall: 'Test Incoming Call',
    deepSelfTest: 'Deep self-test (end-to-end)',
    clearTests: 'Clear Tests',
    submittedMessage: 'Test message notification submitted; confirm the system notification and short vibration appeared.',
    submittedCall: 'Incoming-call test started; confirm the call screen, selected ringtone, and vibration appeared.',
    cleared: 'Test notifications cleared.',
    failed: 'Test did not pass. Fix the highlighted permission first.',
    nativeFailed: 'Android did not accept the test request. Check notification permission or system restrictions.',
    timeoutMessage: 'Detection timed out; showing what we already collected. Try refreshing again.',
    testTimeout: 'No system response within 6s; please retry or check OEM background restrictions.',
    partialNotice: 'Some items could not be confirmed (shown as "Unknown"). The system may be busy or the OEM exposes no API. Please refresh.',
    unknownHint: '"Unknown" does not mean failure — only that the native bridge has not answered yet. The test buttons below give the most authoritative answer.',
    bridgeDeadTitle: 'Native bridge unresponsive after 5s',
    bridgeDeadDesc: 'All plugin calls now run on a background thread, but this device (often Xiaomi / HyperOS) may still block our custom plugin so test buttons time out. Try Restart now — all self-tests will return to the normal path on the next launch.',
    bridgeDeadRestart: 'Restart app now',
    bridgeBadgeAlive: 'Native bridge: healthy',
    bridgeBadgeDead: 'Native bridge: unresponsive (fallback active)',
    testResultSuccess: '✓ Native notification posted — check the notification tray.',
    testResultSuccessFallback: '✓ Delivered via fallback — check the notification tray (system notification arrived but the native bridge failed).',
    testResultFailFallbackTried: '✗ Both native and fallback paths failed — restart the app and try again, or verify notification permissions.',
    testResultFailGeneric: '✗ Test failed: ',
    callResultSuccess: '✓ Incoming-call test started — confirm the call screen, ringtone, and vibration.',
    callResultSuccessFallback: '✓ Fallback path posted a call notification — check the tray (the in-app full-screen call page may not appear when the native bridge is dead).',
    callTestHint: 'Tip: send the app to background or lock the screen first, then run the test to verify lock-screen pop-ups.',
    callCountdownHint: (sec: number) => `Triggering the call test in ${sec}s. Press Home now or lock the screen, otherwise you only test the foreground heads-up.`,
    messageCountdownHint: (sec: number) => `Triggering the message test in ${sec}s. You can stay on this page or send the app to background.`,
    deepSelfTestHint: 'The deep self-test schedules a placeholder reminder 8s out — please lock the screen immediately. After unlocking and returning to the app, we report whether all four stages (alarm fired / notification posted / FSI launched / accept echoed) arrived.',
    deepSelfTestCountdown: (sec: number) => `Recording in ${sec}s; lock the screen now…`,
    deepSelfTestRunning: 'Deep self-test running. Stay locked; the call will ring on time. After accepting the test, return here for the report.',
    deepSelfTestReportReady: 'Tap "View report" to render the end-to-end reachability summary.',
    deepSelfTestSchedule: 'Schedule self-test',
    deepSelfTestCollect: 'View report',
    rerunOnboarding: 'Re-open permission wizard',
    rerunOnboardingHint: 'Walk through the 8-step first-launch wizard again (useful after a device or ROM change).',
    abortedHint: 'Test cancelled.',
    abort: 'Cancel',
    items: {
      notifications: ['Notification Permission', 'Required on Android 13+ or alerts and vibration may stay silent.'],
      messagesChannel: ['Message Channel', 'Proactive messages and text reminders use this channel.'],
      callsChannel: ['Call Channel', 'Reminder calls use this channel for ringtone, vibration, and full-screen intent.'],
      exactAlarm: ['Exact Alarms', 'Required for scheduled reminders to fire on time in the background.'],
      fullScreenIntent: ['Full-Screen Calls', 'Required on Android 14+ for call UI over the lock screen.'],
      batteryOptimizations: ['Ignore battery optimization', 'Strongly recommended. Doze mode and OEM background killing may delay or drop reminders; allowlisting Kumiko reduces that risk significantly.'],
      phoneAccount: ['Telecom calling account', 'Optional. When enabled the system treats Kumiko\u2019s reminder calls as a system call, which OEMs interfere with less. Falls back to the standard FSI path when disabled.'],
    },
    unknownItemDesc: '(Native bridge has not answered; please use the test buttons to verify directly.)',
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

// v2.14.23: bumped from 4s → 8s. The underlying snapshot now costs up to
// ~10s in the absolute-worst-cold-bridge case (5s probe × retry-on-partial).
// We're optimistic that the hook-level prewarm has already paid that tax,
// but the settings panel can be opened from a cold-resume long after the
// bootstrap window has elapsed, so we still need a generous ceiling.
const REFRESH_OVERALL_TIMEOUT_MS = 8_000;

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
  const setForcePermissionWizardOpen = useAppStore(s => s.setForcePermissionWizardOpen);
  const [snapshot, setSnapshot] = useState<AndroidAlertPermissionSnapshot | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string>('');
  // v2.14.26: tone for the result message line. 'success' renders green
  // (✓), 'fail' renders red (✗), 'neutral' is the default brown info
  // colour used for hints/countdowns. Replaces the v2.14.25 dual-line
  // \n-separated layout that confused the user about whether the test
  // actually passed.
  const [messageTone, setMessageTone] = useState<'success' | 'fail' | 'neutral'>('neutral');
  // v2.14.23: self-test state machine. Stages:
  //   idle → countdown (3s) → armed (waiting for user lock + accept)
  //   → reportReady (user back; click "view report") → idle
  const [selfTestStage, setSelfTestStage] = useState<'idle' | 'countdown' | 'armed' | 'reportReady'>('idle');
  const selfTestReminderIdRef = useRef<string | null>(null);
  const [selfTestReport, setSelfTestReport] = useState<AlarmSelfTestReport | null>(null);
  const isSupported = snapshot?.supported !== false;

  const refresh = useCallback(async () => {
    setIsChecking(true);
    let timedOut = false;
    const overallTimer = setTimeout(() => {
      timedOut = true;
      setIsChecking(false);
      setMessage(copy.timeoutMessage);
      setMessageTone('neutral');
    }, REFRESH_OVERALL_TIMEOUT_MS);
    try {
      const next = await getAndroidAlertPermissionSnapshot();
      if (timedOut) {
        setSnapshot(next);
        return;
      }
      setSnapshot(next);
      if (next.partial) {
        setMessage(copy.partialNotice);
        setMessageTone('neutral');
      }
    } catch (e) {
      console.warn('[AndroidPermissions] refresh failed:', e);
      if (!timedOut) {
        setMessage(copy.timeoutMessage);
        setMessageTone('neutral');
      }
    } finally {
      clearTimeout(overallTimer);
      if (!timedOut) setIsChecking(false);
    }
  }, [copy.partialNotice, copy.timeoutMessage]);

  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      // v2.14.23: pay the cold-bridge tax up-front before the read-only
      // snapshot so it doesn't get blamed on the permission probes. The
      // useUnreadAlertsChrome hook also prewarms at app startup; calling
      // here as well covers the case where the user opens settings from
      // a long-paused (memory-trimmed) app where the prewarm result has
      // gone stale.
      await prewarmKumikoAlarmsPlugin();
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
  const overallAdvice = isSupported
    ? overallState === 'granted'
      ? copy.readyAdvice
      : overallState === 'denied'
        ? copy.needsSetupAdvice
        : copy.unknownOverallAdvice
    : '';

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
    setMessageTone('neutral');
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
    setMessageTone('neutral');
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

  // v2.14.26: collapse the four-state matrix (ok×fallback) into a
  // single, typed verdict so the UI can render one short line + one
  // tone (green / red) instead of the v2.14.25 two-line "submitted +
  // fallback used" prose that the user found indecipherable.
  const interpretMessageResult = useCallback((
    result: { ok: boolean; reason?: string; fallbackUsed?: boolean }
  ): { text: string; tone: 'success' | 'fail' } => {
    if (result.ok && result.fallbackUsed) return { text: copy.testResultSuccessFallback, tone: 'success' };
    if (result.ok) return { text: copy.testResultSuccess, tone: 'success' };
    if (result.fallbackUsed) return { text: copy.testResultFailFallbackTried, tone: 'fail' };
    return { text: `${copy.testResultFailGeneric}${reasonText(result.reason)}`, tone: 'fail' };
  }, [copy.testResultFailFallbackTried, copy.testResultFailGeneric, copy.testResultSuccess, copy.testResultSuccessFallback, reasonText]);

  const interpretCallResult = useCallback((
    result: { ok: boolean; reason?: string; fallbackUsed?: boolean }
  ): { text: string; tone: 'success' | 'fail' } => {
    if (result.ok && result.fallbackUsed) return { text: copy.callResultSuccessFallback, tone: 'success' };
    if (result.ok) return { text: copy.callResultSuccess, tone: 'success' };
    if (result.fallbackUsed) return { text: copy.testResultFailFallbackTried, tone: 'fail' };
    return { text: `${copy.testResultFailGeneric}${reasonText(result.reason)}`, tone: 'fail' };
  }, [copy.callResultSuccess, copy.callResultSuccessFallback, copy.testResultFailFallbackTried, copy.testResultFailGeneric, reasonText]);

  const handleTestMessage = useCallback(async () => {
    setBusyKey('test-message');
    setMessage('');
    setMessageTone('neutral');
    try {
      const proceed = await startCountdown(3, copy.messageCountdownHint);
      if (!proceed) {
        setMessage(copy.abortedHint);
        setMessageTone('neutral');
        return;
      }
      const result = await runAndroidMessageNotificationTest();
      const verdict = interpretMessageResult(result);
      setMessage(verdict.text);
      setMessageTone(verdict.tone);
      await refresh();
    } finally {
      setBusyKey(null);
    }
  }, [copy.abortedHint, copy.messageCountdownHint, interpretMessageResult, refresh, startCountdown]);

  const handleTestCall = useCallback(async () => {
    setBusyKey('test-call');
    setMessage(copy.callTestHint);
    setMessageTone('neutral');
    try {
      const proceed = await startCountdown(5, copy.callCountdownHint);
      if (!proceed) {
        setMessage(copy.abortedHint);
        setMessageTone('neutral');
        return;
      }
      const result = await runAndroidIncomingCallTest(ringtoneFileId);
      const verdict = interpretCallResult(result);
      setMessage(verdict.text);
      setMessageTone(verdict.tone);
      await refresh();
    } finally {
      setBusyKey(null);
    }
  }, [copy.abortedHint, copy.callCountdownHint, copy.callTestHint, interpretCallResult, refresh, ringtoneFileId, startCountdown]);

  const handleClearTests = useCallback(async () => {
    cancelCountdown();
    setBusyKey('clear-tests');
    try {
      await clearAndroidAlertTests();
      setMessage(copy.cleared);
      setMessageTone('neutral');
    } finally {
      setBusyKey(null);
    }
  }, [cancelCountdown, copy.cleared]);

  // v2.14.25: hard-restart escape hatch. When the native KumikoAlarms bridge
  // is non-responsive (snapshot.partial && nativeStatus===null), the only
  // way to recover without uninstalling the app is to kill the WebView host
  // process and let Android cold-restart it. Capacitor's App.exitApp() does
  // exactly that on Android. We intentionally don't auto-relaunch — the user
  // taps the launcher icon to come back, which guarantees a clean cold path.
  const handleRestartApp = useCallback(async () => {
    setBusyKey('restart-app');
    try {
      const { App } = await import('@capacitor/app');
      await App.exitApp();
    } catch (e) {
      console.warn('[AndroidPermissions] App.exitApp failed:', e);
    } finally {
      setBusyKey(null);
    }
  }, []);

  const showBridgeDeadBanner = !!(snapshot?.partial && snapshot?.nativeStatus === null);

  const handleAbortCountdown = useCallback(() => {
    cancelCountdown();
    setBusyKey(null);
  }, [cancelCountdown]);

  // v2.14.23: deep self-test. End-to-end probe through the full alarm
  // flow. Records four wall-clock timestamps natively (alarm fired,
  // notification posted, FSI launched, accept committed) and renders a
  // delta report. Honest about what each missing stage means.
  const handleScheduleSelfTest = useCallback(async () => {
    setBusyKey('self-test-schedule');
    setMessage('');
    setSelfTestReport(null);
    try {
      const reminderId = `self-test-${Date.now()}`;
      selfTestReminderIdRef.current = reminderId;
      setSelfTestStage('countdown');
      const proceed = await startCountdown(5, copy.deepSelfTestCountdown);
      if (!proceed) {
        setSelfTestStage('idle');
        selfTestReminderIdRef.current = null;
        setMessage(copy.abortedHint);
        return;
      }
      const armed = await startKumikoSelfTestProbe(reminderId);
      if (!armed) {
        setSelfTestStage('idle');
        selfTestReminderIdRef.current = null;
        setMessage(copy.nativeFailed);
        return;
      }
      const at = Date.now() + 8_000;
      const result = await scheduleAndroidAlarm({
        reminderId,
        at,
        event: '深度自检 / Deep self-test',
        text: '请在锁屏接听以记录全链路时间戳。',
        wantsCall: true,
        ringtoneFileId: ringtoneFileId || '',
      });
      if (!result.scheduled) {
        setSelfTestStage('idle');
        selfTestReminderIdRef.current = null;
        setMessage(copy.nativeFailed);
        return;
      }
      setSelfTestStage('armed');
      setMessage(copy.deepSelfTestRunning);
    } finally {
      setBusyKey(null);
    }
  }, [copy.abortedHint, copy.deepSelfTestCountdown, copy.deepSelfTestRunning, copy.nativeFailed, ringtoneFileId, startCountdown]);

  // Auto-prompt the user to view the report when the app resumes after
  // the self-test arming. We don't auto-collect because some users may
  // have skipped the test mid-flight; surfacing a "report ready" state
  // gives them a chance to opt in or cancel.
  useEffect(() => {
    if (selfTestStage !== 'armed') return;
    const onResume = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setSelfTestStage('reportReady');
      setMessage(copy.deepSelfTestReportReady);
    };
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [copy.deepSelfTestReportReady, selfTestStage]);

  const handleCollectSelfTestReport = useCallback(async () => {
    setBusyKey('self-test-collect');
    try {
      const report = await collectKumikoSelfTestReport();
      setSelfTestReport(report);
      setSelfTestStage('idle');
      // Best-effort cancel any leftover alarm record (no-op if already fired).
      const id = selfTestReminderIdRef.current;
      selfTestReminderIdRef.current = null;
      if (id) {
        void cancelAndroidAlarm(id).catch(() => undefined);
      }
    } finally {
      setBusyKey(null);
    }
  }, []);

  const selfTestReportLines = useMemo<string[] | null>(() => {
    if (!selfTestReport) return null;
    const lines: string[] = [];
    const ok = (label: string, ts: number) =>
      lines.push(`${ts > 0 ? '✅' : '❌'} ${label}${ts > 0 ? ` @ ${new Date(ts).toLocaleTimeString()}` : ''}`);
    ok(language === 'en' ? 'AlarmManager fired' : '闹钟触发', selfTestReport.alarmFiredAt);
    ok(language === 'en' ? 'Notification posted' : '通知已发出', selfTestReport.notifPostedAt);
    ok(language === 'en' ? 'Full-screen UI launched' : '全屏来电拉起', selfTestReport.fsiLaunchedAt);
    ok(language === 'en' ? 'Accept echoed to JS' : '接听已回放到 JS', selfTestReport.acceptReceivedAt);
    if (selfTestReport.alarmFiredAt === 0) {
      lines.push(language === 'en'
        ? '→ Likely cause: AlarmManager frozen by OEM. Open Battery optimization and OEM autostart.'
        : '→ 推断：闹钟被 OEM 冻结。请打开电池优化白名单和厂商自启动。');
    } else if (selfTestReport.notifPostedAt === 0) {
      lines.push(language === 'en'
        ? '→ Likely cause: notification permission revoked. Open the notification toggle.'
        : '→ 推断：通知权限被撤销。请重新打开通知开关。');
    } else if (selfTestReport.fsiLaunchedAt === 0) {
      lines.push(language === 'en'
        ? '→ Likely cause: full-screen intent suppressed. Re-allow full-screen call permission.'
        : '→ 推断：全屏来电被系统拦截。请重新授予全屏通知权限。');
    } else if (selfTestReport.acceptReceivedAt === 0) {
      lines.push(language === 'en'
        ? '→ Stages 1-3 OK; you may have skipped accept. If you did press Accept, the bridge needs investigation — please file a report.'
        : '→ 前三阶段成功；如果你确实点过接听但仍显示未到达，请反馈日志（接听桥需排查）。');
    } else {
      lines.push(language === 'en' ? '→ End-to-end pipeline healthy.' : '→ 端到端链路完好。');
    }
    return lines;
  }, [language, selfTestReport]);

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
                {isSupported && overallAdvice && !isChecking && (
                  <p className={`ka-copy-sm mt-2 max-w-[44ch] ${isDarkMode ? 'text-[#d9c1a4]' : 'text-[#785a42]'}`}>
                    {overallAdvice}
                  </p>
                )}
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

            {isSupported && showBridgeDeadBanner && (
              <div className={`mt-4 rounded-2xl border p-3 ${isDarkMode ? 'border-rose-500/45 bg-rose-500/15' : 'border-rose-300 bg-rose-50'}`}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-col gap-1">
                    <div className={`flex items-center gap-2 ka-setting-item-title ${isDarkMode ? 'text-rose-100' : 'text-rose-800'}`}>
                      <AlertTriangle size={14} />
                      <span>{copy.bridgeDeadTitle}</span>
                    </div>
                    <p className={`ka-copy-sm ${isDarkMode ? 'text-rose-100/85' : 'text-rose-700/90'}`}>{copy.bridgeDeadDesc}</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleRestartApp}
                    disabled={busyKey === 'restart-app'}
                    className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-60 ${isDarkMode ? 'border-rose-400/55 bg-rose-500/25 text-rose-100 hover:bg-rose-500/35' : 'border-rose-400 bg-rose-100 text-rose-800 hover:bg-rose-200'}`}
                  >
                    {busyKey === 'restart-app' ? <RefreshCw size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    {copy.bridgeDeadRestart}
                  </button>
                </div>
              </div>
            )}

            {isSupported && (
              <>
                <div className="mt-4 grid gap-3">
                  {rows.map((item) => {
                    const labels = copy.items[item.key];
                    const isBusy = busyKey === item.key;
                    const isBooster = !CORE_KEYS.has(item.key);
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
                              {isBooster && (
                                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${isDarkMode ? 'border-[#5b4a37] bg-[#221a14] text-[#c9b395]' : 'border-[#e1d4ba] bg-[#f5ecd9] text-[#8a6a39]'}`}>
                                  {language === 'en' ? 'Booster' : '可选增强'}
                                </span>
                              )}
                            </div>
                            <p className={`ka-copy-sm mt-1 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{labels[1]}</p>
                            {item.state === 'unknown' && (
                              <p className={`ka-copy-sm mt-1 italic ${isDarkMode ? 'text-amber-200/80' : 'text-amber-700/85'}`}>
                                {copy.unknownItemDesc}
                              </p>
                            )}
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
                  {/* v2.14.26: bridge-status badge above the test buttons.
                      `showBridgeDeadBanner` is the same condition that drives
                      the bigger red banner above the permission rows; surfacing
                      it here too tells the user *why* a fallback verdict
                      appears — they're using the LocalNotifications path
                      because the native bridge is wedged. */}
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                        showBridgeDeadBanner
                          ? (isDarkMode ? 'border-amber-500/40 bg-amber-500/15 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-700')
                          : (isDarkMode ? 'border-[#5b4a37] bg-[#221a14] text-[#c9b395]' : 'border-[#e1d4ba] bg-[#f5ecd9] text-[#8a6a39]')
                      }`}
                    >
                      {showBridgeDeadBanner ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}
                      {showBridgeDeadBanner ? copy.bridgeBadgeDead : copy.bridgeBadgeAlive}
                    </span>
                  </div>
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
                    {(busyKey === 'test-message' || busyKey === 'test-call' || selfTestStage === 'countdown') && (
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
                  {message && (
                    <p
                      className={`ka-copy-sm mt-3 whitespace-pre-line ${
                        messageTone === 'success'
                          ? (isDarkMode ? 'text-emerald-200' : 'text-emerald-700')
                          : messageTone === 'fail'
                            ? (isDarkMode ? 'text-rose-200' : 'text-rose-700')
                            : (isDarkMode ? 'text-[#d9c1a4]' : 'text-[#785a42]')
                      }`}
                    >
                      {message}
                    </p>
                  )}
                </div>

                <div className={`mt-4 rounded-2xl border p-3 ${isDarkMode ? 'border-[#4e3d2e]/55 bg-[#120e0c]/45' : 'border-[#e8dfd1] bg-[#fbf8f2]'}`}>
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`ka-setting-item-title ${isDarkMode ? 'text-[#f1e6d7]' : 'text-[#54402d]'}`}>{copy.deepSelfTest}</span>
                    </div>
                    <p className={`ka-copy-sm ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{copy.deepSelfTestHint}</p>
                    <div className="flex flex-wrap gap-2 mt-1">
                      <button
                        type="button"
                        onClick={handleScheduleSelfTest}
                        disabled={!!busyKey || isChecking || selfTestStage !== 'idle'}
                        className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-60 ${primaryButtonClass}`}
                      >
                        {busyKey === 'self-test-schedule' || selfTestStage === 'countdown' ? <RefreshCw size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                        {copy.deepSelfTestSchedule}
                      </button>
                      {selfTestStage === 'reportReady' && (
                        <button
                          type="button"
                          onClick={handleCollectSelfTestReport}
                          disabled={busyKey === 'self-test-collect'}
                          className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-60 ${primaryButtonClass}`}
                        >
                          {busyKey === 'self-test-collect' ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                          {copy.deepSelfTestCollect}
                        </button>
                      )}
                    </div>
                    {selfTestReportLines && (
                      <div className={`mt-2 rounded-xl border p-2 text-[12px] leading-relaxed ${isDarkMode ? 'border-[#5b4a37] bg-[#1a130d] text-[#ead0a0]' : 'border-[#d8c7aa] bg-[#fff8e6] text-[#7b5625]'}`}>
                        {selfTestReportLines.map((line, idx) => (
                          <div key={idx}>{line}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* v2.14.23: re-launch the first-launch permission wizard.
                    The wizard caches a localStorage flag once finished; this
                    button clears it and asks App.tsx to re-mount via uiSlice.
                    forcePermissionWizardOpen. We auto-close the settings panel
                    so the wizard isn't covered by the Settings backdrop. */}
                <div className={`mt-4 rounded-2xl border p-3 ${isDarkMode ? 'border-[#4e3d2e]/55 bg-[#120e0c]/45' : 'border-[#e8dfd1] bg-[#fbf8f2]'}`}>
                  <div className="flex flex-col gap-2">
                    <span className={`ka-setting-item-title ${isDarkMode ? 'text-[#f1e6d7]' : 'text-[#54402d]'}`}>{copy.rerunOnboarding}</span>
                    <p className={`ka-copy-sm ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{copy.rerunOnboardingHint}</p>
                    <div className="mt-1">
                      <button
                        type="button"
                        onClick={() => {
                          resetAndroidOnboardingFlag();
                          setForcePermissionWizardOpen(true);
                        }}
                        className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors ${primaryButtonClass}`}
                      >
                        <ShieldCheck size={14} />
                        {copy.rerunOnboarding}
                      </button>
                    </div>
                  </div>
                </div>

                <ScopeDisclosurePanel
                  isDarkMode={isDarkMode}
                  language={language}
                />
              </>
            )}
          </div>
        </div>
      </Collapse>
    </div>
  );
};

// v2.14.23: scope disclosure ("能做 / 部分能做 / 不能做"). The user explicitly
// requested this honesty layer after GPT-5.5 critiqued the plan for
// over-promising message reliability. Surfaces the same content in the
// onboarding wizard's final step.
const SCOPE_COPY = {
  zh: {
    title: '这些场景能否工作（不撒谎）',
    expand: '展开能做 / 部分能做 / 不能做的清单',
    canDo: '能可靠工作（已配权限后）',
    canDoItems: [
      '用户主动设的「N 分钟/小时后提醒我」定时提醒，到点全屏来电 + 配置铃声 + 震动',
      '到点的文字提醒通知（提醒频道）',
      'App 在前台时的所有提醒和主动消息',
      '设备重启后已挂的提醒会自动重挂回来（v2.14.23 新增 Native ledger）',
      '点击接听后回到 App 进入语音通话界面（v2.14.23 修复了断桥）',
    ],
    partial: '部分能做（依赖守护服务存活）',
    partialItems: [
      '主动 RNG 消息 / 睡眠协议主动联络 / Busy 跟进等「JS 自己生成」的消息：守护通知前台时可工作；守护被强杀就停。',
      '锁屏长时间挂机后的提醒：精准闹钟 + 忽略电池优化 + OEM 自启动全部开启时基本可靠；某项关闭则可能漂移或丢失。',
    ],
    cantDo: '架构限制 / 不能保证',
    cantDoItems: [
      '应用信息 → 强制停止 后的任何主动行为：JS 与守护服务都被杀，需要重新打开 App 才会激活',
      '从最近任务列表上滑（部分小米/OPPO/vivo 等同强制停止）：同上',
      '完全无网或弱网：依赖云端 LLM 的主动消息无法生成（产品边界，不是 bug）',
      '没有服务端 push（FCM）：「App 完全不在内存里时由服务端推送的主动消息」不存在 — 我们没有服务端',
    ],
  },
  en: {
    title: 'What works (honest scope)',
    expand: 'Expand what works / partially works / cannot work',
    canDo: 'Reliably works (with permissions granted)',
    canDoItems: [
      'User-scheduled "remind me in N min/hours" reminders ringing full-screen with the configured ringtone and vibration on time',
      'Text reminders posted via the message channel',
      'All in-app proactive activity while Kumiko is in the foreground',
      'Reminders survive a device reboot (v2.14.23 added a native alarm ledger)',
      'Accepting a reminder call returns to the in-app voice call screen (v2.14.23 repaired the bridge)',
    ],
    partial: 'Partially works (depends on the guardian service)',
    partialItems: [
      'JS-generated proactive RNG / sleep / busy follow-ups: works while the guardian foreground service is alive; stops when the OEM force-kills it.',
      'Long-locked overnight reliability: solid when exact alarms + ignore-battery-optimization + OEM autostart are all on; weakens when any are off.',
    ],
    cantDo: 'Architectural limits / cannot guarantee',
    cantDoItems: [
      'Anything proactive after App info → Force stop: JS and the guardian both die; the user must re-open Kumiko once to reactivate.',
      'Swipe-from-recents on Xiaomi / OPPO / vivo (often equivalent to Force stop on those ROMs): same as above.',
      'Air-plane / no-network mode: cloud LLM proactive messages cannot be generated. This is a product boundary, not a bug.',
      'There is no server-side push (FCM). "Server-pushed proactive messages with the app entirely killed" does not exist; Kumiko has no server.',
    ],
  },
} as const;

const ScopeDisclosurePanel: React.FC<{ isDarkMode: boolean; language: Language }> = ({ isDarkMode, language }) => {
  const [open, setOpen] = useState(false);
  const copy = SCOPE_COPY[language];
  return (
    <div className={`mt-4 rounded-2xl border p-3 ${isDarkMode ? 'border-[#4e3d2e]/55 bg-[#120e0c]/45' : 'border-[#e8dfd1] bg-[#fbf8f2]'}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className={`ka-setting-item-title ${isDarkMode ? 'text-[#f1e6d7]' : 'text-[#54402d]'}`}>{copy.title}</span>
        {open ? <ChevronUp size={14} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={14} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>
      {!open && <p className={`ka-copy-sm mt-1 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{copy.expand}</p>}
      {open && (
        <div className={`mt-2 grid gap-3 text-[12px] leading-relaxed ${isDarkMode ? 'text-[#d9c1a4]' : 'text-[#785a42]'}`}>
          <ScopeBucket title={copy.canDo} tone="ok" items={copy.canDoItems} isDarkMode={isDarkMode} />
          <ScopeBucket title={copy.partial} tone="warn" items={copy.partialItems} isDarkMode={isDarkMode} />
          <ScopeBucket title={copy.cantDo} tone="bad" items={copy.cantDoItems} isDarkMode={isDarkMode} />
        </div>
      )}
    </div>
  );
};

const ScopeBucket: React.FC<{ title: string; tone: 'ok' | 'warn' | 'bad'; items: readonly string[]; isDarkMode: boolean }> = ({ title, tone, items, isDarkMode }) => {
  const palette = tone === 'ok'
    ? (isDarkMode ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-emerald-200 bg-emerald-50 text-emerald-700')
    : tone === 'warn'
      ? (isDarkMode ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-700')
      : (isDarkMode ? 'border-rose-500/35 bg-rose-500/10 text-rose-200' : 'border-rose-200 bg-rose-50 text-rose-700');
  return (
    <div className={`rounded-xl border p-2 ${palette}`}>
      <div className="font-semibold mb-1">{title}</div>
      <ul className="list-disc pl-4 space-y-1">
        {items.map((item, idx) => <li key={idx}>{item}</li>)}
      </ul>
    </div>
  );
};

