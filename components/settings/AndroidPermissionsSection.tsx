import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  getAndroidAlertPermissionSnapshot,
  openAndroidAlertPermissionSettings,
  requestAndroidNotificationPermission,
  runAndroidIncomingCallTest,
  runAndroidMessageNotificationTest,
  type AndroidAlertPermissionItem,
  type AndroidAlertPermissionKey,
  type AndroidAlertPermissionSnapshot,
  type AndroidAlertPermissionState,
} from '../../services/androidAlertPermissionService';

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
  },
  en: {
    title: 'Android Permission Check',
    desc: 'Verify notifications, exact alarms, and incoming-call UI.',
    ready: 'Background alert pipeline is ready',
    needsSetup: 'Some permissions still need setup',
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
    try {
      const next = await getAndroidAlertPermissionSnapshot();
      setSnapshot(next);
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
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
        : copy.needsSetup;

  const rows = useMemo(() => (
    ITEM_ORDER.map((key) => snapshot?.items[key]).filter(Boolean) as AndroidAlertPermissionItem[]
  ), [snapshot]);

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

  const reasonText = useCallback((reason?: string) => {
    if (reason === 'native-failed') return copy.nativeFailed;
    return copy.failed;
  }, [copy.failed, copy.nativeFailed]);

  const handleTestMessage = useCallback(async () => {
    setBusyKey('test-message');
    setMessage('');
    try {
      const result = await runAndroidMessageNotificationTest();
      setMessage(result.ok ? copy.submittedMessage : reasonText(result.reason));
      await refresh();
    } finally {
      setBusyKey(null);
    }
  }, [copy.submittedMessage, reasonText, refresh]);

  const handleTestCall = useCallback(async () => {
    setBusyKey('test-call');
    setMessage('');
    try {
      const result = await runAndroidIncomingCallTest(ringtoneFileId);
      setMessage(result.ok ? copy.submittedCall : reasonText(result.reason));
      await refresh();
    } finally {
      setBusyKey(null);
    }
  }, [copy.submittedCall, reasonText, refresh, ringtoneFileId]);

  const handleClearTests = useCallback(async () => {
    setBusyKey('clear-tests');
    try {
      await clearAndroidAlertTests();
      setMessage(copy.cleared);
    } finally {
      setBusyKey(null);
    }
  }, [copy.cleared]);

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
                      disabled={!!busyKey}
                      className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-60 ${buttonClass}`}
                    >
                      {busyKey === 'clear-tests' ? <RefreshCw size={14} className="animate-spin" /> : <XCircle size={14} />}
                      {copy.clearTests}
                    </button>
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
