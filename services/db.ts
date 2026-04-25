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
  groundingSources?: any[];
  isVoiceMessage?: boolean;
  voiceFileId?: string;
  voiceDuration?: number;
  japaneseText?: string;
  sendStatus?: 'sending' | 'delivered' | 'failed';
  failReason?: string;
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
  // v2.14.3 M.5: PC parity for boostHybridScore role penalty (`role === 'mixed'`
  // → -0.015) and PC's `searchTierVectors` role filter. Stored as opaque string
  // because PC accepts any role label (user / model / mixed / system / unknown);
  // IndexedDB is schemaless at the row level so adding this field needs no
  // schema bump — old rows simply read back with `role === undefined`.
  role?: string;
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

export interface CharacterStatus {
  aliases: string[];
  current_status: string;
  last_major_event: string;
  current_attitude: string;
  mention_frequency_in_diary?: string;
}

export interface WorldCharacterStatusMap {
  [characterId: string]: CharacterStatus;
}

export interface DailyFragmentEntity {
  id: string;
  date: string; // YYYY-MM-DD
  timestamp: number;
  content: string;
  triggerReason: string; // e.g., 'intra_day_gap', 'state_change'
}

export interface KumikoDiaryEntity {
  id: string;
  date: string; // YYYY-MM-DD
  timestamp: number;
  content: string;
  summary: string;
  weather?: string;
  holiday?: string;
  rewriteCount?: number;
  validationStatus?: 'passed' | 'partial' | 'failed';
  previousContent?: string;
  previousSummary?: string;
}

export interface PsycheStateEntity {
  id: string; // usually 'current'
  stress: number; // 0-100
  energy: number; // 0-100
  relaxation: number; // 0-100
  lastUpdated: number;
  lastChatDeltaDirection?: { stress: number; energy: number; relaxation: number };
}

export class AppDatabase extends Dexie {
  messages!: Table<MessageEntity, string>;
  images!: Table<ImageEntity, string>;
  vectors!: Table<VectorEntity, string>;
  episodes!: Table<EpisodeEntity, string>;
  keyval!: Table<KeyValEntity, string>;
  dailyFragments!: Table<DailyFragmentEntity, string>;
  kumikoDiary!: Table<KumikoDiaryEntity, string>;
  psycheState!: Table<PsycheStateEntity, string>;

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

    // V6-V8 were the GraphRAG experiment (graphEntities / graphRelations
    // entity-relation tables). V6 built them, V7 normalised data in-place,
    // V8 dropped them with `null`. The feature was removed and no runtime
    // code has referenced either table since. Dexie allows non-contiguous
    // version numbers, so we jump straight to V9; Dexie DBs that already
    // ran V6-V8 are at >= V8 locally and skip this span, and any hypothetical
    // DB still on V5 (or earlier) will migrate directly to the post-GraphRAG
    // shape at V9 without ever creating the dead tables.

    this.version(9).stores({
      messages: 'id, timestamp, role, isPinned',
      images: 'id, timestamp',
      vectors: 'id, timestamp, tier, source, canonicalKey, *tags',
      episodes: 'id, startTimestamp, endTimestamp, startMessageId, endMessageId, roleScope',
      keyval: 'key',
      dailyFragments: 'id, date, timestamp',
      kumikoDiary: 'id, date, timestamp',
      psycheState: 'id'
    });

    // V10: add imageId index on messages. V10 (alongside the now-deleted
    // legacyImageMigration boot pass) was Phase 1 of retiring the inline
    // MessageEntity.image field; Phase 2 (this removal) ships in V11.
    this.version(10).stores({
      messages: 'id, timestamp, role, isPinned, imageId',
      images: 'id, timestamp',
      vectors: 'id, timestamp, tier, source, canonicalKey, *tags',
      episodes: 'id, startTimestamp, endTimestamp, startMessageId, endMessageId, roleScope',
      keyval: 'key',
      dailyFragments: 'id, date, timestamp',
      kumikoDiary: 'id, date, timestamp',
      psycheState: 'id'
    });

    // V11: Phase 2 of the legacy image retirement. The schema itself doesn't
    // change (Dexie / IndexedDB object stores are schemaless at the row level —
    // dropping a field from the TypeScript interface is enough for new writes),
    // but we run a defensive upgrade pass that nukes any residual `image`
    // property from existing rows. On a single-user install where Phase 1's
    // boot migration already ran, this is a no-op; it exists as belt-and-
    // suspenders for any row Phase 1 somehow missed (partial runs, crashes).
    this.version(11).stores({
      messages: 'id, timestamp, role, isPinned, imageId',
      images: 'id, timestamp',
      vectors: 'id, timestamp, tier, source, canonicalKey, *tags',
      episodes: 'id, startTimestamp, endTimestamp, startMessageId, endMessageId, roleScope',
      keyval: 'key',
      dailyFragments: 'id, date, timestamp',
      kumikoDiary: 'id, date, timestamp',
      psycheState: 'id'
    }).upgrade(async tx => {
      await tx.table('messages').toCollection().modify((m: any) => {
        if (m && 'image' in m) {
          delete m.image;
        }
      });
    });
  }

  async getVal<T>(key: string, defaultValue: T): Promise<T> {
    const record = await this.keyval.get(key);
    return record ? record.value : defaultValue;
  }

  async setVal(key: string, value: any): Promise<void> {
    await this.keyval.put({ key, value });
    void import('./preferencesSync')
      .then(({ noteKeyvalPreferenceWrite }) => {
        noteKeyvalPreferenceWrite(key, value);
      })
      .catch(() => {
        // preferencesSync is optional at runtime for tests / early boot
      });
  }
}

export const db = new AppDatabase();

export const INITIAL_WORLD_CHARACTER_STATUS: WorldCharacterStatusMap = {
  shuichi: {
    aliases: ["秀一", "冢本", "男朋友", "shuichi"],
    current_status: "恋爱中，是住得很近、见面很方便的本地上班族。平时下班后经常一起吃饭或顺路约会，周末也常去对方家里，但具体工作内容不必写死。",
    last_major_event: "前两天刚一起吃过晚饭",
    current_attitude: "平稳的日常状态，偶尔会吐槽他不够细腻，但心里很依赖他。",
    mention_frequency_in_diary: "high"
  },
  reina: {
    aliases: ["丽奈", "高坂", "reina"],
    current_status: "在美国以职业小号演奏者身份活动，有时差，只能偶尔打视频电话。不是学生，没有学期概念。",
    last_major_event: "上周视频聊了两个小时",
    current_attitude: "非常想念，但不想打扰她练习，提起她时会带着自豪和些许寂寞。"
  },
  kanade: {
    aliases: ["小奏", "久石奏", "kanade"],
    current_status: "已大学毕业，在社会上工作了，偶尔会在 LINE 上联系。",
    last_major_event: "无",
    current_attitude: "觉得她还是个爱捉弄人的可爱后辈。"
  }
};

export const getWorldCharacterStatus = async (): Promise<WorldCharacterStatusMap> => {
  return await db.getVal<WorldCharacterStatusMap>('world_character_status', INITIAL_WORLD_CHARACTER_STATUS);
};

export const updateWorldCharacterStatus = async (updates: Partial<WorldCharacterStatusMap>): Promise<void> => {
  const current = await getWorldCharacterStatus();
  const merged = { ...current };
  for (const [key, val] of Object.entries(updates)) {
    if (merged[key]) {
      merged[key] = { ...merged[key], ...val };
    } else {
      merged[key] = val as CharacterStatus;
    }
  }
  await db.setVal('world_character_status', merged);
};
