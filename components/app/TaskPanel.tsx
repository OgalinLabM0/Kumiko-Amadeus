import React, { useEffect, useState } from 'react';
import { BellOff, CalendarClock, Clock3, Hourglass, Inbox, Pause, Play, Repeat, Trash2, X } from 'lucide-react';
import { Language } from '../../types';
import { useAppStore } from '../../store';

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

// P2 #52: previously this (and the list row below) hard-coded "JST" as the
// trailing timezone label even though the logic honors `reminder.timeZone`. If
// a user switched to e.g. Asia/Shanghai the label would lie to them. Derive
// the real short zone name via Intl.DateTimeFormat so the displayed string
// matches the timezone the reminder is actually scheduled in.
const formatTimezoneAbbr = (timeZone: string, language: Language): string => {
  try {
    const parts = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
      timeZone,
      timeZoneName: 'short',
    }).formatToParts(new Date());
    const tz = parts.find(p => p.type === 'timeZoneName');
    return tz ? tz.value : timeZone;
  } catch {
    return timeZone;
  }
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
  const tzAbbr = formatTimezoneAbbr(timeZone, language);
  return language === 'zh'
    ? `下次：${dayLabel} ${formatDailyTime(hour, minute)} ${tzAbbr}`
    : `Next: ${dayLabel} ${formatDailyTime(hour, minute)} ${tzAbbr}`;
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
  const busyFollowUp = useAppStore(s => s.busyFollowUp);
  const pendingApology = useAppStore(s => s.pendingApology);

  // Polling clock so countdowns update live while the panel is open.
  // We tick every 1 s but only when `isOpen` is true so the panel
  // doesn't waste cycles in the background.
  const [, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!isOpen) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isOpen]);

  const busyUnreadCount = busyFollowUp?.unreadUserMessageIds.length ?? 0;
  const apologyUnreadCount = pendingApology
    ? pendingApology.sources.reduce((sum, s) => sum + s.unreadUserMessageIds.length, 0)
    : 0;
  const apologySourceCount = pendingApology?.sources.length ?? 0;
  const totalTasks = relativeReminders.length + dailyReminders.length + (busyFollowUp ? 1 : 0) + (pendingApology ? 1 : 0);
  const nextOneTime = relativeReminders.slice().sort((a, b) => a.dueAt - b.dueAt)[0];

  const busyStatusLabel = (() => {
    if (!busyFollowUp) return '';
    const now = Date.now();
    const isPrepared = !!busyFollowUp.preparedAt && !!busyFollowUp.preparedTextParts?.length;
    if (now < busyFollowUp.prepareAt) {
      return language === 'zh' ? '下课前准备中' : 'Preparing near end of slot';
    }
    if (!isPrepared) {
      if (busyFollowUp.failureCount > 0) {
        return language === 'zh'
          ? `接入失败 ${busyFollowUp.failureCount}/4，退避中`
          : `Draft failed ${busyFollowUp.failureCount}/4, backing off`;
      }
      return language === 'zh' ? '正在悄悄组织语言' : 'Drafting silently';
    }
    if (now < busyFollowUp.displayAt) {
      return language === 'zh' ? '准备就绪，等下课后发送' : 'Ready, waiting to send';
    }
    return language === 'zh' ? '即将发送' : 'About to send';
  })();
  const busyCountdownLabel = (() => {
    if (!busyFollowUp) return '';
    const now = Date.now();
    const target = now < busyFollowUp.displayAt ? busyFollowUp.displayAt : now;
    return formatCountdown(target, language);
  })();
  // Dark-mode frosted glass: drop the near-opaque `/96` wash and let
  // `backdrop-blur-md` smear whatever chat bubble sits underneath. 80%
  // fill keeps copy readable but the blur kills the noisy bleed-through
  // users complained about. Light mode stays essentially unchanged and
  // just inherits the same blur class for visual parity.
  const bgClass = isDarkMode
    ? 'bg-[#1f1711]/80 backdrop-blur-md border-[#a88247]/55'
    : 'bg-white/90 backdrop-blur-md border-yellow-500/30';
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
    // Phase 7 Part t9_task_msgcenter: shift the popover down by the iOS
    // notch's safe-area-inset-top and in by safe-area-inset-right so it
    // doesn't hide under the punchhole. Also duplicate the max-h in
    // `dvh` so Safari's dynamic viewport doesn't cut the bottom off when
    // its toolbar is visible. Desktop Electron still gets the 4.45rem
    // top offset (env = 0) and the `74vh` cap.
    <div
      className={`absolute z-40 w-[min(94vw,24rem)] max-h-[74vh] max-h-[74dvh] rounded-lg border shadow-2xl flex flex-col overflow-hidden ${bgClass}`}
      style={{
        top: 'calc(4.45rem + max(var(--sat) - 6px, 0px))',
        right: 'calc(0.75rem + var(--sar))',
        opacity: isOpen ? 1 : 0,
        transform: isOpen ? 'scale(1)' : 'scale(0.96)',
        pointerEvents: isOpen ? 'auto' as const : 'none' as const,
        visibility: isOpen ? 'visible' as const : 'hidden' as const,
        transformOrigin: 'top right',
        transition: isOpen ? 'opacity 250ms ease-out, transform 250ms ease-out, visibility 0s 0s' : 'opacity 180ms ease-in, transform 180ms ease-in, visibility 0s 180ms',
        willChange: 'opacity, transform' as const,
      }}
    >
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-yellow-600 to-transparent opacity-50"></div>

      <div className={`flex items-center justify-between px-4 py-3 border-b ${borderClass}`}>
        <div className="flex items-center gap-2">
          <CalendarClock size={18} className={titleClass} />
          <div>
            <div className={`font-mincho text-[clamp(12px,0.78rem+0.05vw,13px)] font-semibold tracking-[0.008em] leading-[1.18] ${titleClass}`}>
              {language === 'zh' ? '久美子的约定簿' : "Kumiko's Promise Book"}
            </div>
            <div className={`ka-kicker ${labelClass}`}>
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

      <div data-resize-heavy className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin">
        {/* Phase 7 Part t9_task_msgcenter: the stat strip used a
            fixed `p-3` which left the English "Recurring" label
            clipped on a 360px phone. Shrink to `p-2` on narrow
            viewports and allow labels to wrap. */}
        <div className="grid grid-cols-3 gap-2">
          <div className={`rounded border p-2 sm:p-3 ${cardClass}`}>
            <div className={`ka-kicker break-words ${labelClass}`}>
              {language === 'zh' ? '生效中' : 'Active'}
            </div>
            <div className={`mt-1 ka-value ${textClass}`}>{totalTasks}</div>
          </div>
          <div className={`rounded border p-2 sm:p-3 ${cardClass}`}>
            <div className={`ka-kicker break-words ${labelClass}`}>
              {language === 'zh' ? '一次性' : 'One-time'}
            </div>
            <div className={`mt-1 ka-value ${textClass}`}>{relativeReminders.length}</div>
          </div>
          <div className={`rounded border p-2 sm:p-3 ${cardClass}`}>
            <div className={`ka-kicker break-words ${labelClass}`}>
              {language === 'zh' ? '循环' : 'Recurring'}
            </div>
            <div className={`mt-1 ka-value ${textClass}`}>{dailyReminders.length}</div>
          </div>
        </div>

        {nextOneTime && (
          <div className={`rounded border p-3 ${cardClass}`}>
            <div className={`ka-kicker ${labelClass}`}>
              {language === 'zh' ? '下一个到点' : 'Next due'}
            </div>
            <div className={`mt-1 ka-copy line-clamp-1 ${textClass}`}>{nextOneTime.event}</div>
            <div className={`mt-1 ka-copy-sm ${textClass} opacity-70`}>
              {formatCountdown(nextOneTime.dueAt, language)}
            </div>
          </div>
        )}

        {busyFollowUp && (
          <div className={`rounded border p-3 ${cardClass}`}>
            <div className="flex items-start gap-2">
              <Hourglass size={14} className={`mt-0.5 shrink-0 ${titleClass}`} />
              <div className="min-w-0 flex-1">
                <div className={`ka-kicker ${labelClass}`}>
                  {language === 'zh' ? '待主动回复' : 'Pending auto-reply'}
                </div>
                <div className={`mt-1 ka-copy break-words ${textClass}`}>
                  {busyFollowUp.slotDescription}
                </div>
                <div className={`mt-1 ka-copy-sm ${textClass} opacity-80`}>
                  {busyStatusLabel}
                </div>
                <div className={`mt-1 flex items-center gap-2 flex-wrap ka-copy-sm ${textClass} opacity-70`}>
                  <span>{busyCountdownLabel}</span>
                  <span className={`px-1.5 py-0.5 rounded ka-micro border ${pillClass}`}>
                    {language === 'zh'
                      ? `未读 ${busyUnreadCount}`
                      : `${busyUnreadCount} unread`}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {pendingApology && apologyUnreadCount > 0 && (
          <div className={`rounded border p-3 ${cardClass}`}>
            <div className="flex items-start gap-2">
              <Inbox size={14} className={`mt-0.5 shrink-0 ${titleClass}`} />
              <div className="min-w-0 flex-1">
                <div className={`ka-kicker ${labelClass}`}>
                  {language === 'zh' ? '积压未读，等下次开口' : 'Backlog awaiting next turn'}
                </div>
                <div className={`mt-1 ka-copy break-words ${textClass}`}>
                  {language === 'zh'
                    ? `累计 ${apologySourceCount} 段忙碌、${apologyUnreadCount} 条未读`
                    : `${apologySourceCount} busy blocks, ${apologyUnreadCount} unread`}
                </div>
                <div className={`mt-1 ka-copy-sm ${textClass} opacity-70`}>
                  {language === 'zh'
                    ? '你再开口时，她会一次性简短道歉并挑几条接上。'
                    : 'Next time you message her, she will apologise once and weave a few back in.'}
                </div>
              </div>
            </div>
          </div>
        )}

        {totalTasks === 0 && (
          <div className={`rounded border p-4 ${cardClass}`}>
            <div className="flex items-center gap-2 ka-setting-item-title">
              <Clock3 size={16} className={titleClass} />
              {language === 'zh' ? '当前没有生效中的任务' : 'No active tasks'}
            </div>
            <p className={`mt-2 ka-copy-sm ${textClass} opacity-70`}>
              {language === 'zh'
                ? '你对她说"3小时后喊我"或者"每天8点20提醒我"，这里就会开始记录。'
                : 'Tell her "remind me in 3 hours" or "every day at 8:20", and she will keep the promise here.'}
            </p>
          </div>
        )}

        {relativeReminders.length > 0 && (
          <section className="space-y-3">
            <div className={`ka-kicker ${labelClass}`}>
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
                        <span className={`ka-copy break-words ${textClass}`}>{reminder.event}</span>
                      </div>
                      <div className={`mt-2 ka-copy-sm ${textClass} opacity-70`}>
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
            <div className={`ka-kicker ${labelClass}`}>
              {language === 'zh' ? '循环任务' : 'Recurring tasks'}
            </div>
            {dailyReminders
              .slice()
              .sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute))
              .map(reminder => (
                <div key={reminder.id} className={`rounded border p-3 transition-colors ${cardClass}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 break-words">
                        <Repeat size={14} className={reminder.paused ? labelClass : titleClass} />
                        <span className={`ka-copy ${textClass}`}>{reminder.event}</span>
                        {reminder.paused && (
                          <span className={`px-1.5 py-0.5 rounded ka-micro border ${pillClass}`}>
                            {language === 'zh' ? '暂停中' : 'Paused'}
                          </span>
                        )}
                      </div>
                      <div className={`mt-2 ka-copy-sm ${textClass} opacity-70`}>
                        <div>{formatDailyTime(reminder.hour, reminder.minute)} {formatTimezoneAbbr(reminder.timeZone, language)}</div>
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

      <div className={`px-4 py-2 border-t flex items-center justify-between ka-micro ${footerClass}`}>
        <span className={isDarkMode ? 'text-yellow-100/65' : 'text-gray-500'}>
          {language === 'zh' ? `生效任务 ${totalTasks}` : `${totalTasks} active tasks`}
        </span>
        <span className={labelClass}>AMADEUS SCHEDULE LEDGER</span>
      </div>
    </div>
  );
};
