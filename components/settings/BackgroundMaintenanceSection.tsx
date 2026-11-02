import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../services/db';
import { SettingsToggle } from './SettingsToggle';

const PAUSE_KEY = 'kumiko_background_network_paused_v1';

export function BackgroundMaintenanceSection({ language, isDarkMode }: { language: 'zh' | 'en'; isDarkMode: boolean }) {
  const paused = useLiveQuery(() => db.getVal(PAUSE_KEY, false), [], false);
  const [error, setError] = useState(false);
  const label = language === 'zh' ? '暂停后台联网' : 'Pause background network requests';
  return <div className={`rounded-2xl border p-4 ${isDarkMode ? 'border-white/10 text-[#f5ebdc]' : 'border-stone-200 text-[#49301f]'}`}>
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="ka-setting-item-title">{label}</div>
        <p className="ka-copy-sm mt-1">{language === 'zh'
          ? '暂停新的后台联网任务；已发出的请求可完成。本地整理、提醒和备份继续运行。'
          : 'Pause new background network requests. Requests already sent may finish. Local maintenance, reminders and backups continue.'}</p>
      </div>
      <SettingsToggle checked={paused} ariaLabel={label} activeTrackClass="bg-amber-600" inactiveTrackClass="bg-stone-400"
        onClick={() => { void db.setVal(PAUSE_KEY, !paused).then(() => setError(false)).catch(() => setError(true)); }} />
    </div>
    {error && <p role="alert" className="mt-2 text-sm text-red-500">{language === 'zh' ? '设置未能保存，请重试。' : 'Could not save this setting. Please try again.'}</p>}
  </div>;
}
