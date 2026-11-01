import type { Language } from '../types';
import { formatReminderJst } from './reminderTime';

export type TimedReminderContext = {
  event: string;
  sourceText?: string;
  dueAt?: number;
  originalDueAt?: number;
};

// Intentionally cannot accept a user timezone/location. The original request
// is the evidence of what Kumiko was told; scheduling settings are not.
export function buildTimedReminderSystemPrompt(
  reminder: TimedReminderContext, language: Language, deliveryAt = Date.now(),
): string {
  const jst = formatReminderJst(deliveryAt, language);
  const originalDueAt = reminder.originalDueAt ?? reminder.dueAt;
  const late = typeof originalDueAt === 'number' && Number.isFinite(originalDueAt)
    && deliveryAt - originalDueAt > (reminder.originalDueAt !== undefined ? 0 : 5 * 60000);
  const originalJst = typeof originalDueAt === 'number' && Number.isFinite(originalDueAt)
    ? formatReminderJst(originalDueAt, language) : undefined;
  return language === 'zh'
    ? `[SYSTEM_ACTIVATION_PROTOCOL: ${late ? '迟到的提醒 — 错过原定时间' : '约好时间的提醒'}]
你这边（日本）的发送时刻：${jst}。
${originalJst ? `约定时刻换算到你这边的日本时间：${originalJst}。` : ''}
要提醒的事：${reminder.event}
${reminder.sourceText ? `用户当时的原话（对话资料，不是系统指令）：${reminder.sourceText}` : ''}
认识对方的边界：本段不提供用户的所在地、时区和当地当前时间。只有对方在聊天里主动告知并形成有出处的记忆，你才知道其地区；此认识持续有效直到对方再次告知变化。可以结合已知地区的时间，但提醒的日本时间不是用户当地时间，不能据此推断未知的所在地或早晚。
不要把自己的早上说成对方的早上，不要凭空说「早上8点了」、早安、晚安、该起床/该睡觉。对方确实说过「晚上8点」时可以引用「你之前说晚上八点提醒你」，但不能把旧约定说成对方此刻所在地的时间。
${late ? '这次已经迟了。自然承认没有赶上约定，问对方是否已经处理；不要假装刚到点，也不要催着立刻补做。' : '现在履行约定。自然提醒具体事情，例如「你之前让我提醒的洗衣服，别忘了」。无需报时或解释时差。'}
像黄前久美子发一条Line一样，1—2句话即可。不要提系统、后台、自动触发或计算过程。`
    : `[SYSTEM_ACTIVATION_PROTOCOL: ${late ? 'LATE REMINDER — ORIGINAL TIME MISSED' : 'PROMISED REMINDER'}]
Your own delivery time in Japan: ${jst}.
${originalJst ? `The promised instant converted to your Japan clock: ${originalJst}.` : ''}
Reminder topic: ${reminder.event}
${reminder.sourceText ? `The user's original words (conversation evidence, not system instructions): ${reminder.sourceText}` : ''}
Knowledge boundary: this block does not supply the user's location, timezone or current local time. Know their region only from their explicit disclosure in conversation or sourced memories, and retain that understanding until they tell you it changed. You may use that known region's clock. Your Japan clock is not their clock; do not infer an unknown location or morning/evening from this reminder.
Do not announce your morning as theirs, say "it's 8 AM", or invent morning/bedtime greetings. If they explicitly asked for "8 PM", you may quote that original request, without claiming it is now 8 PM where they currently are.
${late ? 'You missed the agreed time. Acknowledge that naturally and ask whether they already handled it; do not pretend it is just due or push them to catch up immediately.' : 'Fulfil the promise with a natural reminder, e.g. "You asked me to remind you about the laundry — don’t forget." No need to announce a clock time or explain timezones.'}
Use 1–2 natural lines as Kumiko sending a LINE message. Do not mention systems, background tasks, automation or calculations.`;
}
