import React from 'react';
import { BellOff, CalendarClock, Clock3, Pause, Play, Repeat, Trash2, X } from 'lucide-react';
import { Language } from '../../types';

type RelativeReminderItem = {
  id: string;
  event: string;
  dueAt: number;
};

type DailyReminderItem = {
  id: string;
  event: string;
  hour: number;
  minute: number;
  timeZone: string;
  paused?: boolean;
};

interface TaskPanelProps {
  isOpen: boolean;
  onClose: () => void;
  isDarkMode: boolean;
  language: Language;
  relativeReminders: RelativeReminderItem[];
  dailyReminders: DailyReminderItem[];
  onDeleteRelativeReminder: (id: string) => void;
  onDeleteDailyReminder: (id: string) => void;
  onToggleDailyReminderPaused: (id: string) => void;
}

const getTimePartsInTimezone = (date: Date, timeZone: string) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });
  const result: Record<string, string> = {};
  formatter.formatToParts(date).forEach(part => {
    result[part.type] = part.value;
  });
  return {
    dateKey: `${result.year}-${result.month}-${result.day}`,
    hour: Number(result.hour),
    minute: Number(result.minute),
  };
};

const formatCountdown = (dueAt: number, language: Language) => {
  const diff = dueAt - Date.now();
  if (diff <= 0) {
    return language === 'zh' ? '马上就到点了' : 'Due any second';
  }

  const totalSeconds = Math.ceil(diff / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (language === 'zh') {
    if (hours > 0) return `还剩 ${hours}小时${minutes}分钟`;
    if (minutes > 0) return `还剩 ${minutes}分钟${seconds}秒`;
    return `还剩 ${seconds}秒`;
  }

  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0) return `${minutes}m ${seconds}s left`;
  return `${seconds}s left`;
};

const formatDailyTime = (hour: number, minute: number) => {
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
};

const formatNextDailyLabel = (hour: number, minute: number, paused: boolean | undefined, timeZone: string, language: Language) => {
  if (paused) {
    return language === 'zh' ? '已暂停' : 'Paused';
  }

  const nowParts = getTimePartsInTimezone(new Date(), timeZone);
  const isLaterToday = hour > nowParts.hour || (hour === nowParts.hour && minute > nowParts.minute);
  const dayLabel = language === 'zh'
    ? (isLaterToday ? '今天' : '明天')
    : (isLaterToday ? 'Today' : 'Tomorrow');
  return language === 'zh'
    ? `下次：${dayLabel} ${formatDailyTime(hour, minute)} JST`
    : `Next: ${dayLabel} ${formatDailyTime(hour, minute)} JST`;
};

