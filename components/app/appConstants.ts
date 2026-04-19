export const LOCAL_BACKUP_PATH_STORAGE_KEY = 'kumiko_local_backup_path';
export const MESSAGE_ALERTS_STORAGE_KEY = 'kumiko_message_alerts';
export const SUMMARY_ARCHIVE_STATE_STORAGE_KEY = 'kumiko_summary_archive_state';
export const MEMORY_QUERY_SESSION_STORAGE_KEY = 'kumiko_memory_query_session';
export const SUMMARY_SEMANTIC_CACHE_LIMIT = 48;


export const REBUILD_FRAGMENT_GAP_MS = 3 * 60 * 1000;
export const REBUILD_FRAGMENT_WINDOW_MS = 8 * 60 * 1000;
export const REBUILD_FRAGMENT_MAX_MESSAGES = 4;
export const REBUILD_FRAGMENT_MAX_CHAR_LENGTH = 32;
export const REBUILD_FRAGMENT_MAX_TOTAL_CHARS = 120;
export const HISTORICAL_QUERY_SESSION_MAX_IDLE_MS = 30 * 60 * 1000;
export const EXACT_LOOKUP_NEARBY_WINDOW_MS = 90 * 1000;
export const EXACT_LOOKUP_TEMPORAL_SUMMARY_WINDOW_MS = 30 * 60 * 1000;
export const EXACT_LOOKUP_TEMPORAL_SUMMARY_MAX_MESSAGES = 15;
export const EXACT_LOOKUP_CONTEXT_EXPAND_BEFORE = 3;
export const EXACT_LOOKUP_CONTEXT_EXPAND_AFTER = 3;
export const DEV_LOG_MAX_OBJECT_KEYS = 8;
export const REBUILD_FRAGMENT_BLOCK_PATTERNS = [
  /(?:报错|错误|修复|实现|逻辑|方案|原因|配置|接口|模型|向量|检索|RAG|SQLite|HNSW|embedding|endpoint|function|class|error|bug|stack|trace|prompt|code|api|model)/iu,
  /[`{}[\]();=<>]|::|=>/u,
];
