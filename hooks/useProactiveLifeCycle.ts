import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { getAmbientEnvironmentContext } from '../components/app/ambientContext';
import {
  addMessageToStore,
  triggerNativeProactiveMessage as triggerNativeProactiveMessageAction,
} from '../components/app/chatActions';
import type {
  AnchorEntry,
  BackupConfig,
  EmotionType,
  Language,
  LocationConfig,
  Message,
  MessageAlertKind,
  WorldBookEntry,
} from '../types';

type FlowState = 'INTRO' | 'AUTH' | 'CONFIG' | 'APP';

export interface UseProactiveLifeCycleParams {
  flowState: FlowState;
  messages: Message[];
  isTalking: boolean;
  isThinking: boolean;
  language: Language;
  locationConfig: LocationConfig;
  coreMemory: string;
  worldBook: WorldBookEntry[];
  contextLimit: number;
  anchors: AnchorEntry[];
  kumikoNotebook: string;
  backupConfig: BackupConfig;
  setCurrentEmotion: (emotion: EmotionType) => void;
  addMessage: typeof addMessageToStore;
  showBackgroundMessageNotification: (
    text: string,
    kind: MessageAlertKind,
    messageId?: string,
  ) => void;
}

export interface UseProactiveLifeCycleReturn {
  welcomeTriggeredRef: MutableRefObject<boolean>;
  hasGoneToSleepRef: MutableRefObject<boolean>;
  sleepWarningTimestampRef: MutableRefObject<number | null>;
  sleepFarewellSentRef: MutableRefObject<boolean>;
  lateNightWakeRolledRef: MutableRefObject<boolean>;
  lateNightWakeResultRef: MutableRefObject<boolean>;
  lateNightWakeTimestampRef: MutableRefObject<number | null>;
}

