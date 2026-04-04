export interface LoreChunk {
  id: string;
  category: string;
  yearRange: string;
  keywords: string[];
  content: string;
}

// This is a placeholder. The actual lore data is distributed separately
// via kumiko-assets.zip (see README for build-from-source instructions).
// When building from source, either:
// 1. Place the full loreData.ts here (from kumiko-assets.zip)
// 2. Or leave this empty array — the app will work but without detailed story memories
export const LORE_CHUNKS: LoreChunk[] = [];