export const TaskPanel: React.FC<TaskPanelProps> = ({
  isOpen,
  onClose,
  isDarkMode,
  language,
  relativeReminders,
  dailyReminders,
  onDeleteRelativeReminder,
  onDeleteDailyReminder,
  onToggleDailyReminderPaused,
}) => {
  if (!isOpen) return null;

  const totalTasks = relativeReminders.length + dailyReminders.length;
  const nextOneTime = relativeReminders.slice().sort((a, b) => a.dueAt - b.dueAt)[0];
  const bgClass = isDarkMode ? 'bg-black/95 border-yellow-900/50' : 'bg-white/95 border-yellow-500/30';
  const textClass = isDarkMode ? 'text-yellow-100' : 'text-gray-800';
  const titleClass = isDarkMode ? 'text-yellow-500' : 'text-[#b8860b]';
  const labelClass = isDarkMode ? 'text-yellow-700' : 'text-yellow-600/80';
  const borderClass = isDarkMode ? 'border-yellow-900/30' : 'border-gray-200';
  const cardClass = isDarkMode
    ? 'bg-black/40 border-yellow-900/20 hover:bg-yellow-900/10'
    : 'bg-gray-50 border-gray-200 hover:bg-yellow-50';
  const footerClass = isDarkMode ? 'bg-black/40 border-yellow-900/30' : 'bg-gray-50 border-gray-200';
  const actionButtonClass = isDarkMode
    ? 'text-yellow-100 hover:bg-red-500/10 hover:text-red-400'
    : 'text-gray-800 hover:bg-red-500/10 hover:text-red-500';
  const secondaryActionClass = isDarkMode
    ? 'text-yellow-200/80 hover:bg-white/5 hover:text-yellow-400'
    : 'text-gray-600 hover:bg-black/5 hover:text-[#b8860b]';
  const pillClass = isDarkMode
    ? 'border-yellow-900/40 bg-yellow-900/20 text-yellow-300'
    : 'border-yellow-300 bg-yellow-100 text-yellow-800';

  return (
    <div className={`absolute top-[4.45rem] right-3 z-40 w-[min(94vw,24rem)] max-h-[74vh] rounded-lg border shadow-2xl flex flex-col overflow-hidden animate-[breathe_0.25s_ease-out] ${bgClass}`}>
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-yellow-600 to-transparent opacity-50"></div>

      <div className={`flex items-center justify-between px-4 py-3 border-b ${borderClass}`}>
        <div className="flex items-center gap-2">
          <CalendarClock size={18} className={titleClass} />
          <div>
            <div className={`font-mono font-bold tracking-wider ${titleClass}`}>
              {language === 'zh' ? '久美子的约定簿' : "Kumiko's Promise Book"}
            </div>
            <div className={`text-[10px] font-mono uppercase tracking-[0.18em] ${labelClass}`}>
              {language === 'zh' ? 'AMADEUS SCHEDULE LEDGER' : 'AMADEUS SCHEDULE LEDGER'}
            </div>
          </div>
        </div>

        <button
          onClick={onClose}
          className={`p-1.5 rounded-full transition-colors ${textClass} ${actionButtonClass}`}
          title={language === 'zh' ? '关闭' : 'Close'}
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin">
        <div className="grid grid-cols-3 gap-2">
          <div className={`rounded border p-3 ${cardClass}`}>
            <div className={`text-[10px] font-mono font-bold uppercase tracking-[0.18em] ${labelClass}`}>
              {language === 'zh' ? '生效中' : 'Active'}
            </div>
            <div className={`mt-1 text-lg font-semibold ${textClass}`}>{totalTasks}</div>
          </div>
          <div className={`rounded border p-3 ${cardClass}`}>
            <div className={`text-[10px] font-mono font-bold uppercase tracking-[0.18em] ${labelClass}`}>
              {language === 'zh' ? '一次性' : 'One-time'}
            </div>
            <div className={`mt-1 text-lg font-semibold ${textClass}`}>{relativeReminders.length}</div>
          </div>
          <div className={`rounded border p-3 ${cardClass}`}>
            <div className={`text-[10px] font-mono font-bold uppercase tracking-[0.18em] ${labelClass}`}>
              {language === 'zh' ? '循环' : 'Recurring'}
            </div>
            <div className={`mt-1 text-lg font-semibold ${textClass}`}>{dailyReminders.length}</div>
          </div>
        </div>

        {nextOneTime && (
          <div className={`rounded border p-3 ${cardClass}`}>
            <div className={`text-[10px] font-mono font-bold uppercase tracking-[0.18em] ${labelClass}`}>
              {language === 'zh' ? '下一个到点' : 'Next due'}
            </div>
            <div className={`mt-1 text-sm font-medium line-clamp-1 ${textClass}`}>{nextOneTime.event}</div>
            <div className={`mt-1 text-xs ${textClass} opacity-70`}>
              {formatCountdown(nextOneTime.dueAt, language)}
            </div>
          </div>
        )}

        {totalTasks === 0 && (
          <div className={`rounded border p-4 text-sm ${cardClass}`}>
            <div className="flex items-center gap-2 font-semibold">
              <Clock3 size={16} className={titleClass} />
              {language === 'zh' ? '当前没有生效中的任务' : 'No active tasks'}
            </div>
            <p className={`mt-2 text-xs leading-6 ${textClass} opacity-70`}>
              {language === 'zh'
                ? '你对她说“3小时后喊我”或者“每天8点20提醒我”，这里就会开始记录。'
                : 'Tell her “remind me in 3 hours” or “every day at 8:20”, and she will keep the promise here.'}
            </p>
          </div>
        )}

        {relativeReminders.length > 0 && (
          <section className="space-y-3">
            <div className={`text-[10px] font-mono font-bold uppercase tracking-[0.22em] ${labelClass}`}>
              {language === 'zh' ? '一次性提醒' : 'One-time reminders'}
            </div>
            {relativeReminders
              .slice()
              .sort((a, b) => a.dueAt - b.dueAt)
              .map(reminder => (
                <div key={reminder.id} className={`rounded border p-3 transition-colors ${cardClass}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Clock3 size={14} className={titleClass} />
                        <span className={`font-medium break-words ${textClass}`}>{reminder.event}</span>
                      </div>
                      <div className={`mt-2 text-xs leading-5 ${textClass} opacity-70`}>
                        {formatCountdown(reminder.dueAt, language)}
                      </div>
                    </div>
                    <button
                      onClick={() => onDeleteRelativeReminder(reminder.id)}
                      className={`shrink-0 rounded-full p-1.5 transition-colors ${textClass} ${actionButtonClass}`}
                      title={language === 'zh' ? '取消任务' : 'Cancel task'}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
          </section>
        )}

        {dailyReminders.length > 0 && (
          <section className="space-y-3">
            <div className={`text-[10px] font-mono font-bold uppercase tracking-[0.22em] ${labelClass}`}>
              {language === 'zh' ? '循环任务' : 'Recurring tasks'}
            </div>
            {dailyReminders
              .slice()
              .sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute))
              .map(reminder => (
                <div key={reminder.id} className={`rounded border p-3 transition-colors ${cardClass}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-medium break-words">
                        <Repeat size={14} className={reminder.paused ? labelClass : titleClass} />
                        <span className={textClass}>{reminder.event}</span>
                        {reminder.paused && (
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${pillClass}`}>
                            {language === 'zh' ? '暂停中' : 'Paused'}
                          </span>
                        )}
                      </div>
                      <div className={`mt-2 text-xs leading-6 ${textClass} opacity-70`}>
                        <div>{formatDailyTime(reminder.hour, reminder.minute)} JST</div>
                        <div>{formatNextDailyLabel(reminder.hour, reminder.minute, reminder.paused, reminder.timeZone, language)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => onToggleDailyReminderPaused(reminder.id)}
                        className={`rounded-full p-1.5 transition-colors ${secondaryActionClass}`}
                        title={reminder.paused ? (language === 'zh' ? '恢复任务' : 'Resume task') : (language === 'zh' ? '暂停任务' : 'Pause task')}
                      >
                        {reminder.paused ? <Play size={16} /> : <Pause size={16} />}
                      </button>
                      <button
                        onClick={() => onDeleteDailyReminder(reminder.id)}
                        className={`rounded-full p-1.5 transition-colors ${textClass} ${actionButtonClass}`}
                        title={language === 'zh' ? '取消任务' : 'Cancel task'}
                      >
                        <BellOff size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
          </section>
        )}
      </div>

      <div className={`px-4 py-2 border-t flex items-center justify-between text-[10px] font-mono ${footerClass}`}>
        <span className={isDarkMode ? 'text-yellow-100/65' : 'text-gray-500'}>
          {language === 'zh' ? `生效任务 ${totalTasks}` : `${totalTasks} active tasks`}
        </span>
        <span className={labelClass}>AMADEUS SCHEDULE LEDGER</span>
      </div>
    </div>
  );
};
