import React from 'react';
import { BellRing, Clock3, MessageSquareText, Trash2, X } from 'lucide-react';
import { Language } from '../../types';

type MessageAlertItem = {
  id: string;
  messageId: string;
  preview: string;
  timestamp: number;
  kind: 'reply' | 'proactive' | 'reminder';
  isRead?: boolean;
};

interface MessageCenterPanelProps {
  isOpen: boolean;
  onClose: () => void;
  isDarkMode: boolean;
  language: Language;
  unreadCount: number;
  alerts: MessageAlertItem[];
  onOpenMessage: (messageId: string) => void;
  onDismissAlert: (id: string) => void;
  onClearAlerts: () => void;
}

const formatTime = (timestamp: number, language: Language) => {
  return new Date(timestamp).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
};

const getKindLabel = (kind: MessageAlertItem['kind'], language: Language) => {
  if (language === 'zh') {
    if (kind === 'reminder') return '定时提醒';
    if (kind === 'proactive') return '主动来信';
    return '新回复';
  }

  if (kind === 'reminder') return 'Reminder';
  if (kind === 'proactive') return 'Proactive';
  return 'Reply';
};

export const MessageCenterPanel: React.FC<MessageCenterPanelProps> = ({
  isOpen,
  onClose,
  isDarkMode,
  language,
  unreadCount,
  alerts,
  onOpenMessage,
  onDismissAlert,
  onClearAlerts
}) => {
  if (!isOpen) return null;

  const bgClass = isDarkMode ? 'bg-black/95 border-yellow-900/50' : 'bg-white/95 border-yellow-500/30';
  const textClass = isDarkMode ? 'text-yellow-100' : 'text-gray-800';
  const titleClass = isDarkMode ? 'text-yellow-500' : 'text-[#b8860b]';
  const labelClass = isDarkMode ? 'text-yellow-700' : 'text-yellow-600/80';
  const borderClass = isDarkMode ? 'border-yellow-900/30' : 'border-gray-200';
  const cardClass = isDarkMode
    ? 'bg-black/40 border-yellow-900/20 hover:bg-yellow-900/10'
    : 'bg-gray-50 border-gray-200 hover:bg-yellow-50';
  const pillClass = isDarkMode
    ? 'border-yellow-900/40 bg-yellow-900/20 text-yellow-300'
    : 'border-yellow-300 bg-yellow-100 text-yellow-800';
  const mutedClass = isDarkMode ? 'text-yellow-100/65' : 'text-gray-500';
  const closeButtonClass = isDarkMode
    ? 'hover:bg-red-500/10 hover:text-red-400'
    : 'hover:bg-red-500/10 hover:text-red-500';

  return (
    <div className={`absolute top-[4.45rem] right-3 z-40 w-[min(94vw,24rem)] max-h-[72vh] rounded-lg border shadow-2xl flex flex-col overflow-hidden animate-[breathe_0.25s_ease-out] ${bgClass}`}>
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-yellow-600 to-transparent opacity-50"></div>

      <div className={`flex items-center justify-between px-4 py-3 border-b ${borderClass}`}>
        <div className="flex items-center gap-2">
          <BellRing size={18} className={titleClass} />
          <div>
            <div className={`font-mincho text-[clamp(12px,0.78rem+0.05vw,13px)] font-semibold tracking-[0.008em] leading-[1.18] ${titleClass}`}>
              {language === 'zh' ? '消息中心' : 'Message Center'}
            </div>
            <div className={`ka-kicker ${labelClass}`}>
              {language === 'zh' ? 'AMADEUS MESSAGE LOG' : 'AMADEUS MESSAGE LOG'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <span className={`px-2 py-0.5 rounded ka-micro border ${pillClass}`}>
              {language === 'zh' ? `未读 ${unreadCount}` : `${unreadCount} unread`}
            </span>
          )}
          {alerts.length > 0 && (
            <button
              onClick={onClearAlerts}
              className={`p-1.5 rounded-full transition-colors ${textClass} ${closeButtonClass}`}
              title={language === 'zh' ? '清空消息中心' : 'Clear message center'}
            >
              <Trash2 size={16} />
            </button>
          )}
          <button
            onClick={onClose}
            className={`p-1.5 rounded-full transition-colors ${textClass} ${closeButtonClass}`}
            title={language === 'zh' ? '关闭' : 'Close'}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3 scrollbar-thin">
        {alerts.length === 0 ? (
          <div className={`rounded border p-4 ${cardClass}`}>
            <div className="flex items-center gap-2 ka-setting-item-title">
              <MessageSquareText size={16} className={titleClass} />
              {language === 'zh' ? '当前没有遗漏来信' : 'No missed messages'}
            </div>
            <p className={`mt-2 ka-copy-sm ${textClass} opacity-70`}>
              {language === 'zh'
                ? '等久美子在后台给你发来回复、主动消息或提醒时，这里会留下记录。'
                : 'Replies, proactive notes, and reminders sent while you are away will collect here.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {alerts.map(alert => (
              <div
                key={alert.id}
                className={`group rounded border transition-colors ${cardClass}`}
              >
                <div className="flex items-start justify-between gap-3 p-3">
                  <button
                    type="button"
                    onClick={() => onOpenMessage(alert.messageId)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`inline-flex items-center gap-1 rounded px-2 py-1 ka-micro border ${
                          alert.isRead
                            ? (isDarkMode ? 'border-yellow-900/30 bg-black/30 text-yellow-200/70' : 'border-yellow-200 bg-yellow-50 text-yellow-700')
                            : pillClass
                        }`}
                      >
                        {alert.kind === 'reminder' ? <Clock3 size={11} /> : <MessageSquareText size={11} />}
                        {getKindLabel(alert.kind, language)}
                      </span>
                      <span className={`ka-micro ${labelClass}`}>
                        {formatTime(alert.timestamp, language)}
                      </span>
                      {!alert.isRead && (
                        <span className={`px-1.5 py-0.5 rounded ka-micro border ${pillClass}`}>
                          {language === 'zh' ? '未读' : 'Unread'}
                        </span>
                      )}
                    </div>

                    <p className={`mt-2 line-clamp-3 pr-2 ka-copy-sm ${textClass}`}>
                      {alert.preview}
                    </p>
                  </button>

                  <button
                    onClick={() => onDismissAlert(alert.id)}
                    className={`shrink-0 rounded-full p-1.5 transition-colors ${textClass} ${closeButtonClass}`}
                    title={language === 'zh' ? '移除记录' : 'Dismiss'}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={`px-4 py-2 border-t flex items-center justify-between ka-micro ${isDarkMode ? 'bg-black/40 border-yellow-900/30' : 'bg-gray-50 border-gray-200'}`}>
        <span className={mutedClass}>
          {language === 'zh' ? `记录数 ${alerts.length}` : `${alerts.length} entries`}
        </span>
        <span className={labelClass}>AMADEUS MESSAGE LOG</span>
      </div>
    </div>
  );
};
