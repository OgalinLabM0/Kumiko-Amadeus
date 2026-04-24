import { useEffect, useState } from 'react';
import { Language } from '../../types';
import { SettingsDialogConfig } from './useSettingsDialog';
import {
  PREFERENCES_UPDATED_EVENT,
  queueLocalStoragePreferenceSync,
} from '../../services/preferencesSync';

// F2B.4: trimmed to just the proactive-messaging toggle. The Web Push
// subscription path was for the legacy PWA + ping-server setup; with the
// PWA bridge gone, Capacitor uses Android Foreground Service +
// AlarmManager + Local Notifications instead, and Electron uses native
// Windows notifications. Neither needs a service-worker push subscription.

type ShowDialog = (config: Omit<SettingsDialogConfig, 'isOpen'>) => void;

export const useProactivePushSettings = (
  language: Language,
  showDialog: ShowDialog
) => {
  const readEnabled = () => localStorage.getItem('enable_proactive_messaging') !== 'false';
  const [enableProactive, setEnableProactive] = useState(() => readEnabled());

  const handleToggleProactive = () => {
    const newVal = !enableProactive;
    setEnableProactive(newVal);
    queueLocalStoragePreferenceSync('enable_proactive_messaging', String(newVal));

    const actualValue = localStorage.getItem('enable_proactive_messaging');
    const verified = actualValue === String(newVal);

    showDialog({
      title: language === 'zh'
        ? (newVal ? '主动消息已开启' : '主动消息已关闭')
        : (newVal ? 'Proactive Messaging ON' : 'Proactive Messaging OFF'),
      message: language === 'zh'
        ? `状态验证：${verified ? '写入成功' : '写入异常'}\n当前存储值：${actualValue}\n\n${newVal ? '久美子将会在合适的时间段主动给你发消息（基于日本时间的教师日程，需等待至少 3 小时的沉默冷却期）。' : '久美子不会再主动发送消息，但你仍然可以正常聊天。'}`
        : `Verification: ${verified ? 'Write confirmed' : 'Write failed'}\nStored value: ${actualValue}\n\n${newVal ? 'Kumiko will proactively message you during appropriate time slots (JST teacher schedule, requires 3h silence cooldown).' : 'Kumiko will no longer send proactive messages, but normal chat still works.'}`,
      type: 'alert'
    });
  };

  useEffect(() => {
    const handlePreferencesUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ keys?: string[] }>).detail;
      if (Array.isArray(detail?.keys) && detail.keys.includes('enable_proactive_messaging')) {
        setEnableProactive(readEnabled());
      }
    };
    window.addEventListener(PREFERENCES_UPDATED_EVENT, handlePreferencesUpdated as EventListener);
    return () => {
      window.removeEventListener(PREFERENCES_UPDATED_EVENT, handlePreferencesUpdated as EventListener);
    };
  }, []);

  return {
    enableProactive,
    handleToggleProactive,
  };
};
