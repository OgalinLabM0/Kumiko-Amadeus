
export interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  image?: string; // URL for persistence, Base64 temporarily during send
  imageId?: string; // Local DB ID for the image
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
export type TtsBackend = 'fish' | 'sovits';

export interface TtsConfig {
  ttsBackend: TtsBackend;
  voiceMode: VoiceMode;
  fishAudioApiKey: string;
  fishAudioReferenceId: string;
  fishAudioModel: 's1' | 's2-pro';
  format: 'mp3' | 'opus';
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
}

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported';

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
