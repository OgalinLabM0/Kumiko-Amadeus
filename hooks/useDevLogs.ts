import { useState, useEffect, useRef } from 'react';
import type { AIConfig } from '../types';

type DevLogLevel = 'log' | 'warn' | 'error';

export type DevLogEntry = {
  level: DevLogLevel;
  message: string;
  timestamp: string;
};

const DEV_LOG_LIMIT = 200;
const DEV_LOG_FLUSH_INTERVAL_MS = 80;
const DEV_LOG_MAX_MESSAGE_LENGTH = 2400;
const DEV_LOG_MAX_ARRAY_PREVIEW = 4;
const DEV_LOG_MAX_OBJECT_KEYS = 8;
const DEV_LOG_MAX_DEPTH = 2;

const truncateLogText = (value: string, maxLength: number = DEV_LOG_MAX_MESSAGE_LENGTH) => {
  if (value.length <= maxLength) return value;
  const omittedCount = value.length - maxLength;
  return `${value.slice(0, maxLength)}... [${omittedCount} chars truncated]`;
};

const summarizeValueForLog = (
  value: unknown,
  depth: number = 0,
  seen: WeakSet<object> = new WeakSet<object>()
): unknown => {
  if (typeof value === 'string') return truncateLogText(value);
  if (value instanceof Error) return truncateLogText(value.stack || value.message || String(value));
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return truncateLogText(String(value));

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    if (depth >= DEV_LOG_MAX_DEPTH) return `[Array(${value.length})]`;
    const preview = value
      .slice(0, DEV_LOG_MAX_ARRAY_PREVIEW)
      .map(item => summarizeValueForLog(item, depth + 1, seen));
    const omittedCount = value.length - Math.min(value.length, DEV_LOG_MAX_ARRAY_PREVIEW);
    return {
      preview,
      ...(omittedCount > 0 ? { omitted: omittedCount } : {}),
    };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (depth >= DEV_LOG_MAX_DEPTH) return `[Object keys=${entries.length}]`;

  const summary: Record<string, unknown> = {};
  entries.slice(0, DEV_LOG_MAX_OBJECT_KEYS).forEach(([key, nested]) => {
    summary[key] = summarizeValueForLog(nested, depth + 1, seen);
  });
  const omittedCount = entries.length - Math.min(entries.length, DEV_LOG_MAX_OBJECT_KEYS);
  if (omittedCount > 0) {
    summary.__omittedKeys = omittedCount;
  }
  return summary;
};

const formatCapturedLogMessage = (...args: any[]): string => args.map(arg => {
  if (typeof arg === 'string') return truncateLogText(arg);
  if (arg instanceof Error) return truncateLogText(arg.stack || arg.message || String(arg));
  if (typeof arg === 'object' && arg !== null) {
    try {
      return truncateLogText(JSON.stringify(summarizeValueForLog(arg)));
    } catch {
      return truncateLogText(String(arg));
    }
  }
  return truncateLogText(String(arg));
}).join(' ');

export function useDevLogs() {
  const [devLogs, setDevLogs] = useState<DevLogEntry[]>([]);
  const pendingDevLogsRef = useRef<DevLogEntry[]>([]);
  const devLogFlushTimerRef = useRef<number | null>(null);

  useEffect(() => {
      // --- NEW: AUTO-RESET API KEY LOGIC ---
      try {
        const configStr = localStorage.getItem('kumiko_ai_config');
        if (configStr) {
          const config: AIConfig = JSON.parse(configStr);
          if (config.activeKey === 'backup' && config.keySwitchTimestamp) {
            const twentyFourHours = 24 * 60 * 60 * 1000;
            const timeSinceSwitch = Date.now() - config.keySwitchTimestamp;

            if (timeSinceSwitch > twentyFourHours) {
              console.log("[KEY_SWITCH] More than 24 hours passed. Reverting to primary API key.");
              const newConfig: AIConfig = { ...config, activeKey: 'primary' };
              delete newConfig.keySwitchTimestamp;
              // Phase 6 Part B: fan out to any connected phones so their
              // activeKey mirror updates. Fire-and-forget — the boot-time
              // revert doesn't block further initialization.
              void import('../services/llmCore').then(m => m.setAIConfig(newConfig));
            }
          }
        }
      } catch (error) {
        console.error("Failed to check for AI key reset:", error);
      }

      const flushBufferedLogs = () => {
        if (devLogFlushTimerRef.current !== null) {
          window.clearTimeout(devLogFlushTimerRef.current);
          devLogFlushTimerRef.current = null;
        }

        if (pendingDevLogsRef.current.length === 0) return;

        const nextLogs = pendingDevLogsRef.current;
        pendingDevLogsRef.current = [];
        setDevLogs(prev => {
          const mergedLogs = [...prev, ...nextLogs];
          return mergedLogs.length > DEV_LOG_LIMIT
            ? mergedLogs.slice(mergedLogs.length - DEV_LOG_LIMIT)
            : mergedLogs;
        });
      };

      const scheduleBufferedLogFlush = () => {
        if (devLogFlushTimerRef.current !== null) return;
        devLogFlushTimerRef.current = window.setTimeout(() => {
          flushBufferedLogs();
        }, DEV_LOG_FLUSH_INTERVAL_MS);
      };

      const originalLog = console.log;
      const originalWarn = console.warn;
      const originalError = console.error;

      const addToLogs = (level: DevLogLevel, ...args: any[]) => {
        pendingDevLogsRef.current.push({
          level,
          message: formatCapturedLogMessage(...args),
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        });

        if (pendingDevLogsRef.current.length >= 12) {
          flushBufferedLogs();
          return;
        }

        scheduleBufferedLogFlush();
      };
      
      console.log = (...args) => {
          originalLog.apply(console, args);
          addToLogs('log', ...args);
      };
      console.warn = (...args) => {
          originalWarn.apply(console, args);
          addToLogs('warn', ...args);
      };
      console.error = (...args) => {
          originalError.apply(console, args);
          addToLogs('error', ...args);
      };

      return () => {
          if (devLogFlushTimerRef.current !== null) {
            window.clearTimeout(devLogFlushTimerRef.current);
            devLogFlushTimerRef.current = null;
          }
          pendingDevLogsRef.current = [];
          console.log = originalLog;
          console.warn = originalWarn;
          console.error = originalError;
      };

  }, []);

  return { devLogs, setDevLogs };
}
