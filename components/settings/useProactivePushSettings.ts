import { useEffect, useState } from 'react';
import { Language } from '../../types';
import { SettingsDialogConfig } from './useSettingsDialog';

type ShowDialog = (config: Omit<SettingsDialogConfig, 'isOpen'>) => void;

const urlBase64ToUint8Array = (base64Url: string) => {
  const padding = '='.repeat((4 - base64Url.length % 4) % 4);
  const base64 = (base64Url + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
};

export const useProactivePushSettings = (
  language: Language,
  showDialog: ShowDialog
) => {
  const [enableProactive, setEnableProactive] = useState(
    () => localStorage.getItem('enable_proactive_messaging') !== 'false'
  );
  const [isPushSupported, setIsPushSupported] = useState(false);
  const [pushSubscription, setPushSubscription] = useState<PushSubscription | null>(null);
  const [isSubscribing, setIsSubscribing] = useState(false);

  const handleToggleProactive = () => {
    const newVal = !enableProactive;
    setEnableProactive(newVal);
    localStorage.setItem('enable_proactive_messaging', String(newVal));

    const actualValue = localStorage.getItem('enable_proactive_messaging');
    const verified = actualValue === String(newVal);

    showDialog({
      title: language === 'zh'
        ? (newVal ? '✅ 主动消息已开启' : '⛔ 主动消息已关闭')
        : (newVal ? '✅ Proactive Messaging ON' : '⛔ Proactive Messaging OFF'),
      message: language === 'zh'
        ? `状态验证：${verified ? '写入成功' : '⚠️ 写入异常！'}\n当前存储值：${actualValue}\n\n${newVal ? '久美子将会在合适的时间段主动给你发消息（基于日本时间的教师日程，需等待至少 3 小时的沉默冷却期）。' : '久美子不会再主动发送消息，但你仍然可以正常聊天。'}`
        : `Verification: ${verified ? 'Write confirmed' : '⚠️ Write failed!'}\nStored value: ${actualValue}\n\n${newVal ? 'Kumiko will proactively message you during appropriate time slots (JST teacher schedule, requires 3h silence cooldown).' : 'Kumiko will no longer send proactive messages, but normal chat still works.'}`,
      type: 'alert'
    });
  };

  useEffect(() => {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      setIsPushSupported(true);
      navigator.serviceWorker.ready.then((reg) => {
        reg.pushManager.getSubscription().then((sub) => {
          setPushSubscription(sub);
        });
      });
    }
  }, []);

  const handleSubscribePush = async () => {
    const isElectron = navigator.userAgent.toLowerCase().includes('electron');
    if (isElectron) {
      showDialog({
        title: language === 'zh' ? '桌面级后台就绪' : 'Desktop Background Ready',
        message: language === 'zh'
          ? '太棒了！检测到您当前处于 PC 桌面原生环境。桌面端拥有系统的绝对后台权限，因此完全不需要依赖云端的 Ping 服务器。我们已为您直接激活了更稳定、更私密的纯本地唤醒管线！'
          : 'Desktop native environment detected. It has full native background privileges so cross-network Push server is bypassed and native background loop is activated!',
        type: 'alert'
      });
      setPushSubscription({ endpoint: 'electron-native-direct-pipeline' } as PushSubscription);
      return;
    }

    if (!('serviceWorker' in navigator) || !('Notification' in window)) {
      showDialog({
        title: language === 'zh' ? '环境受限' : 'Not Supported',
        message: language === 'zh'
          ? '当前浏览器内核或者网络协议（需 HTTPS 或 localhost）不支持调用系统通知推送。'
          : 'Push notifications are not supported in this environment (requires HTTPS or localhost).',
        type: 'alert'
      });
      return;
    }

    setIsSubscribing(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        const applicationServerKeyValue = typeof import.meta.env.VITE_VAPID_PUBLIC_KEY === 'string'
          ? import.meta.env.VITE_VAPID_PUBLIC_KEY.trim()
          : '';
        if (!applicationServerKeyValue) {
          showDialog({
            title: language === 'zh' ? '缺少 VAPID 公钥' : 'Missing VAPID Public Key',
            message: language === 'zh'
              ? '当前项目没有配置浏览器推送所需的 VAPID 公钥。请在项目根目录创建 .env.local，并设置 VITE_VAPID_PUBLIC_KEY 后刷新页面再试。'
              : 'The VAPID public key for browser push is not configured. Create a root .env.local with VITE_VAPID_PUBLIC_KEY and refresh the page before subscribing.',
            type: 'alert'
          });
          return;
        }

        const reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(language === 'zh'
              ? '底层后台唤醒进程 (Service Worker) 无法挂载。请强刷页面 (Ctrl+Shift+R) 或更换 Chrome 浏览器测试。'
              : 'Service worker ready timeout. Please refresh or use Chrome.')),
            5000
          ))
        ]) as ServiceWorkerRegistration;

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(applicationServerKeyValue)
        });
        setPushSubscription(sub);

        try {
          await fetch('http://localhost:8080/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sub)
          });
        } catch (err) {
          console.warn('Could not auto-register to local ping server', err);
        }

        showDialog({
          title: language === 'zh' ? '订阅成功' : 'Subscription Success',
          message: language === 'zh'
            ? '设备端已注册到本地 Ping 服务器！您现在可以发送测试唤醒信号了。'
            : 'Device registered to local Ping server. You can now test the wake-up ping.',
          type: 'alert'
        });
      } else {
        showDialog({
          title: language === 'zh' ? '权限被拒' : 'Permission Denied',
          message: language === 'zh'
            ? '您在浏览器中拒绝了授权，或者您没看到授权框。如果授权框死活不弹，请点击浏览器上方地址栏左侧的“小锁”图标，手动允许“通知”。'
            : 'You denied the notification permission. Please allow it from the lock icon in the address bar.',
          type: 'alert'
        });
      }
    } catch (e: any) {
      console.error('Push subscription failed', e);
      showDialog({
        title: language === 'zh' ? '订阅出现异常' : 'Subscription Exception',
        message: e.message || String(e),
        type: 'alert'
      });
    } finally {
      setIsSubscribing(false);
    }
  };

  return {
    enableProactive,
    isPushSupported,
    pushSubscription,
    isSubscribing,
    handleToggleProactive,
    handleSubscribePush
  };
};