export function useProactiveLifeCycle(
  params: UseProactiveLifeCycleParams,
): UseProactiveLifeCycleReturn {
  const {
    flowState,
    messages,
    isTalking,
    isThinking,
    language,
    locationConfig,
    coreMemory,
    worldBook,
    contextLimit,
    anchors,
    kumikoNotebook,
    backupConfig,
    setCurrentEmotion,
    addMessage,
    showBackgroundMessageNotification,
  } = params;

  // Sleep protocol refs
  const hasGoneToSleepRef = useRef<boolean>(false);
  const sleepWarningTimestampRef = useRef<number | null>(null);
  const sleepFarewellSentRef = useRef<boolean>(false);
  const lateNightWakeRolledRef = useRef<boolean>(false);
  const lateNightWakeResultRef = useRef<boolean>(false);
  const lateNightWakeTimestampRef = useRef<number | null>(null);

  // --- SESSION LOCK (ANTI-RACE CONDITION) ---
  const welcomeTriggeredRef = useRef<boolean>(false);

  const triggerNativeProactiveMessage = useCallback(async (gapHours: number, eventDescription: string) => {
    return triggerNativeProactiveMessageAction(
      { welcomeTriggeredRef, hasGoneToSleepRef, sleepWarningTimestampRef, sleepFarewellSentRef, lateNightWakeRolledRef, lateNightWakeResultRef, lateNightWakeTimestampRef },
      gapHours, eventDescription,
    );
  }, [messages, coreMemory, worldBook, contextLimit, locationConfig, anchors, kumikoNotebook, isTalking, isThinking, language, backupConfig, addMessage, showBackgroundMessageNotification]);

  useEffect(() => {
      // Cloud sync was removed from the product; proactive checks used to wait for the
      // initial cloud pull to finish first. Now we proceed directly.
      if (flowState !== 'APP') return;

      const checkProactiveLifeEvent = async () => {
          if (isTalking || isThinking) return;

          // --- DAILY DIARY SETTLEMENT ---
          const now = Date.now();
          const jstDate = new Date(new Date(now).toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
          const hourJST = jstDate.getHours();
          const dateStr = `${jstDate.getFullYear()}-${String(jstDate.getMonth() + 1).padStart(2, '0')}-${String(jstDate.getDate()).padStart(2, '0')}`;
          const ambientEnvironmentContext = await getAmbientEnvironmentContext();
          const isHoliday = ambientEnvironmentContext.includes('今日特殊历法：日本法定节假日');
          
          if (hourJST >= 23 || hourJST < 3) {
            const { db } = await import('../services/db');
            const existingDiary = await db.kumikoDiary.where('date').equals(dateStr).first();
            if (!existingDiary) {
              console.log(`[LifeStream] Triggering daily diary settlement for ${dateStr}`);
              const { generateDailyDiary } = await import('../services/lifeStreamService');
              const todayMessages = messages.filter(m => {
                const mDate = new Date(new Date(m.timestamp).toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
                return mDate.getFullYear() === jstDate.getFullYear() && 
                       mDate.getMonth() === jstDate.getMonth() && 
                       mDate.getDate() === jstDate.getDate();
              });
              const diary = await generateDailyDiary(
                dateStr,
                todayMessages.map(message => ({
                  role: message.role,
                  text: message.text,
                  timestamp: message.timestamp,
                })),
                undefined,
                ambientEnvironmentContext,
                isHoliday,
                false
              );
              if (diary) {
                // Clear today's fragments after settlement
                await db.dailyFragments.where('date').equals(dateStr).delete();
                
                // Embed diary into RAG
                const { embedDiaryToRAG } = await import('../services/lifeStreamService');
                await embedDiaryToRAG(diary);
              }
            }
          }
          // ------------------------------

          // --- GRADUAL SLEEP PROTOCOL (heartbeat) ---
          {
            // Fallback values deliberately chosen to be OUTSIDE the sleep
            // window (22:00, not midday 12:00). If Intl / DateTimeFormat
            // ever throws because of a bad `modelTimezone` (e.g. a typo
            // like "Asia/Tokyoo"), the protocol used to silently act as
            // if it was noon and therefore never trigger sleep at all,
            // which masked the config bug. Using 22:00 keeps sleep
            // behavior close to normal for a JST-aligned user while we
            // surface the misconfiguration in the log.
            let sleepHour = 22, sleepMin = 0;
            try {
              const tp = new Date().toLocaleTimeString('en-GB', {
                timeZone: locationConfig.modelTimezone,
                hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23'
              }).split(':');
              sleepHour = parseInt(tp[0], 10);
              sleepMin = parseInt(tp[1], 10);
            } catch (e) {
              console.warn('[SLEEP-HB] Failed to parse model-timezone clock, falling back to 22:00', {
                modelTimezone: locationConfig?.modelTimezone,
                error: e instanceof Error ? e.message : String(e),
              });
            }

            const sleepWindowNow = (sleepHour === 0 && sleepMin >= 30) || (sleepHour >= 1 && sleepHour < 6);
            const lastMsgTime = messages.length > 0 ? messages[messages.length - 1].timestamp : 0;
            const recentlyActive = lastMsgTime > 0 && (Date.now() - lastMsgTime) < 15 * 60000;

            // 6:00 daily reset
            if (sleepHour >= 6) {
              if (hasGoneToSleepRef.current) {
                console.log("[SLEEP-HB] 6:00 reset");
                setCurrentEmotion('neutral');
              }
              hasGoneToSleepRef.current = false;
              sleepWarningTimestampRef.current = null;
              sleepFarewellSentRef.current = false;
              lateNightWakeRolledRef.current = false;
              lateNightWakeResultRef.current = false;
              lateNightWakeTimestampRef.current = null;
            }

            // Scene A Phase 2: 0:30+ first warning
            if (sleepWindowNow && !hasGoneToSleepRef.current && !sleepWarningTimestampRef.current && recentlyActive && !isTalking && !isThinking) {
              console.log("[SLEEP-HB] Phase 2: Sending first warning");
              sleepWarningTimestampRef.current = Date.now();
              triggerNativeProactiveMessage(0, language === 'zh'
                ? '[系统指令]你现在已经非常困了，必须告诉用户你真的要睡了，不能再聊了。语气自然但坚定，明确表达「我真的要去睡了」。'
                : "[System] You are very sleepy now. Tell the user firmly but naturally that you really need to sleep and can't chat anymore.");
            }

            // Scene A Phase 3: warning + 10min → final goodnight
            if (sleepWarningTimestampRef.current && !sleepFarewellSentRef.current && !isTalking && !isThinking) {
              const sinceWarning = Date.now() - sleepWarningTimestampRef.current;
              const userRepliedAfterWarning = messages.length > 0 &&
                messages[messages.length - 1].role === 'user' &&
                messages[messages.length - 1].timestamp > sleepWarningTimestampRef.current;

              if (sinceWarning >= 10 * 60000 && userRepliedAfterWarning) {
                console.log("[SLEEP-HB] Phase 3: Sending final goodnight");
                sleepFarewellSentRef.current = true;
                triggerNativeProactiveMessage(0, language === 'zh'
                  ? '[系统指令]这是你今晚最后一条消息。自然地承接上文说晚安，明确告诉用户「再发也不会回了哦，晚安」。说完之后你将进入睡眠，不再回复任何消息。'
                  : "[System] This is your final message tonight. Say goodnight naturally, make it clear you won't reply anymore. After this, you will be fully asleep.");
                setTimeout(() => {
                  hasGoneToSleepRef.current = true;
                  setCurrentEmotion('sleepy');
                  console.log("[SLEEP-HB] Entered full sleep after farewell");
                }, 5000);
              }
            }

            // Scene B continuation: late-night wake warning after 10 min
            if (lateNightWakeTimestampRef.current && !sleepWarningTimestampRef.current && !isTalking && !isThinking) {
              const sinceWake = Date.now() - lateNightWakeTimestampRef.current;
              if (sinceWake >= 10 * 60000) {
                console.log("[SLEEP-HB] Late-night wake: 10 min elapsed, starting warning flow");
                sleepWarningTimestampRef.current = Date.now();
                triggerNativeProactiveMessage(0, language === 'zh'
                  ? '[系统指令]你深夜被吵醒已经聊了一会了，现在真的撑不住了，必须告诉用户你要睡了。语气自然但坚定。'
                  : "[System] You were woken up late at night and chatted for a bit. Now you really can't stay awake. Tell the user you need to sleep.");
              }
            }

            // Auto-sleep on long inactivity in sleep window (backup for handleSend)
            if (!hasGoneToSleepRef.current && sleepWindowNow && !recentlyActive && lastMsgTime > 0) {
              const inactiveMin = (Date.now() - lastMsgTime) / 60000;
              if (inactiveMin > 30) {
                console.log("[SLEEP-HB] Auto-sleep: 30+ min inactivity during sleep window");
                hasGoneToSleepRef.current = true;
                setCurrentEmotion('sleepy');
              }
            }
          }
          // --- END GRADUAL SLEEP PROTOCOL ---

          if (localStorage.getItem('enable_proactive_messaging') === 'false') {
              console.log("[Heartbeat] Proactive messaging disabled by user.");
              return;
          }

          const lastMsg = messages[messages.length - 1];
          if (!lastMsg) return;

          const currentTime = Date.now();
          const gapHours = (currentTime - lastMsg.timestamp) / (1000 * 60 * 60);
          
          // COOL DOWN: Require at least 3 hours of silence before proactively messaging
          if (gapHours < 3) return;

          // --- STATE MACHINE DRIVEN PROACTIVE ---
          const { getCurrentKumikoState } = await import('../services/kumikoStateMachine');
          const stateCtx = getCurrentKumikoState(locationConfig.modelTimezone, isHoliday);
          
          let triggerChance = stateCtx.proactiveProbability;
          let eventDescription = stateCtx.stateDescription;

          const recent7DayMessageCount = messages.filter(msg => currentTime - msg.timestamp <= 7 * 24 * 60 * 60 * 1000).length;
          const relationshipWarmthFactor = recent7DayMessageCount >= 120 ? 1.22 : recent7DayMessageCount >= 50 ? 1.12 : recent7DayMessageCount <= 12 ? 0.88 : 1;
          
          triggerChance = Math.min(0.35, triggerChance * relationshipWarmthFactor);

          if (Math.random() <= triggerChance) {
              console.log(`[Heartbeat] Triggering Proactive. State: ${stateCtx.currentState}, Chance: ${triggerChance}`);
              triggerNativeProactiveMessage(gapHours, eventDescription);
          } else {
              console.log(`[Heartbeat] Skipped by RNG. State: ${stateCtx.currentState}, Chance: ${triggerChance}`);
          }
      };

      // Poll every 10 minutes
      const intervalId = setInterval(checkProactiveLifeEvent, 600000);
      
      // Also check shortly after initial load
      const timeoutId = setTimeout(checkProactiveLifeEvent, 15000);

      return () => {
          clearInterval(intervalId);
          clearTimeout(timeoutId);
      };
  }, [messages, flowState, locationConfig, isTalking, isThinking, triggerNativeProactiveMessage]);

  return {
    welcomeTriggeredRef,
    hasGoneToSleepRef,
    sleepWarningTimestampRef,
    sleepFarewellSentRef,
    lateNightWakeRolledRef,
    lateNightWakeResultRef,
    lateNightWakeTimestampRef,
  };
}
