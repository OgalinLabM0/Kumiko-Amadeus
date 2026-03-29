import { useEffect, useState } from 'react';
import { Language, LocationConfig } from '../../types';

export const useLocationPreview = (
  isOpen: boolean,
  locationConfig: LocationConfig | undefined,
  language: Language
) => {
  const [previewTime, setPreviewTime] = useState('');
  const [modelPreviewTime, setModelPreviewTime] = useState('');

  useEffect(() => {
    if (!isOpen || !locationConfig) return;

    const update = () => {
      try {
        const now = new Date();
        const isZh = language === 'zh';
        const previewLabel = isZh ? '预览' : 'Preview';

        const getPhase = (hour: number) => {
          if (hour >= 5 && hour < 11) return isZh ? '早晨' : 'Morning';
          if (hour >= 11 && hour < 13) return isZh ? '中午' : 'Noon';
          if (hour >= 13 && hour < 18) return isZh ? '下午' : 'Afternoon';
          if (hour >= 18 && hour < 23) return isZh ? '晚上' : 'Evening';
          return isZh ? '深夜' : 'Late Night';
        };

        const userTimeStr = now.toLocaleTimeString('en-GB', {
          timeZone: locationConfig.userTimezone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
        const userHour = parseInt(now.toLocaleTimeString('en-GB', {
          timeZone: locationConfig.userTimezone,
          hour: 'numeric',
          hour12: false,
          hourCycle: 'h23'
        }), 10);
        setPreviewTime(`${previewLabel}: ${userTimeStr} - ${getPhase(userHour)}`);

        const modelTimeStr = now.toLocaleTimeString('en-GB', {
          timeZone: locationConfig.modelTimezone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
        const modelHour = parseInt(now.toLocaleTimeString('en-GB', {
          timeZone: locationConfig.modelTimezone,
          hour: 'numeric',
          hour12: false,
          hourCycle: 'h23'
        }), 10);
        setModelPreviewTime(`${previewLabel}: ${modelTimeStr} - ${getPhase(modelHour)}`);
      } catch {
        setPreviewTime('Invalid Timezone');
        setModelPreviewTime('Invalid Timezone');
      }
    };

    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [isOpen, locationConfig?.userTimezone, locationConfig?.modelTimezone, language]);

  return { previewTime, modelPreviewTime };
};
