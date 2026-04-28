
export interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  // Transient base64 data URL. Used only briefly during send (before the
  // image is written to userData + assigned an `imageId`) and during backup
  // JSON import hydration (see backupActions — legacy backups still ship
  // inline `image`; we convert them to `imageId` at import time and clear
  // this field before it reaches persistent storage). MessageEntity no
  // longer carries `image` (retired in Plan 14 Phase A, Dexie V11).
  image?: string;
  imageId?: string; // Authoritative reference to the persisted image
  imageCaption?: string; // New: Description of the image for retrieval
  groundingSources?: { title: string; uri: string }[]; 
  isRead?: boolean; 
  isHidden?: boolean; 
  isPinned?: boolean; 
  quote?: { 
    id?: string; 
    text: string;
    role: 'user' | 'model';
  };
  storedEmotion?: EmotionType; // NEW: Persist the emotion state of this message
  isVoiceMessage?: boolean;
  voiceFileId?: string;
  voiceDuration?: number;
  japaneseText?: string;
  sendStatus?: 'sending' | 'delivered' | 'failed';
  failReason?: string;
}

export interface WorldBookEntry {
  id: string;
  title: string; 
  content: string;
  isActive: boolean;
  isHighPriority?: boolean; 
}

export interface AnchorEntry {
  id: string;
  content: string;
  timestamp: number;
  emotion: EmotionType;
}

export interface LocationConfig {
  modelCountry: string;
  modelTimezone: string;
  userCountry: string;
  userTimezone: string;
}

export interface BackupConfig {
  localEnabled: boolean;
  ragEnabled?: boolean;
}

// NEW: AI Configuration Interface
export type AIProvider = 'gemini' | 'openai' | 'anthropic' | 'deepseek' | 'grok' | 'openrouter' | 'volcengine' | 'dashscope' | 'zhipu' | 'moonshot' | 'qianfan' | 'hunyuan' | 'spark' | 'minimax';

export interface AIConfig {
  provider?: AIProvider; // NEW: AI Provider selection
  apiKey_primary: string;
  apiKey_backup: string;
  activeKey: 'primary' | 'backup';
  useCustomEndpoint?: boolean;
  customEndpoint?: string;
  model_main: string;      // Slot 1: Conversation (Core)
  model_summary: string;   // Slot 2: Background Tasks (Fast)
  model_translator?: string; // Slot 3: TTS Translation (Optional)
  keySwitchTimestamp?: number; // Timestamp for when the key was switched to backup
  
  // NEW: Vision Helper Configuration
  useVisionHelper?: boolean;
  visionProvider?: AIProvider;
  useVisionCustomEndpoint?: boolean;
  visionCustomEndpoint?: string;
  visionApiKey?: string;
  model_vision?: string;
}

export enum AppState {
  CONNECTING,
  CONNECTED,
  ERROR
}

export type EmotionType = 
  | 'neutral' | 'smiling' | 'happy' | 'angry' | 'sad' 
  | 'shy' | 'surprised' | 'resigned' | 'serious' | 'gentle'
  | 'sleepy' | 'confused' | 'confused_2' | 'disgusted' | 'smug' | 'worried' | 'worried_2';

export type Language = 'zh' | 'en';

export type SummaryBoundaryReason =
  | 'topic_shift'
  | 'semantic_shift'
  | 'long_gap'
  | 'reminder_created'
  | 'sleep_transition'
  | 'wrap_up'
  | 'hard_limit'
  | 'manual';

export interface SummarySegmentMetadata {
  segmentId: string;
  segmentStartTime: number;
  segmentEndTime: number;
  summaryCompletedTime: number;
  isComplete: boolean;
  topicLabel: string;
  summaryText: string;
}

export interface SummaryArchiveState {
  segmentStartTurn: number;
  segmentStartMessageId: string | null;
  activeSegmentId?: string | null;
  carryoverStartMessageId?: string | null;
  carryoverEndMessageId?: string | null;
  pendingSinceTurn?: number | null;
  lastBoundaryReason?: SummaryBoundaryReason | null;
  lastBoundaryAt?: number | null;
  recentSummarySegments?: SummarySegmentMetadata[];
}

