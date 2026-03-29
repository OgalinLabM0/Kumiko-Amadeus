import { db, GraphEntity } from './db';
import { callLLMRaw } from './geminiService';

const CONSOLIDATION_KEY = 'lastConsolidationDate';
const BATCH_SIZE = 50;

export const shouldRunConsolidation = (): boolean => {
  const lastDate = localStorage.getItem(CONSOLIDATION_KEY);
  const today = new Date().toISOString().slice(0, 10);
  return lastDate !== today;
};

const EXTRACTION_PROMPT = `You are a knowledge graph extraction engine. Given a conversation between a User and Kumiko (黄前久美子), extract entities and relationships.

Output ONLY valid JSON in this exact format:
{
  "entities": [
    { "name": "entity name", "type": "person|event|place|concept" }
  ],
  "relations": [
    { "from": "entity name", "to": "entity name", "type": "relationship type", "emotion": "optional emotion" }
  ]
}

Rules:
- Extract people mentioned (User, Kumiko, Shuichi, Reina, etc.)
- Extract significant events or topics discussed
- Relations should describe how entities connect (e.g., "worried_about", "reminded", "argued_with", "comforted", "shared_meal")
- Emotion is optional: happy, sad, worried, neutral, shy, angry, etc.
- Keep it concise: max 10 entities, max 15 relations per extraction
- Do NOT include trivial greetings or empty exchanges
- Output ONLY the JSON, no explanation`;

async function processMessageBatch(
  messages: Array<{ role: string; text: string; timestamp: number }>,
  model: string
): Promise<{ entitiesAdded: number; relationsAdded: number }> {
  const now = Date.now();
  const conversationText = messages
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(m => `[${m.role === 'user' ? 'User' : 'Kumiko'}]: ${m.text}`)
    .join('\n');

  const result = await callLLMRaw(EXTRACTION_PROMPT, conversationText, model);
  if (!result) return { entitiesAdded: 0, relationsAdded: 0 };

  let parsed: { entities: Array<{ name: string; type: string }>; relations: Array<{ from: string; to: string; type: string; emotion?: string }> };
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.warn('[SleepConsolidation] Failed to parse LLM output for batch');
    return { entitiesAdded: 0, relationsAdded: 0 };
  }

  let entitiesAdded = 0;
  let relationsAdded = 0;

  if (parsed.entities && Array.isArray(parsed.entities)) {
    for (const e of parsed.entities) {
      if (!e.name || !e.type) continue;
      const existing = await db.graphEntities.where('name').equals(e.name).first();
      if (existing) {
        await db.graphEntities.update(existing.id, { lastSeen: now });
      } else {
        await db.graphEntities.add({
          id: `ge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: e.name,
          type: (e.type as GraphEntity['type']) || 'concept',
          firstSeen: now,
          lastSeen: now,
        });
        entitiesAdded++;
      }
    }
  }

  if (parsed.relations && Array.isArray(parsed.relations)) {
    for (const r of parsed.relations) {
      if (!r.from || !r.to || !r.type) continue;
      await db.graphRelations.add({
        id: `gr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        fromId: r.from,
        toId: r.to,
        relationType: r.type,
        emotion: r.emotion,
        timestamp: now,
      });
      relationsAdded++;
    }
  }

  return { entitiesAdded, relationsAdded };
}

export const runSleepConsolidation = async (modelSummary: string): Promise<{ entitiesAdded: number; relationsAdded: number }> => {
  const today = new Date().toISOString().slice(0, 10);

  if (!shouldRunConsolidation()) {
    return { entitiesAdded: 0, relationsAdded: 0 };
  }

  try {
    const entityCount = await db.graphEntities.count();
    const isFirstRun = entityCount === 0;

    let messagesToProcess;
    if (isFirstRun) {
      console.log('[SleepConsolidation] First run detected — processing ALL history');
      messagesToProcess = await db.messages.toArray();
    } else {
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      messagesToProcess = await db.messages.where('timestamp').above(oneDayAgo).toArray();
    }

    if (messagesToProcess.length < 4) {
      localStorage.setItem(CONSOLIDATION_KEY, today);
      return { entitiesAdded: 0, relationsAdded: 0 };
    }

    messagesToProcess.sort((a, b) => a.timestamp - b.timestamp);

    let totalEntities = 0;
    let totalRelations = 0;

    for (let i = 0; i < messagesToProcess.length; i += BATCH_SIZE) {
      const batch = messagesToProcess.slice(i, i + BATCH_SIZE);
      if (batch.length < 2) continue;

      console.log(`[SleepConsolidation] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(messagesToProcess.length / BATCH_SIZE)} (${batch.length} messages)`);

      try {
        const result = await processMessageBatch(batch, modelSummary);
        totalEntities += result.entitiesAdded;
        totalRelations += result.relationsAdded;
      } catch (batchErr) {
        console.warn(`[SleepConsolidation] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, batchErr);
      }

      if (i + BATCH_SIZE < messagesToProcess.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    localStorage.setItem(CONSOLIDATION_KEY, today);
    console.log(`[SleepConsolidation] Done: ${totalEntities} entities, ${totalRelations} relations added. (${isFirstRun ? 'Full history' : 'Incremental'})`);
    return { entitiesAdded: totalEntities, relationsAdded: totalRelations };
  } catch (err) {
    console.error('[SleepConsolidation] Error:', err);
    localStorage.setItem(CONSOLIDATION_KEY, today);
    return { entitiesAdded: 0, relationsAdded: 0 };
  }
};
