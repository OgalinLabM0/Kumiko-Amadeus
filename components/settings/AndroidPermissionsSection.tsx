import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  XCircle,
  Zap,
} from 'lucide-react';
import type { Language } from '../../types';
import { Collapse } from '../Collapse';
import {
  getPermissionStatusSnapshot,
  openAndroidAlertPermissionSettings,
  requestAndroidNotificationPermission,
  runAndroidIncomingCallTest,
  runAndroidMessageNotificationTest,
  type PermissionItem,
  type PermissionKey,
  type PermissionState,
  type PermissionStatusSnapshot,
} from '../../services/androidAlertPermissionService';
import { prewarmKumikoAlarmsPlugin } from '../../services/androidAlarmService';

interface AndroidPermissionsSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: Language;
  sectionBorder: string;
  innerCardClass: string;
  ringtoneFileId?: string | null;
}

// v2.14.27: 5 cards, ordered by user-impact severity. Notifications first
// (without it nothing else matters); battery + lockscreen last because we
// can't programmatically verify them.
const ITEM_ORDER: PermissionKey[] = [
  'notifications',
  'exactAlarm',
  'fullScreenIntent',
  'batteryOptimization',
  'lockScreenDisplay',
];

const COPY = {
  zh: {
    title: 'Android 权限',
    desc: '5 个核心权限决定提醒能否准点送达。点「打开系统设置」开权限，回到本页点「我已设置好，验证」。',
    refresh: '刷新',
    overall: {
      granted: '已就绪',
      denied: '需要配置',
      unknown: '部分未确认',
      unavailable: '不适用',
    },
    states: {
      granted: '已开启',
      denied: '已拒绝',
      unknown: '未知',
      unavailable: '不适用',
    },
    openSettings: '打开系统设置',
    verify: '我已设置好，验证',
    request: '申请权限',
    cannotVerifyHint: '此项无法自动验证；请按提示在系统设置里检查后回到 App。',
    items: {
      notifications: ['通知权限', '允许 Kumiko 在通知栏弹出消息和来电提醒。这是所有提醒的基础。'],
      exactAlarm: ['精准闹钟', '允许 Kumiko 准点触发定时提醒（误差 < 10 秒）；关闭后系统会推迟到节能时段统一处理。'],
      fullScreenIntent: ['全屏来电', '允许提醒在锁屏 / 后台时以全屏形式弹出（类似真实来电）。'],
      batteryOptimization: ['后台运行（电池优化白名单）', '把 Kumiko 加入「不限制后台」名单，避免长时间锁屏后被休眠杀掉。'],
      lockScreenDisplay: ['锁屏显示', '小米 / OPPO / vivo 等需要在「应用权限」里手动允许「锁屏显示」/「后台弹出界面」。'],
    },
    test: {
      title: '一键测试',
      desc: '推送 1 条消息通知 + 1 条来电通知到系统通知栏。建议先把 App 退到后台 / 锁屏再点，验证锁屏弹窗能正常出现。',
      run: '一键测试',
      running: '正在测试…',
      success: '✓ 测试通知已推送，请检查通知栏。',
      messageOnly: '✓ 消息通知已发出；来电通知发送失败，请确认通知权限。',
      callOnly: '✓ 来电通知已发出；消息通知发送失败，请确认通知权限。',
      bothFailed: '✗ 两条测试通知都未能发出。请先开启通知权限再试。',
    },
    issuesLink: '遇到问题？查看 GitHub Issues',
  },
  en: {
    title: 'Android Permissions',
    desc: '5 permissions decide whether reminders reach you on time. Tap "Open System Settings" to grant; return here and tap "Done, verify".',
    refresh: 'Refresh',
    overall: {
      granted: 'Ready',
      denied: 'Needs setup',
      unknown: 'Partially unverified',
      unavailable: 'Unavailable',
    },
    states: {
      granted: 'Granted',
      denied: 'Denied',
      unknown: 'Unknown',
      unavailable: 'Unavailable',
    },
    openSettings: 'Open System Settings',
    verify: 'Done, verify',
    request: 'Request',
    cannotVerifyHint: 'Cannot be verified automatically; please confirm in system settings then return to the app.',
    items: {
      notifications: ['Notifications', 'Lets Kumiko post messages and call alerts to the notification tray. Required for everything else.'],
      exactAlarm: ['Exact Alarms', 'Lets Kumiko fire timed reminders punctually (< 10 s drift); without it, Android batches them during low-power windows.'],
      fullScreenIntent: ['Full-screen Call', 'Lets reminders pop in full-screen on lock / background (like a real incoming call).'],
      batteryOptimization: ['Background Running', 'Whitelist Kumiko in battery-optimization so the app survives long lock-screen sessions.'],
      lockScreenDisplay: ['Lock-screen Display', 'On Xiaomi / OPPO / vivo you must enable "show on lock screen" / "background pop-up" inside the app permission list.'],
    },
    test: {
      title: 'One-tap Test',
      desc: 'Posts a message notification + a call notification. Lock the screen first to verify the lock-screen pop is allowed.',
      run: 'Run test',
      running: 'Testing…',
      success: '✓ Test notifications posted. Please check the notification tray.',
      messageOnly: '✓ Message notification posted; call notification failed. Please confirm notification permission.',
      callOnly: '✓ Call notification posted; message notification failed. Please confirm notification permission.',
      bothFailed: '✗ Both test notifications failed. Enable the notification permission and try again.',
    },
    issuesLink: 'Having issues? Visit GitHub Issues',
  },
} as const;