export type MemoryQuerySessionKind = 'exact_history' | 'temporal_history' | 'topic_search';

export type MemoryEntryKind = 'message' | 'episode' | 'semantic_chunk' | 'background' | 'mixed';

export type TemporalQueryPrecision =
  | 'exact_minute'
  | 'approximate_minutes'
  | 'hour_window'
  | 'day_window';

export type TemporalQuerySource = 'local_heuristic' | 'main_model';

export type TemporalQueryConfidence = 'high' | 'medium' | 'low';

export type TemporalQueryDiagnosticsStatus =
  | 'heuristic_success'
  | 'main_model_success'
  | 'heuristic_fallback_after_model_failure'
  | 'main_model_parse_failed'
  | 'main_model_error'
  | 'session_fallback'
  | 'no_match';

export interface MemoryQuerySession {
  kind: MemoryQuerySessionKind;
  sourceQuery: string;
  lookupMode: 'session_start' | 'exact_timestamp' | 'temporal_window';
  targetSpeaker: 'User' | 'Kumiko' | 'Any' | null;
  searchRole?: 'user' | 'model' | 'any' | null;
  startTimestampJST?: number | null;
  endTimestampJST?: number | null;
  parserSource?: TemporalQuerySource | null;
  parserPrecision?: TemporalQueryPrecision | null;
  parserConfidence?: TemporalQueryConfidence | null;
  parserStatus?: TemporalQueryDiagnosticsStatus | null;
  resultCount: number;
  lastEvidenceSource?: 'raw_messages' | 'episodes' | 'none';
  confidenceLevel?: 'high' | 'medium' | 'low';
  createdAt: number;
  lastUsedAt: number;
}

export interface ScheduleTrigger {
  event: string;
  days_offset?: number;
  delay_seconds?: number;
  recurrence?: 'daily';
  hour?: number;
  minute?: number;
}

export interface ChatResponse {
  textParts: string[];
  emotion: EmotionType;
  groundingSources: { title: string; uri: string }[];
  quote?: { text: string; role: 'user' }; 
  imageCaption?: string;
  scheduleTrigger?: ScheduleTrigger; // For Scheduling Events
  anchorAction?: { type: 'add' | 'delete', content: string }; // NEW: For Life Anchors
  systemNotice?: string; // NEW: Notification field for model switching events
  activateSleepMode?: boolean; // NEW: Signal to activate sleep mode after this response
  voiceMode?: boolean;
  voiceVariant?: string;
}

export type VoiceMode = 'full' | 'text' | 'hybrid';
export type TtsBackend = 'fish' | 'sovits' | 'vocu';

export interface TtsConfig {
  ttsBackend: TtsBackend;
  voiceMode: VoiceMode;
  fishAudioApiKey: string;
  fishAudioReferenceId: string;
  fishAudioModel: 's1' | 's2-pro';
  // v2.14.28 M30: 'wav' added so the audioMimeForFormat() switch in
  // TtsConfigSection.tsx is reachable for SoVITS bytes (which are always
  // wav). Previously the type forced 'mp3' | 'opus' and the wav arm of
  // the switch was dead code; the resulting MIME mismatch is the symptom
  // covered by M29 (SoVITS write path).
  format: 'mp3' | 'opus' | 'wav';
  latency: 'low' | 'balanced' | 'normal';
  speed: number;
  temperature?: number;
  model_translator?: string;
  ringtoneFileId?: string;
  sovitsDir?: string;
  sovitsPort?: number;
  sovitsGptWeights?: string;
  sovitsVitsWeights?: string;
  sovitsRefAudioDir?: string;
  // Linux/macOS BYO Python: absolute path to the python interpreter that runs
  // SoVITS's api_v2.py. Unused on Windows, where the bundled runtime/python.exe
  // is spawned directly by the main process.
  sovitsPythonPath?: string;
  sovitsTopK?: number;
  sovitsTopP?: number;
  sovitsTemperature?: number;
  sovitsTextSplitMethod?: string;
  sovitsFragmentInterval?: number;
  // When false (default), prompt_text is sent as an empty string and SoVITS
  // runs in "ref-free" mode — any emotion-matching WAV works, no per-file
  // prompt transcript is required. When true, the user asserts that each
  // WAV's spoken Japanese matches the prompt text exactly (higher quality,
  // more setup). Forced true at runtime when a v3/v4 weights path is
  // detected (official limitation), without overwriting this persisted pref.
  sovitsUseRefText?: boolean;
  // Per-file custom prompt_text overrides, keyed by the file-name stem
  // (e.g. "neutral_casual" → "…"). Only used when sovitsUseRefText is true.
  // The whole map is overwritten on save; an empty map or undefined means
  // "no customization — fall back to EMOTION_TO_SOVITS_REF defaults".
  sovitsCustomPrompts?: Record<string, string>;

