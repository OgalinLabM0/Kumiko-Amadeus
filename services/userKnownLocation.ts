import type { Language, Message, UserLocationDisclosure } from '../types';
import { db } from './db';
import type { TaskContext } from './taskRuntime';

// Deliberately separate from LocationConfig, IP lookup and device preferences.
export const USER_KNOWN_LOCATION_KEY = 'user_known_location_v1';
const TURN_DATA_EPOCH_KEY = 'kumiko_turn_epoch_v1';

export interface LocationFactCandidate extends UserLocationDisclosure {
  kind?: 'assert' | 'retract';
}

export interface UserKnownLocation {
  version: 1;
  revision?: number;
  locationText: string;
  sourceQuote: string;
  cityName?: string;
  regionQualifier?: string;
  sourceMessage: { id: string; text: string; timestamp: number; role: 'user'; sequence?: number };
  clarification?: { regionQualifier: string; sourceMessage: { id: string; text: string; timestamp: number; role: 'user'; sequence: number } };
  status: 'resolved' | 'ambiguous' | 'unresolved' | 'retracted';
  resolutionIssue?: 'network' | 'no-match';
  resolvedName: string | null;
  timeZone: string | null;
  latitude: number | null;
  longitude: number | null;
  geocodingQuery: string;
  updatedAt: number;
}

