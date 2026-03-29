import Dexie, { Table } from 'dexie';

export interface MessageEntity {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  imageId?: string; // Reference to ImageEntity
  imageCaption?: string;
  isHidden?: boolean;
  isPinned?: boolean;
  isRead?: boolean;
  quote?: { id: string; text: string; role: 'user' | 'model' };
  emotion?: string;
  image?: string; // Legacy base64 string
  groundingSources?: any[];
  isVoiceMessage?: boolean;
  voiceFileId?: string;
  voiceDuration?: number;
  japaneseText?: string;
}

export interface ImageEntity {
  id: string;
  base64Data: string; // The compressed image data
  mimeType: string;
  timestamp: number;
}

export interface VectorEntity {
  id: string;
  messageId?: string; // Optional link to a message
  text: string;
  vector: Float32Array; // The embedding
  timestamp: number;
  tags?: string[]; // NEW: Entity tags for hybrid search
  tier?: 'core' | 'episodic' | 'background';
  source?: string;
  score?: number;
  canonicalKey?: string;
}

export interface EpisodeEntity {
  id: string;
  startMessageId: string;
  endMessageId: string;
  messageIds: string[];
  startTimestamp: number;
  endTimestamp: number;
  messageCount: number;
  userMessageCount: number;
  modelMessageCount: number;
  roleScope: 'user' | 'model' | 'mixed';
  topicHint?: string;
  preview: string;
  text: string;
  boundaryReason?: 'topic_shift' | 'wrap_up' | 'long_gap' | 'window_cap' | 'day_split' | 'manual';
}

export interface KeyValEntity {
  key: string;
  value: any;
}

export interface GraphEntity {
  id: string;
  name: string;
  type: 'person' | 'event' | 'place' | 'concept';
  firstSeen: number;
  lastSeen: number;
  metadata?: Record<string, any>;
}

export interface GraphRelation {
  id: string;
  fromId: string;
  toId: string;
  relationType: string;
  emotion?: string;
  timestamp: number;
  evidence?: string;
}

export class AppDatabase extends Dexie {
  messages!: Table<MessageEntity, string>;
  images!: Table<ImageEntity, string>;
  vectors!: Table<VectorEntity, string>;
  episodes!: Table<EpisodeEntity, string>;
  keyval!: Table<KeyValEntity, string>;
  graphEntities!: Table<GraphEntity, string>;
  graphRelations!: Table<GraphRelation, string>;

  constructor() {
    super('KumikoDB');
    this.version(1).stores({
      messages: 'id, timestamp, role, isPinned',
      images: 'id, timestamp',
      vectors: 'id, timestamp',
      keyval: 'key'
    });
    
    // V2: Add tags to vectors for Hybrid Search
    this.version(2).stores({
      vectors: 'id, timestamp, *tags'
    }).upgrade(tx => {
      // Existing vectors will just have undefined tags, which is fine.
    });

    this.version(3).stores({
      messages: 'id, timestamp, role, isPinned',
      images: 'id, timestamp',
      vectors: 'id, timestamp, tier, source, canonicalKey, *tags',
      keyval: 'key'
    }).upgrade(() => {
      // Tier/source metadata is optional and only used by fallback storage paths.
    });

    this.version(4).stores({
      messages: 'id, timestamp, role, isPinned',
      images: 'id, timestamp',
      vectors: 'id, timestamp, tier, source, canonicalKey, *tags',
      episodes: 'id, startTimestamp, endTimestamp, startMessageId, endMessageId, roleScope',
      keyval: 'key'
    }).upgrade(() => {
      // Episodes are derived temporal memory units built from raw history.
    });

    this.version(5).stores({
      messages: 'id, timestamp, role, isPinned',
      images: 'id, timestamp',
      vectors: 'id, timestamp, tier, source, canonicalKey, *tags',
      episodes: 'id, startTimestamp, endTimestamp, startMessageId, endMessageId, roleScope',
      keyval: 'key'
    }).upgrade(() => {
      // Episode payload now carries messageIds/topicHint metadata for temporal evidence.
    });

    this.version(6).stores({
      messages: 'id, timestamp, role, isPinned',
      images: 'id, timestamp',
      vectors: 'id, timestamp, tier, source, canonicalKey, *tags',
      episodes: 'id, startTimestamp, endTimestamp, startMessageId, endMessageId, roleScope',
      keyval: 'key',
      graphEntities: 'id, name, type, firstSeen, lastSeen',
      graphRelations: 'id, fromId, toId, relationType, timestamp'
    }).upgrade(() => {
      // GraphRAG: entity-relation graph for structured memory.
    });
  }

  async getVal<T>(key: string, defaultValue: T): Promise<T> {
    const record = await this.keyval.get(key);
    return record ? record.value : defaultValue;
  }

  async setVal(key: string, value: any): Promise<void> {
    await this.keyval.put({ key, value });
  }
}

export const db = new AppDatabase();