  // Vocu AI (third TTS backend; https://dev.vocu.ai/).
  // Sync endpoint: POST /api/tts/simple-generate → returns JSON with
  // data.streamUrl → GET that URL to fetch the MP3 bytes. Auth: Bearer apiKey.
  vocuApiKey?: string;
  vocuVoiceId?: string;
  vocuPromptId?: string;
  vocuPreset?: 'balance' | 'vivid';
  vocuFlash?: boolean;
  // Plan C: when enabled, strong emotions (happy/angry/sad/surprised) auto-switch
  // preset → 'vivid'. Other emotions keep `vocuPreset`. Vocu's 'vivid' only works
  // on V3.0 voices, so the UI warns users to confirm voice version first.
  vocuEmotionBoost?: boolean;
}

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'cancelling'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'unsupported';

// v2.14.6 D.1: which side initiated the most recent update check. The
// renderer uses this to decide whether to surface a "currently up to date"
// SystemToast — only `'manual'` fires the toast, so the 20-second startup
// auto-check (and any future periodic auto-check) stays silent unless it
// actually finds a new release. `null` means "never checked" (initial state).
export type AppUpdateTriggerSource = 'startup' | 'manual' | 'periodic' | null;

export interface AppUpdateState {
  status: AppUpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  releaseDate: string | null;
  progressPercent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  error: string | null;
  isPackaged: boolean;
  // v2.14.6 D.1: who fired the most recent checkForUpdates(). Set by the
  // electron-main app-updater bridge AND by store/slices/updaterSlice for
  // Capacitor Android. Optional for back-compat with state shapes that
  // pre-date this field.
  triggerSource?: AppUpdateTriggerSource;
}

// Descriptor for the electron-updater "pending/" directory surfaced in
// Settings > App Update > 下载缓存. Sourced from the desktop main
// process via the `app:update:get-cache-info` IPC channel.
//   - path:       absolute path to the pending/ directory. Populated
//                 even when exists:false so the UI can still display
//                 where downloads will land.
//   - exists:     whether pending/ currently exists on disk.
//   - sizeBytes:  total byte size of every file under pending/ (not
//                 including directory overhead). 0 when exists:false.
//   - fileCount:  number of regular files under pending/ (partial
//                 chunks + completed .exe both count). 0 when
//                 exists:false.
export interface UpdaterCacheInfo {
  path: string;
  exists: boolean;
  sizeBytes: number;
  fileCount: number;
}

export type MessageAlertKind = 'reply' | 'proactive' | 'reminder';

export type MissedMessageAlert = {
  id: string;
  messageId: string;
  preview: string;
  timestamp: number;
  kind: MessageAlertKind;
  isRead?: boolean;
};

export interface VoiceCallOverlayData {
  reminderEvent: string;
  reminderText: string;
  emotion: EmotionType;
  onAccept: () => void;
  onReject: () => void;
  onClose?: () => void;
  isConnecting?: boolean;
  isPlayingVoice?: boolean;
  isEnded?: boolean;
  // Phase 5 Part D: populated by the PC once the voice pipeline
  // resolves, so the mobile VoiceCallOverlay can HTTP-stream the same
  // clip instead of relying on a renderer-local Blob URL. Unused on
  // desktop (PC renderer already owns the ArrayBuffer in chatActions).
  voiceFileId?: string;
}

declare global {
  interface Window {
    electronAPI?: {
      invoke: (channel: string, data?: any) => Promise<any>;
      send: (channel: string, data?: any) => void;
      on: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
      removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
      setBgColor: (color: string) => void;
    };
  }
}