type CopyShape = (typeof COPY)['zh'];

function stateTone(state: PermissionState, isDarkMode: boolean): string {
  if (state === 'granted') {
    return isDarkMode
      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
      : 'border-emerald-300 bg-emerald-50 text-emerald-700';
  }
  if (state === 'denied') {
    return isDarkMode
      ? 'border-rose-500/45 bg-rose-500/15 text-rose-200'
      : 'border-rose-300 bg-rose-50 text-rose-700';
  }
  if (state === 'unavailable') {
    return isDarkMode
      ? 'border-[#5b4a37] bg-[#221a14] text-[#c9b395]'
      : 'border-[#e1d4ba] bg-[#f5ecd9] text-[#8a6a39]';
  }
  return isDarkMode
    ? 'border-amber-500/40 bg-amber-500/15 text-amber-200'
    : 'border-amber-300 bg-amber-50 text-amber-700';
}

export const AndroidPermissionsSection: React.FC<AndroidPermissionsSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  language,
  sectionBorder,
  innerCardClass,
  ringtoneFileId,
}) => {
  const copy = COPY[language] as CopyShape;
  const [snapshot, setSnapshot] = useState<PermissionStatusSnapshot | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [testTone, setTestTone] = useState<'idle' | 'success' | 'partial' | 'fail'>('idle');
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const mountedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (mountedRef.current === false) return;
    setIsChecking(true);
    try {
      const next = await getPermissionStatusSnapshot();
      if (!mountedRef.current) return;
      setSnapshot(next);
    } finally {
      if (mountedRef.current) setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      // v2.14.27: warm the slim native bridge once on mount so the first
      // settings-panel open isn't paying the 2-5s descriptor-resolution
      // tax inside the snapshot probe.
      await prewarmKumikoAlarmsPlugin();
      if (!mountedRef.current) return;
      await refresh();
    })();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  // v2.14.27: re-probe when the user comes back from system settings (focus +
  // visibility events). A perm card flips to "granted" the moment we re-read
  // it; cheap and matches user expectations.
  useEffect(() => {
    if (!isOpen) return;
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [isOpen, refresh]);

  const overallState: PermissionState = snapshot?.overall ?? 'unknown';
  const overallCopy = copy.overall[overallState] || copy.overall.unknown;
  const isSupported = snapshot?.supported ?? true;

  const rows: PermissionItem[] = useMemo(() => {
    if (!snapshot) return [];
    return ITEM_ORDER.map((key) => snapshot.items[key]).filter(Boolean);
  }, [snapshot]);

  const handleOpenSettings = useCallback(async (item: PermissionItem) => {
    setBusyKey(`open:${item.key}`);
    try {
      if (item.key === 'notifications') {
        await requestAndroidNotificationPermission();
      } else {
        await openAndroidAlertPermissionSettings(item.key);
      }
    } finally {
      setBusyKey(null);
    }
  }, []);

  const handleVerifyItem = useCallback(async (item: PermissionItem) => {
    setBusyKey(`verify:${item.key}`);
    try {
      await refresh();
    } finally {
      setBusyKey(null);
    }
  }, [refresh]);

  const handleRunTest = useCallback(async () => {
    setBusyKey('test');
    setTestTone('idle');
    setTestMessage(null);
    try {
      const [msgResult, callResult] = await Promise.all([
        runAndroidMessageNotificationTest(),
        runAndroidIncomingCallTest(ringtoneFileId || ''),
      ]);
      if (msgResult.ok && callResult.ok) {
        setTestTone('success');
        setTestMessage(copy.test.success);
      } else if (msgResult.ok) {
        setTestTone('partial');
        setTestMessage(copy.test.messageOnly);
      } else if (callResult.ok) {
        setTestTone('partial');
        setTestMessage(copy.test.callOnly);
      } else {
        setTestTone('fail');
        setTestMessage(copy.test.bothFailed);
      }
    } finally {
      setBusyKey(null);
    }
  }, [copy.test, ringtoneFileId]);

  const buttonClass = isDarkMode
    ? 'border-[#5b4a37] bg-[#1a130d] text-[#f1e6d7] hover:bg-[#231a14]'
    : 'border-[#d8c7aa] bg-[#fbf6ea] text-[#54402d] hover:bg-[#f5ecd9]';
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
            {!isOpen && (
              <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
                {overallCopy}
              </p>
            )}
          </div>
        </div>
        {isOpen ? (
          <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />
        ) : (
          <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />
        )}
      </button>

      <Collapse isOpen={isOpen}>
        <div className="px-4 pb-4 pt-0">
          <div className={innerCardClass}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className={`ka-copy-sm ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{copy.desc}</p>
                <div className={`mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[12px] font-semibold ${stateTone(overallState, isDarkMode)}`}>
                  {overallState === 'granted' ? (
                    <CheckCircle2 size={14} />
                  ) : overallState === 'denied' ? (
                    <XCircle size={14} />
                  ) : (
                    <AlertTriangle size={14} />
                  )}
                  {overallCopy}
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
                    const isOpening = busyKey === `open:${item.key}`;
                    const isVerifying = busyKey === `verify:${item.key}`;
                    return (
                      <div key={item.key} className={`rounded-2xl border p-3 ${isDarkMode ? 'border-[#4e3d2e]/55 bg-[#120e0c]/45' : 'border-[#e8dfd1] bg-[#fbf8f2]'}`}>
                        <div className="flex flex-col gap-3">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`ka-setting-item-title ${isDarkMode ? 'text-[#f1e6d7]' : 'text-[#54402d]'}`}>{labels[0]}</span>
                              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${stateTone(item.state, isDarkMode)}`}>
                                {item.state === 'granted' ? (
                                  <CheckCircle2 size={12} />
                                ) : item.state === 'denied' ? (
                                  <XCircle size={12} />
                                ) : (
                                  <AlertTriangle size={12} />
                                )}
                                {copy.states[item.state]}
                              </span>
                            </div>
                            <p className={`ka-copy-sm mt-1 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{labels[1]}</p>
                            {!item.canVerify && (
                              <p className={`ka-copy-sm mt-1 italic ${isDarkMode ? 'text-amber-200/80' : 'text-amber-700/85'}`}>
                                {copy.cannotVerifyHint}
                              </p>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {item.canOpenSettings && (
                              <button
                                type="button"
                                onClick={() => { void handleOpenSettings(item); }}
                                disabled={!!busyKey}
                                className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-60 ${primaryButtonClass}`}
                              >
                                {isOpening ? <RefreshCw size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                                {item.key === 'notifications' ? copy.request : copy.openSettings}
                              </button>
                            )}
                            {item.canVerify && (
                              <button
                                type="button"
                                onClick={() => { void handleVerifyItem(item); }}
                                disabled={!!busyKey}
                                className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-60 ${buttonClass}`}
                              >
                                {isVerifying ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                                {copy.verify}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className={`mt-4 rounded-2xl border p-3 ${isDarkMode ? 'border-[#4e3d2e]/55 bg-[#120e0c]/45' : 'border-[#e8dfd1] bg-[#fbf8f2]'}`}>
                  <span className={`ka-setting-item-title ${isDarkMode ? 'text-[#f1e6d7]' : 'text-[#54402d]'}`}>{copy.test.title}</span>
                  <p className={`ka-copy-sm mt-1 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{copy.test.desc}</p>
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={handleRunTest}
                      disabled={busyKey === 'test'}
                      className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-60 ${primaryButtonClass}`}
                    >
                      {busyKey === 'test' ? <RefreshCw size={14} className="animate-spin" /> : <Zap size={14} />}
                      {busyKey === 'test' ? copy.test.running : copy.test.run}
                    </button>
                  </div>
                  {testMessage && (
                    <p className={`ka-copy-sm mt-3 whitespace-pre-line ${
                      testTone === 'success'
                        ? (isDarkMode ? 'text-emerald-200' : 'text-emerald-700')
                        : testTone === 'fail'
                          ? (isDarkMode ? 'text-rose-200' : 'text-rose-700')
                          : (isDarkMode ? 'text-amber-200' : 'text-amber-700')
                    }`}>
                      {testMessage}
                    </p>
                  )}
                </div>

                <div className="mt-4 text-center">
                  <a
                    href="https://github.com/oumaekumikoamadeus/kumiko-amadeus/issues"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`ka-copy-sm inline-flex items-center gap-1 underline ${isDarkMode ? 'text-[#b69f87] hover:text-[#f1e6d7]' : 'text-[#8f7458] hover:text-[#54402d]'}`}
                  >
                    <ExternalLink size={12} />
                    {copy.issuesLink}
                  </a>
                </div>
              </>
            )}
          </div>
        </div>
      </Collapse>
    </div>
  );
};