const shortText = (value: unknown, max: number): value is string => (
  typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max
);
const validZone = (value: unknown): value is string => {
  if (!shortText(value, 100)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
};

const blockedContext = /(?:如果|假如|假设|假定|比如|例如|举例|他说|她说|你说|转述|复述|复读|假装|输出|伪造|模拟|翻译|\b(?:if|suppose|pretend|hypothetical|quote|repeat|translate)\b|he said|she said)/iu;
const assertPrefix = /^(?:我(?:现在|目前|这几天|最近|已经|刚|刚刚)?(?:人)?(?:在|住在|搬到(?:了)?|到|回|从.{1,80}搬到(?:了)?)|(?:现在|目前)(?:我)?(?:在|到|回)|I(?:\s+am|'m|’m)\s+(?:now\s+|currently\s+)?(?:in|at)\s+|I\s+moved\s+from.{1,80}\s+to\s+|I\s+(?:live|am living|moved)\s+(?:in|to|from)\s+)/iu;
const retractPrefix = /^(?:我(?:现在|目前|已经)?(?:不在|不住在|离开(?:了)?|搬离(?:了)?))/u;

/** A deliberately small evidence grammar, not a proof of arbitrary intent.
 * Check the original clause (including omitted suffixes), never just a model's
 * convenient substring. Uncovered or ambiguous wording is left for clarification.
 */
function validateCandidateEvidence(candidate: unknown, sourceText: string): LocationFactCandidate | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (!shortText(value.locationText, 120) || !shortText(value.sourceQuote, 500)) return null;
  const { locationText, sourceQuote } = value;
  if (/[。！？\n!?；;"“”「」『』`]/u.test(locationText)
    || /(?:的新闻|的朋友|的时候|时拍|看|研究|照片|\b(?:news|watching|reading|researching)\b)/iu.test(locationText)
    || /^(?:想|聊|说|读|写|查|讨论|谈论|学习|寻找|回忆|关注|浏览|听|刷|玩|做)/u.test(locationText)) return null;
  if (value.kind !== undefined && value.kind !== 'assert' && value.kind !== 'retract') return null;
  const kind = value.kind === 'retract' ? 'retract' : 'assert';
  if (/\[User_Location_Update\b|(?:请|帮我|要求).{0,30}(?:输出|复读|假装|伪造)|\b(?:pretend|repeat|hypothetical)\b/iu.test(sourceText)) return null;
  const quoteIndex = sourceText.lastIndexOf(sourceQuote);
  if (quoteIndex < 0 || !sourceQuote.includes(locationText)) return null;
  if (/[？?]/u.test(sourceQuote) || /^\s*(?:吗|么|吧|对吗)?\s*[？?]/u.test(sourceText.slice(quoteIndex + sourceQuote.length))) return null;
  const sentenceStart = Math.max(...['。', '！', '？', '\n', '!', '?'].map(mark => sourceText.lastIndexOf(mark, quoteIndex - 1))) + 1;
  const sentenceEndIndex = sourceText.slice(quoteIndex + sourceQuote.length).search(/[。！？\n!?]/u);
  const sentenceEnd = sentenceEndIndex < 0 ? sourceText.length : quoteIndex + sourceQuote.length + sentenceEndIndex;
  const sentence = sourceText.slice(sentenceStart, sentenceEnd);
  if (blockedContext.test(sentence)) return null;
  if (/(?:大概|可能|应该|好像|似乎|也许|吧|\b(?:maybe|perhaps|probably)\b)/iu.test(sourceQuote)) return null;
  if (/(?:去过|住过|想去|打算去|准备去|曾经|以前|之前|没在|不是在|并非|吗[？?]?|used to|want to|not in)/iu.test(sourceQuote)) return null;
  if (kind === 'assert' && /不在/u.test(sourceQuote)) return null;
  const locationIndex = sourceQuote.indexOf(locationText);
  const prefix = sourceQuote.slice(0, locationIndex);
  const prefixMatch = prefix.match(kind === 'retract' ? retractPrefix : assertPrefix);
  // The place must be the direct object of the location predicate: 在看巴黎
  // and 在研究武汉 cannot pass merely because they contain a city name.
  if (!prefixMatch || prefixMatch[0].length !== prefix.length) return null;
  if (/moved\s+from/iu.test(prefix) && !/\bto\s+$/iu.test(prefix)) return null;
  const placeEnd = quoteIndex + locationIndex + locationText.length;
  const tail = sourceText.slice(placeEnd).split(/[，,。！？\n!?；;]/u)[0].trim();
  // A historical/possessive suffix must not disappear through a short quote.
  if (!/^(?:了|呢|这边|这里|这儿|这裡|\s)*$/u.test(tail)) return null;
  const clauseStart = Math.max(sentenceStart, sourceText.lastIndexOf('，', quoteIndex - 1) + 1, sourceText.lastIndexOf(',', quoteIndex - 1) + 1);
  if (!/^(?:\s|不对|不是|更正|其实|说错了|抱歉|现在|目前)*$/u.test(sourceText.slice(clauseStart, quoteIndex))) return null;
  const laterClauses = sourceText.slice(placeEnd, sentenceEnd);
  if (/[，,；;]\s*(?:不对|更正|说错了|后来|现在|目前|已经).{0,25}(?:在|到|回|离开|搬|去)/u.test(laterClauses)) return null;
  // A quote within another person's words or a machine-instruction block is
  // not a direct disclosure, even when the extracted substring looks valid.
  if (/["“「『`]/u.test(sourceText.slice(sentenceStart, quoteIndex)) || /^\s*\[(?:SYSTEM|CRITICAL_OVERRIDE)/imu.test(sourceText)) return null;
  const result: LocationFactCandidate = { locationText, sourceQuote, ...(kind === 'retract' ? { kind } : {}) };
  for (const field of ['cityName', 'regionQualifier'] as const) {
    if (value[field] !== undefined) {
      if (!shortText(value[field], 120) || !locationText.includes(value[field])) return null;
      result[field] = value[field];
    }
  }
  return result;
}

/** Optional local extraction for unambiguous, complete self-location clauses. */
export function extractExplicitLocationFact(sourceText: string): LocationFactCandidate | null {
  let fact: LocationFactCandidate | null = null;
  for (const match of sourceText.matchAll(/[^，,。！？\n!?；;]+/gu)) {
    const clause = match[0].trim().replace(/^(?:不对|更正|其实|说错了)[：:]?\s*/u, '');
    const prefix = clause.match(retractPrefix) || clause.match(assertPrefix);
    if (!prefix) continue;
    const place = clause.slice(prefix[0].length).replace(/(?:了|呢|这边|这里|这儿)+$/u, '').trim();
    // No guessing sentence fragments, activity objects or quoted instructions.
    if (!place || place.length > 80 || /[的时后前吗？?"“”「」『』`]|(?:新闻|照片|拍|看|研究|打算|准备|旅游计划|工作|读书)/u.test(place)) continue;
    const candidate = validateCandidateEvidence({ locationText: place, sourceQuote: clause,
      ...(retractPrefix.test(clause) ? { kind: 'retract' } : {}) }, sourceText);
    if (candidate) fact = candidate;
  }
  return fact;
}

export function validateLocationFactCandidate(candidate: unknown, sourceText: string): LocationFactCandidate | null {
  const fact = validateCandidateEvidence(candidate, sourceText);
  if (!fact) return null;
  const latest = extractExplicitLocationFact(sourceText);
  if (latest && sourceText.lastIndexOf(latest.sourceQuote) > sourceText.lastIndexOf(fact.sourceQuote)) return null;
  return fact;
}

/** Compatibility entry point accepts assertions only. */
export function validateUserLocationDisclosure(candidate: unknown, sourceText: string): UserLocationDisclosure | null {
  const fact = validateLocationFactCandidate(candidate, sourceText);
  return fact?.kind === 'retract' ? null : fact;
}

export function extractUserLocationDisclosureTag(text: string, sourceText: string): { disclosure: UserLocationDisclosure | undefined; cleanText: string } {
  let cleanText = text;
  let disclosure: UserLocationDisclosure | undefined;
  let disclosureIndex = -1;
  // Scan balanced JSON rather than stopping at a bracket inside a source quote.
  const heads = [...text.matchAll(/\[User_Location_Update\s*:\s*/giu)];
  for (const head of heads.reverse()) {
    const start = head.index!;
    const jsonStart = start + head[0].length;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    if (text[jsonStart] === '{') {
      for (let i = jsonStart; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (quoted && ch === '\\') { escaped = true; continue; }
        if (ch === '"') { quoted = !quoted; continue; }
        if (quoted) continue;
        if (ch === '{') depth++;
        if (ch === '}' && --depth === 0) { end = i + 1; break; }
      }
    }
    if (end > 0) {
      const closing = text.slice(end).match(/^\s*\]/u);
      const stop = closing ? end + closing[0].length : end;
      try {
        const candidate = validateUserLocationDisclosure(JSON.parse(text.slice(jsonStart, end)), sourceText);
        const sourceIndex = candidate ? sourceText.lastIndexOf(candidate.sourceQuote) : -1;
        if (candidate && sourceIndex >= disclosureIndex) { disclosure = candidate; disclosureIndex = sourceIndex; }
      } catch { /* Malformed proposals never become facts. */ }
      cleanText = cleanText.slice(0, start) + cleanText.slice(stop);
    } else {
      const closing = cleanText.indexOf(']', jsonStart);
      cleanText = cleanText.slice(0, start) + (closing < 0 ? '' : cleanText.slice(closing + 1));
    }
  }
  return { disclosure, cleanText };
}

/** Used by reads and backup imports; malformed or unsourced records stay unknown. */
export function sanitizeUserKnownLocation(value: unknown): UserKnownLocation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, any>;
  const source = raw.sourceMessage;
  if (raw.version !== 1 || !source || source.role !== 'user' || !shortText(source.id, 200)
    || typeof source.text !== 'string' || source.text.length > 100000
    || !Number.isFinite(source.timestamp) || source.timestamp < 0 || !Number.isFinite(raw.updatedAt)) return null;
  if (raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || raw.revision < 1)) return null;
  if (source.sequence !== undefined && (!Number.isSafeInteger(source.sequence) || source.sequence < 0)) return null;
  const disclosure = validateLocationFactCandidate({ ...raw, kind: raw.status === 'retracted' ? 'retract' : 'assert' }, source.text);
  if (!disclosure || !shortText(raw.geocodingQuery, 250)) return null;
  let clarification: UserKnownLocation['clarification'];
  if (raw.clarification !== undefined) {
    const answer = raw.clarification?.sourceMessage;
    const region = raw.clarification?.regionQualifier;
    if (!answer || answer.role !== 'user' || !shortText(answer.id, 200)
      || !Number.isFinite(answer.timestamp) || !Number.isSafeInteger(answer.sequence) || answer.sequence < 0
      || !isLocationRegionAnswer(answer.text, region)) return null;
    clarification = { regionQualifier: region, sourceMessage: { id: answer.id, text: answer.text,
      timestamp: answer.timestamp, role: 'user', sequence: answer.sequence } };
  }
  const retracted = raw.status === 'retracted' && disclosure.kind === 'retract';
  const resolved = !retracted && raw.status === 'resolved' && validZone(raw.timeZone)
    && Number.isFinite(raw.latitude) && Math.abs(raw.latitude) <= 90
    && Number.isFinite(raw.longitude) && Math.abs(raw.longitude) <= 180
    && shortText(raw.resolvedName, 250);
  return {
    version: 1, ...(raw.revision !== undefined ? { revision: raw.revision } : {}),
    locationText: disclosure.locationText, sourceQuote: disclosure.sourceQuote,
    ...(disclosure.cityName ? { cityName: disclosure.cityName } : {}),
    ...(disclosure.regionQualifier ? { regionQualifier: disclosure.regionQualifier } : {}),
    ...(clarification ? { clarification } : {}),
    sourceMessage: { id: source.id, text: source.text, timestamp: source.timestamp, role: 'user',
      ...(source.sequence !== undefined ? { sequence: source.sequence } : {}) },
    status: retracted ? 'retracted' : resolved ? 'resolved' : raw.status === 'ambiguous' ? 'ambiguous' : 'unresolved',
    ...(!retracted && !resolved && raw.status !== 'ambiguous' && (raw.resolutionIssue === 'network' || raw.resolutionIssue === 'no-match')
      ? { resolutionIssue: raw.resolutionIssue as UserKnownLocation['resolutionIssue'] } : {}),
    resolvedName: resolved ? raw.resolvedName : null,
    timeZone: resolved ? raw.timeZone : null,
    latitude: resolved ? raw.latitude : null, longitude: resolved ? raw.longitude : null,
    geocodingQuery: raw.geocodingQuery, updatedAt: raw.updatedAt,
  };
}

/** A short answer is accepted only as a region, never as a weather question or
 * an arbitrary continuation. The pending disclosure supplies the city. */
export function isLocationRegionAnswer(text: unknown, region: unknown): region is string {
  if (typeof text !== 'string' || typeof region !== 'string' || text.trim() !== region || region.length > 80) return false;
  return /^(?:[\p{L}\p{M} .·'-]{1,60}(?:州|省|県|都|府|自治区)|(?:state|province) of [\p{L}\p{M} .·'-]{1,60})$/iu.test(region)
    && !/(?:天气|气温|在哪|哪里|怎样|如何|weather|temperature|where|how)/iu.test(region);
}

export async function getUserKnownLocation(): Promise<UserKnownLocation | null> {
  return sanitizeUserKnownLocation(await db.getVal(USER_KNOWN_LOCATION_KEY, null));
}

async function getDataEpoch(): Promise<string> {
  const value = await db.getVal(TURN_DATA_EPOCH_KEY, 'initial');
  return typeof value === 'string' && value ? value : 'initial';
}

async function readLocationSnapshot(): Promise<{ known: UserKnownLocation | null; epoch: string }> {
  return db.transaction('r', db.keyval, async () => ({ known: await getUserKnownLocation(), epoch: await getDataEpoch() }));
}

async function fetchJson(url: string, signal?: AbortSignal, taskContext?: TaskContext): Promise<any> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 8000);
  try {
    const request = async (activeSignal: AbortSignal) => {
      const response = await fetch(url, { signal: activeSignal });
      if (!response.ok) throw new Error(`Location query returned HTTP ${response.status}`);
      return response.json();
    };
    const { runTaskTransport, runStandaloneTransport } = await import('./taskGateway');
    const target = { provider: 'open-meteo', operation: url.includes('/forecast?') ? 'weather' : 'geocode', configRevision: 'public-v1' };
    return taskContext
      ? await runTaskTransport({ ...taskContext, signal: controller.signal }, target, request, () => {})
      : await runStandaloneTransport(target, request, () => {}, controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function resolveDisclosedPlace(disclosure: UserLocationDisclosure, signal?: AbortSignal, taskContext?: TaskContext): Promise<Pick<UserKnownLocation, 'status' | 'resolutionIssue' | 'resolvedName' | 'timeZone' | 'latitude' | 'longitude' | 'geocodingQuery'>> {
  const clarification = (disclosure as UserKnownLocation).clarification;
  const geocodingQuery = disclosure.cityName
    ? [disclosure.cityName, disclosure.regionQualifier].filter(Boolean).join(', ')
    : disclosure.locationText;
  const query = clarification ? [disclosure.cityName || disclosure.locationText, clarification.regionQualifier].join(', ') : geocodingQuery;
  const unknown = { status: 'unresolved' as const, resolutionIssue: 'no-match' as const, resolvedName: null, timeZone: null, latitude: null, longitude: null, geocodingQuery: query };
  try {
    // No IP/device fallback. A qualifier must itself come from the disclosure.
    const language = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(disclosure.locationText) ? 'ja'
      : /\p{Script=Han}/u.test(disclosure.locationText) ? 'zh' : 'en';
    const cityQuery = clarification ? disclosure.cityName || disclosure.locationText : geocodingQuery;
    const result = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityQuery)}&count=10&language=${language}&format=json`, signal, taskContext);
    const candidates = Array.isArray(result?.results) ? result.results.filter((place: any) => (
      place && typeof place.name === 'string' && /^PPL/u.test(place.feature_code || '')
      && Number.isFinite(place.latitude) && Math.abs(place.latitude) <= 90
      && Number.isFinite(place.longitude) && Math.abs(place.longitude) <= 180 && validZone(place.timezone)
    )) : [];
    // The endpoint performs prefix matching. Only exact city-name hits qualify;
    // never pick the first/popular city from an ambiguous search result.
    const city = disclosure.cityName || disclosure.locationText.split(',')[0].trim();
    let exact = candidates.filter((place: any) => place.name.normalize('NFKC').toLocaleLowerCase() === city.normalize('NFKC').toLocaleLowerCase());
    if (clarification) {
      // Compare identifiers from the geocoder, not guessed translations of a
      // Chinese state name. A failed/ambiguous region lookup remains unresolved.
      const regionName = clarification.regionQualifier.replace(/(?:州|省|県|都|府|自治区)$/u, '').replace(/^(?:state|province) of /iu, '').trim();
      const regions = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(regionName)}&count=10&language=${language}&format=json`, signal, taskContext);
      const ids = (Array.isArray(regions?.results) ? regions.results : []).filter((region: any) =>
        region && /^ADM1$/u.test(region.feature_code || '') && Number.isSafeInteger(region.id)
        && typeof region.name === 'string' && region.name.normalize('NFKC').toLocaleLowerCase() === regionName.normalize('NFKC').toLocaleLowerCase()).map((region: any) => region.id);
      if (ids.length !== 1) return unknown;
      exact = exact.filter((place: any) => place.admin1_id === ids[0]);
    }
    if (exact.length !== 1) return exact.length > 1 || candidates.length > 1
      ? { ...unknown, status: 'ambiguous', resolutionIssue: undefined } : unknown;
    const place = exact[0];
    return {
      status: 'resolved', resolutionIssue: undefined, resolvedName: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
      timeZone: place.timezone, latitude: place.latitude, longitude: place.longitude, geocodingQuery: query,
    };
  } catch (error) {
    if (signal?.aborted || ['busy', 'budget', 'expired', 'paused'].includes((error as any)?.kind)) throw error;
    // The disclosed place remains known even if geographic resolution failed.
    return { ...unknown, resolutionIssue: 'network' };
  }
}

/** Attach the second, independently persisted user message to the original
 * disclosure; neither a synthesized sentence nor an assistant question is a
 * source. A newer fact, edited evidence or restored epoch makes it stale. */
export async function clarifyUserLocationRegion(
  original: Pick<Message, 'id' | 'text' | 'timestamp' | 'role'>,
  answer: Pick<Message, 'id' | 'text' | 'timestamp' | 'role'>,
  options: { expectedEpoch: string; sequence: number },
): Promise<UserKnownLocation | null> {
  const region = answer.text.trim();
  if (answer.role !== 'user' || !isLocationRegionAnswer(answer.text, region)
    || !Number.isSafeInteger(options.sequence) || options.sequence < 0) return null;
  return db.transaction('rw', [db.keyval, db.messages], async () => {
    if (await getDataEpoch() !== options.expectedEpoch) return null;
    for (const source of [original, answer]) {
      const actual = await db.messages.get(source.id);
      if (!actual || actual.role !== 'user' || actual.text !== source.text || actual.timestamp !== source.timestamp) return null;
    }
    const current = await getUserKnownLocation();
    if (current?.sourceMessage.id === original.id && current.clarification?.sourceMessage.id === answer.id
      && current.clarification.sourceMessage.text === answer.text && current.clarification.sourceMessage.timestamp === answer.timestamp
      && current.clarification.sourceMessage.sequence === options.sequence) return current;
    if (!current || current.status === 'retracted' || current.sourceMessage.id !== original.id
      || current.sourceMessage.text !== original.text || current.sourceMessage.timestamp !== original.timestamp
      || (current.sourceMessage.sequence !== undefined && current.sourceMessage.sequence >= options.sequence)
      || (current.clarification && current.clarification.sourceMessage.sequence >= options.sequence)) return null;
    const updated: UserKnownLocation = { ...current, revision: (current.revision || 0) + 1,
      clarification: { regionQualifier: region, sourceMessage: { id: answer.id, text: answer.text,
        timestamp: answer.timestamp, role: 'user', sequence: options.sequence } },
      status: 'unresolved', resolutionIssue: undefined, resolvedName: null, timeZone: null, latitude: null, longitude: null,
      geocodingQuery: `${current.cityName || current.locationText}, ${region}`, updatedAt: Date.now() };
    await db.setVal(USER_KNOWN_LOCATION_KEY, updated);
    return updated;
  });
}

/** Only the actual user-turn coordinator may commit a sourced proposal.
 * Timestamp/id order is verified against persisted messages, never model order.
 * A coordinator with its own persistent input sequence may supply that instead.
 */
export async function commitUserLocationFact(
  candidate: unknown,
  source: Pick<Message, 'id' | 'text' | 'timestamp' | 'role'>,
  options: { isActualUserTurn: boolean; sourceSequence?: number; expectedEpoch?: string },
): Promise<UserKnownLocation | null> {
  if (!options?.isActualUserTurn || source?.role !== 'user' || !shortText(source.id, 200)
    || typeof source.text !== 'string' || source.text.length > 100000 || !Number.isFinite(source.timestamp) || source.timestamp < 0) return null;
  if (options.sourceSequence !== undefined && (!Number.isSafeInteger(options.sourceSequence) || options.sourceSequence < 0)) return null;
  if (options.expectedEpoch !== undefined && !shortText(options.expectedEpoch, 200)) return null;
  const disclosure = validateLocationFactCandidate(candidate, source.text);
  if (!disclosure) return null;
  const record: UserKnownLocation = {
    version: 1, locationText: disclosure.locationText, sourceQuote: disclosure.sourceQuote,
    ...(disclosure.cityName ? { cityName: disclosure.cityName } : {}),
    ...(disclosure.regionQualifier ? { regionQualifier: disclosure.regionQualifier } : {}),
    sourceMessage: { id: source.id, text: source.text, timestamp: source.timestamp, role: 'user',
      ...(options.sourceSequence !== undefined ? { sequence: options.sourceSequence } : {}) },
    status: disclosure.kind === 'retract' ? 'retracted' : 'unresolved', resolvedName: null, timeZone: null, latitude: null, longitude: null,
    geocodingQuery: disclosure.cityName ? [disclosure.cityName, disclosure.regionQualifier].filter(Boolean).join(', ') : disclosure.locationText,
    updatedAt: Date.now(),
  };
  // Save the new disclosure before touching the network. Until resolved, the
  // new place is known but its clock/weather stay unknown rather than using A.
  const saved = await db.transaction('rw', [db.keyval, db.messages], async () => {
    if (options.expectedEpoch !== undefined && await getDataEpoch() !== options.expectedEpoch) return null;
    const persistedSource = await db.messages.get(source.id);
    if (!persistedSource || persistedSource.role !== 'user' || persistedSource.text !== source.text || persistedSource.timestamp !== source.timestamp) return null;
    const current = await getUserKnownLocation();
    if (current) {
      if (current.sourceMessage.id === source.id) return current;
      const previous = await db.messages.get(current.sourceMessage.id);
      const previousSource = previous?.role === 'user' && previous.text === current.sourceMessage.text
        && previous.timestamp === current.sourceMessage.timestamp ? previous : current.sourceMessage;
      const priorSequence = current.clarification?.sourceMessage.sequence ?? current.sourceMessage.sequence;
      if (options.sourceSequence !== undefined && priorSequence !== undefined) {
        if (options.sourceSequence <= priorSequence) return current;
      } else if (previousSource.timestamp > persistedSource.timestamp
        || (previousSource.timestamp === persistedSource.timestamp && previousSource.id >= persistedSource.id)) return current;
      // Leaving a different historical city does not retract a later disclosure.
      if (disclosure.kind === 'retract' && current.status !== 'retracted'
        && disclosure.locationText !== current.locationText && disclosure.locationText !== current.cityName
        && !(/\p{Script=Han}/u.test(disclosure.locationText) && disclosure.locationText.length >= 2
          && current.locationText.endsWith(disclosure.locationText))) return null;
    }
    record.revision = (current?.revision || 0) + 1;
    await db.setVal(USER_KNOWN_LOCATION_KEY, record);
    return record;
  });
  if (saved?.sourceMessage.id === source.id && saved.status === 'unresolved') {
    // Background maintenance resolves the persisted disclosure under its budget.
  }
  return saved;
}

/** Legacy callers remain assertion-only. */
export async function commitUserKnownLocationDisclosure(
  candidate: unknown,
  source: Pick<Message, 'id' | 'text' | 'timestamp' | 'role'>,
  options: { isActualUserTurn: boolean; sourceSequence?: number; expectedEpoch?: string },
): Promise<UserKnownLocation | null> {
  if (!validateUserLocationDisclosure(candidate, source?.text || '')) return null;
  return commitUserLocationFact(candidate, source, options);
}

const pendingResolutions = new Map<string, Promise<UserKnownLocation | null>>();

function waitForResolution<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('Location resolution aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('Location resolution aborted')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Resolve a disclosed name without changing its source or ever consulting settings.
 * Reuses this source's in-flight lookup; waiting never fetches weather.
 */
export async function resolveKnownUserLocation(signal?: AbortSignal, taskContext?: TaskContext, assertCurrent?: () => Promise<void>): Promise<UserKnownLocation | null> {
  if (signal?.aborted) throw new Error('Location resolution aborted');
  const { known, epoch } = await readLocationSnapshot();
  if (!known || known.status !== 'unresolved') return known;
  const sourceId = known.sourceMessage.id;
  const revision = known.revision;
  const resolutionKey = JSON.stringify([epoch, sourceId, revision, known.sourceQuote, known.updatedAt, taskContext?.lane || 'direct']);
  let pending = pendingResolutions.get(resolutionKey);
  if (!pending) {
    pending = (async () => {
      const resolved = await resolveDisclosedPlace(known, signal, taskContext);
      const tables: Array<import('dexie').Table<any, any>> = [db.keyval];
      if (assertCurrent) tables.push(db.table('runtimeJobs'));
      return db.transaction('rw', tables, async () => {
        await assertCurrent?.();
        const current = await getUserKnownLocation();
        if (await getDataEpoch() !== epoch || !current || current.sourceMessage.id !== sourceId || current.revision !== revision
          || current.sourceQuote !== known.sourceQuote || current.updatedAt !== known.updatedAt || current.status !== 'unresolved') return current;
        const refreshed = { ...current, ...resolved };
        await db.setVal(USER_KNOWN_LOCATION_KEY, refreshed);
        await assertCurrent?.();
        return refreshed;
      });
    })();
    pendingResolutions.set(resolutionKey, pending);
    const clear = () => { if (pendingResolutions.get(resolutionKey) === pending) pendingResolutions.delete(resolutionKey); };
    void pending.then(clear, clear);
  }
  await waitForResolution(pending, signal);
  return getUserKnownLocation();
}

export const resolveUserKnownLocation = resolveKnownUserLocation;

/** An unresolved newer disclosure suspends current-location use without
 * erasing the last verified historical fact. Applies to proactive tools too. */
export async function isUserLocationUncertain(): Promise<boolean> {
  return db.transaction('r', [db.keyval, db.messages], async () => {
    const known = await getUserKnownLocation();
    if (known?.clarification) {
      for (const source of [known.sourceMessage, known.clarification.sourceMessage]) {
        const actual = await db.messages.get(source.id);
        if (!actual || actual.role !== 'user' || actual.text !== source.text || actual.timestamp !== source.timestamp) return true;
      }
    }
    const marker = await db.getVal<{ epoch: string; sources: Array<Pick<Message, 'id' | 'role' | 'text' | 'timestamp'>> } | null>('kumiko_turn_location_uncertain_v1', null);
    if (!marker || marker.epoch !== await getDataEpoch()) return false;
    if (!Array.isArray(marker.sources) || !marker.sources.length) return true;
    for (const source of marker.sources) {
      const actual = await db.messages.get(source.id);
      if (!actual || actual.role !== 'user' || actual.text !== source.text || actual.timestamp !== source.timestamp) return false;
    }
    return true;
  });
}

export async function buildUserKnownLocationContext(language: Language = 'zh'): Promise<string> {
  if (await isUserLocationUncertain()) return language === 'zh'
    ? '[用户所在地认知]\n用户新提到的位置尚未确认。此前保存的地点仅作历史，不能当作当前所在地；当前时区、当地时间和天气未知。可以自然询问城市，不从设备/IP/设置猜测。'
    : '[KNOWN USER LOCATION]\nA newer user location statement is unconfirmed. Previously saved places are historical only; current location, timezone, local time and weather are unknown. Ask which city naturally; do not infer it from device/IP/settings.';
  const known = await getUserKnownLocation();
  if (!known) return language === 'zh'
    ? '[用户所在地认知]\n暂无已保存且有原话出处的位置记录。没有可靠用户披露时，时区、当地时间和天气均未知；软件设置、设备/IP不能补充这些事实。'
    : '[KNOWN USER LOCATION]\nNo saved location record with a user-quote source is available. Without a reliable user disclosure, their timezone, local time and weather are unknown; device/IP/settings cannot supply these facts.';
  if (known.status === 'retracted') return language === 'zh'
    ? `[用户所在地认知]\n用户已撤回旧地点或明确离开，当前位置未知。用户原话：${JSON.stringify(known.sourceQuote)}；出处：用户消息 ${known.sourceMessage.id}；版本：${known.revision || 0}。旧地点仅是历史，不能继续认定仍在那里或查询其当前所在地天气；时区、当地时间和天气未知，不从设备/IP/设置补充。`
    : `[KNOWN USER LOCATION]\nThe user retracted their previous location or explicitly left it. Their current location, timezone, local time and weather are unknown. User quote: ${JSON.stringify(known.sourceQuote)}; source: user message ${known.sourceMessage.id}; revision: ${known.revision || 0}. The old place is historical only. Do not query it as the user's current weather or infer a location from device/IP/settings.`;
  const localTime = known.timeZone
    ? new Date().toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', { timeZone: known.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' })
    : null;
  const unresolvedText = known.status === 'ambiguous'
    ? (language === 'zh' ? '地点存在真实歧义，时区/当地时间/天气未知；自然询问地区以区分，不猜城市。' : 'The place is ambiguous; timezone, local time and weather are unknown. Ask which region without guessing.')
    : known.resolutionIssue === 'network'
      ? (language === 'zh' ? '地点查询暂时不可用，时区/当地时间/天气未知；保留用户已告知的地点并等待后台重试，不要因此追问更具体地址。' : 'Location lookup is temporarily unavailable; timezone, local time and weather are unknown. Retain the disclosed place and await a background retry; do not ask for a more specific address because of this failure.')
      : (language === 'zh' ? '地点暂未解析，时区/当地时间/天气未知；保留原话并等待后台重试，不猜城市或要求更具体地址。' : 'The disclosed place is not yet resolved; timezone, local time and weather are unknown. Retain the disclosure and await a background retry; do not guess or request a more specific address.');
  return language === 'zh'
    ? `[用户已告知的所在地]\n地点：${known.locationText}${known.clarification ? `；补充地区：${known.clarification.regionQualifier}（用户消息 ${known.clarification.sourceMessage.id} 原话：${JSON.stringify(known.clarification.sourceMessage.text)}）` : ''}\n用户原话：${JSON.stringify(known.sourceQuote)}\n出处：用户消息 ${known.sourceMessage.id}\n持续认定用户仍在该地，直到用户主动告知新地点；设备/软件位置及时区变化不改变这项认知。\n${localTime ? `已核实该地点时区：${known.timeZone}；当地现在：${localTime}。可以自然关心当地情况，主动调用 query_known_user_weather 查询新鲜天气。` : unresolvedText}\n天气只有工具查询成功后才算已知；本轮首次披露尚未保存时不要声称已查询。`
    : `[USER-DISCLOSED LOCATION]\nLocation: ${known.locationText}${known.clarification ? `; region clarification: ${known.clarification.regionQualifier} (user message ${known.clarification.sourceMessage.id}: ${JSON.stringify(known.clarification.sourceMessage.text)})` : ''}\nUser quote: ${JSON.stringify(known.sourceQuote)}\nSource: user message ${known.sourceMessage.id}\nContinue to regard the user as being there until they disclose a new place. Device/settings timezone or location changes do not alter this knowledge.\n${localTime ? `Resolved timezone: ${known.timeZone}; current local time: ${localTime}. You may naturally care about local conditions and proactively call query_known_user_weather for fresh weather.` : unresolvedText}\nWeather is known only after a successful tool query. Do not claim it was checked on the first disclosure turn before the location is saved.`;
}

export async function queryKnownUserLocationWeather(signal?: AbortSignal, taskContext?: TaskContext): Promise<Record<string, unknown>> {
  const uncertain = () => ({ success: false, status: 'unknown', location: null, reason: 'A newer user location statement is unconfirmed; ask which city they are in.' });
  if (await isUserLocationUncertain()) return uncertain();
  await resolveKnownUserLocation(signal, taskContext);
  const { known, epoch } = await readLocationSnapshot();
  if (await isUserLocationUncertain()) return uncertain();
  if (!known || known.status !== 'resolved') return { success: false, status: 'unknown', location: known?.status === 'retracted' ? null : known?.locationText || null, reason: known?.status === 'retracted' ? 'Previous location was retracted; current location is unknown.' : known?.status === 'ambiguous' ? 'Location is ambiguous; ask the user to clarify the region.' : known?.resolutionIssue === 'network' ? 'Location lookup is temporarily unavailable. Retain the disclosed location and await background retry; do not ask for a more specific address due to this failure.' : known ? 'Location is not yet resolved; retain the disclosure and await background retry without asking for a more specific address.' : 'User has not disclosed their location.' };
  try {
    const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${known.latitude}&longitude=${known.longitude}&current=temperature_2m,apparent_temperature,weather_code,precipitation,wind_speed_10m&timezone=${encodeURIComponent(known.timeZone!)}`, signal, taskContext);
    const { known: latest, epoch: latestEpoch } = await readLocationSnapshot();
    if (await isUserLocationUncertain()) return uncertain();
    if (epoch !== latestEpoch || !latest || latest.status !== 'resolved' || latest.sourceMessage.id !== known.sourceMessage.id
      || latest.revision !== known.revision || latest.sourceQuote !== known.sourceQuote || latest.updatedAt !== known.updatedAt
      || latest.latitude !== known.latitude || latest.longitude !== known.longitude || latest.timeZone !== known.timeZone) return { success: false, status: 'unknown', reason: 'User location changed while weather was in flight. Query again for the current place.' };
    const current = data?.current;
    if (!current || !Number.isFinite(current.temperature_2m) || !Number.isFinite(current.weather_code) || typeof current.time !== 'string') throw new Error('Weather response lacks current conditions');
    return { success: true, location: known.locationText, resolvedLocation: known.resolvedName, timeZone: known.timeZone,
      locationRevision: known.revision || 0, sourceMessageId: known.sourceMessage.id, locationEpoch: epoch,
      observedAt: current.time, fetchedAt: Date.now(), weather: current, units: data.current_units || {}, source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/' };
  } catch (error) {
    if (signal?.aborted || ['busy', 'budget', 'expired', 'paused'].includes((error as any)?.kind)) throw error;
    return { success: false, status: 'unknown', location: known.locationText, reason: error instanceof Error ? error.message : String(error) };
  }
}
