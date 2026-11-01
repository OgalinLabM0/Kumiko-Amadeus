import type { Language, Message, UserLocationDisclosure } from '../types';
import { db } from './db';

// Deliberately separate from LocationConfig, IP lookup and device preferences.
export const USER_KNOWN_LOCATION_KEY = 'user_known_location_v1';

export interface UserKnownLocation {
  version: 1;
  locationText: string;
  sourceQuote: string;
  cityName?: string;
  regionQualifier?: string;
  sourceMessage: { id: string; text: string; timestamp: number; role: 'user' };
  status: 'resolved' | 'ambiguous' | 'unresolved';
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

/** Validate a model extraction; this does not persist anything or infer a place. */
export function validateUserLocationDisclosure(candidate: unknown, sourceText: string): UserLocationDisclosure | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (!shortText(value.locationText, 120) || !shortText(value.sourceQuote, 500)) return null;
  const { locationText, sourceQuote } = value;
  if (/\[User_Location_Update\b|(?:请|帮我|要求).{0,30}(?:输出|复读|假装|伪造)|\b(?:pretend|repeat|hypothetical)\b/iu.test(sourceText)) return null;
  const quoteIndex = sourceText.indexOf(sourceQuote);
  if (quoteIndex < 0 || !sourceQuote.includes(locationText)) return null;
  if (/[？?]/u.test(sourceQuote) || /^\s*(?:吗|么|吧|对吗)?\s*[？?]/u.test(sourceText.slice(quoteIndex + sourceQuote.length))) return null;
  // This is a conservative evidence gate, not a guessed "user knows" flag.
  // Semantic extraction belongs to the model; only explicit self-location
  // statements can cross the persistence boundary. Unclear wording stays unknown.
  if (!/^(?:我(?:现在|目前|这几天|最近|已经|刚)?(?:人)?(?:在|住在|搬到(?:了)?|从.{1,80}搬到(?:了)?)|I(?:\s+am|'m|’m)\s+(?:now\s+|currently\s+)?(?:in|at)\b|I\s+(?:live|am living|moved)\s+(?:in|to|from)\b)/iu.test(sourceQuote)) return null;
  const sentenceStart = Math.max(...['。', '！', '？', '\n', '!', '?'].map(mark => sourceText.lastIndexOf(mark, quoteIndex - 1))) + 1;
  const sentenceEndIndex = sourceText.slice(quoteIndex + sourceQuote.length).search(/[。！？\n!?]/u);
  const sentenceEnd = sentenceEndIndex < 0 ? sourceText.length : quoteIndex + sourceQuote.length + sentenceEndIndex;
  const sentence = sourceText.slice(sentenceStart, sentenceEnd);
  if (/(?:如果|假如|假设|假定|比如|例如|举例|他说|她说|你说|转述|复述|复读|假装|输出|伪造|模拟|\b(?:if|suppose|pretend|hypothetical|quote|repeat)\b|he said|she said)/iu.test(sentence)) return null;
  if (/(?:去过|住过|想去|打算去|准备去|曾经|以前|之前|不在|没在|不是在|并非|吗[？?]?|used to|want to|not in)/iu.test(sourceQuote)) return null;
  const locationIndex = sourceQuote.indexOf(locationText);
  if (/(?:搬到|moved\s+from)/iu.test(sourceQuote) && !/(?:搬到(?:了)?\s*|\bto\s+)$/iu.test(sourceQuote.slice(0, locationIndex))) return null;
  // A quote within another person's words or a machine-instruction block is
  // not a direct disclosure, even when the extracted substring looks valid.
  if (/["“「『`]/u.test(sourceText.slice(sentenceStart, quoteIndex)) || /^\s*\[(?:SYSTEM|CRITICAL_OVERRIDE)/imu.test(sourceText)) return null;
  const result: UserLocationDisclosure = { locationText, sourceQuote };
  for (const field of ['cityName', 'regionQualifier'] as const) {
    if (value[field] !== undefined) {
      if (!shortText(value[field], 120) || !locationText.includes(value[field])) return null;
      result[field] = value[field];
    }
  }
  return result;
}

export function extractUserLocationDisclosureTag(text: string, sourceText: string): { disclosure: UserLocationDisclosure | undefined; cleanText: string } {
  let cleanText = text;
  let disclosure: UserLocationDisclosure | undefined;
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
        if (candidate) disclosure = candidate;
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
  const disclosure = validateUserLocationDisclosure(raw, source.text);
  if (!disclosure || !shortText(raw.geocodingQuery, 250)) return null;
  const resolved = raw.status === 'resolved' && validZone(raw.timeZone)
    && Number.isFinite(raw.latitude) && Math.abs(raw.latitude) <= 90
    && Number.isFinite(raw.longitude) && Math.abs(raw.longitude) <= 180
    && shortText(raw.resolvedName, 250);
  return {
    version: 1, locationText: disclosure.locationText, sourceQuote: disclosure.sourceQuote,
    ...(disclosure.cityName ? { cityName: disclosure.cityName } : {}),
    ...(disclosure.regionQualifier ? { regionQualifier: disclosure.regionQualifier } : {}),
    sourceMessage: { id: source.id, text: source.text, timestamp: source.timestamp, role: 'user' },
    status: resolved ? 'resolved' : raw.status === 'ambiguous' ? 'ambiguous' : 'unresolved',
    resolvedName: resolved ? raw.resolvedName : null,
    timeZone: resolved ? raw.timeZone : null,
    latitude: resolved ? raw.latitude : null, longitude: resolved ? raw.longitude : null,
    geocodingQuery: raw.geocodingQuery, updatedAt: raw.updatedAt,
  };
}

export async function getUserKnownLocation(): Promise<UserKnownLocation | null> {
  return sanitizeUserKnownLocation(await db.getVal(USER_KNOWN_LOCATION_KEY, null));
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<any> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Location query returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function resolveDisclosedPlace(disclosure: UserLocationDisclosure, signal?: AbortSignal): Promise<Pick<UserKnownLocation, 'status' | 'resolvedName' | 'timeZone' | 'latitude' | 'longitude' | 'geocodingQuery'>> {
  const geocodingQuery = disclosure.cityName
    ? [disclosure.cityName, disclosure.regionQualifier].filter(Boolean).join(', ')
    : disclosure.locationText;
  const unknown = { status: 'unresolved' as const, resolvedName: null, timeZone: null, latitude: null, longitude: null, geocodingQuery };
  try {
    // No IP/device fallback. A qualifier must itself come from the disclosure.
    const language = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(disclosure.locationText) ? 'ja'
      : /\p{Script=Han}/u.test(disclosure.locationText) ? 'zh' : 'en';
    const result = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(geocodingQuery)}&count=10&language=${language}&format=json`, signal);
    const candidates = Array.isArray(result?.results) ? result.results.filter((place: any) => (
      place && typeof place.name === 'string' && /^PPL/u.test(place.feature_code || '')
      && Number.isFinite(place.latitude) && Math.abs(place.latitude) <= 90
      && Number.isFinite(place.longitude) && Math.abs(place.longitude) <= 180 && validZone(place.timezone)
    )) : [];
    // The endpoint performs prefix matching. Only exact city-name hits qualify;
    // never pick the first/popular city from an ambiguous search result.
    const city = disclosure.cityName || disclosure.locationText.split(',')[0].trim();
    const exact = candidates.filter((place: any) => place.name.normalize('NFKC').toLocaleLowerCase() === city.normalize('NFKC').toLocaleLowerCase());
    if (exact.length !== 1) return { ...unknown, status: exact.length > 1 || candidates.length > 1 ? 'ambiguous' : 'unresolved' };
    const place = exact[0];
    return {
      status: 'resolved', resolvedName: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
      timeZone: place.timezone, latitude: place.latitude, longitude: place.longitude, geocodingQuery,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    // The disclosed place remains known even if geographic resolution failed.
    return unknown;
  }
}

/** Only chatActions' actual user-turn path may commit a response proposal. */
export async function commitUserKnownLocationDisclosure(
  candidate: unknown,
  source: Pick<Message, 'id' | 'text' | 'timestamp' | 'role'>,
  options: { isActualUserTurn: boolean },
): Promise<UserKnownLocation | null> {
  if (!options?.isActualUserTurn || source?.role !== 'user' || !shortText(source.id, 200)
    || typeof source.text !== 'string' || !Number.isFinite(source.timestamp) || source.timestamp < 0) return null;
  const disclosure = validateUserLocationDisclosure(candidate, source.text);
  if (!disclosure) return null;
  const record: UserKnownLocation = {
    version: 1, ...disclosure,
    sourceMessage: { id: source.id, text: source.text, timestamp: source.timestamp, role: 'user' },
    status: 'unresolved', resolvedName: null, timeZone: null, latitude: null, longitude: null,
    geocodingQuery: disclosure.cityName ? [disclosure.cityName, disclosure.regionQualifier].filter(Boolean).join(', ') : disclosure.locationText,
    updatedAt: Date.now(),
  };
  // Save the new disclosure before touching the network. Until resolved, the
  // new place is known but its clock/weather stay unknown rather than using A.
  const saved = await db.transaction('rw', db.keyval, async () => {
    const current = await getUserKnownLocation();
    if (current && (current.sourceMessage.timestamp > source.timestamp || current.sourceMessage.id === source.id)) return current;
    await db.setVal(USER_KNOWN_LOCATION_KEY, record);
    return record;
  });
  if (saved.sourceMessage.id === source.id && saved.status === 'unresolved') {
    void resolveKnownUserLocation().catch(error => console.warn('[Known user location] Resolution deferred:', error));
  }
  return saved;
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
export async function resolveKnownUserLocation(signal?: AbortSignal): Promise<UserKnownLocation | null> {
  if (signal?.aborted) throw new Error('Location resolution aborted');
  const known = await getUserKnownLocation();
  if (!known || known.status !== 'unresolved') return known;
  const sourceId = known.sourceMessage.id;
  let pending = pendingResolutions.get(sourceId);
  if (!pending) {
    pending = (async () => {
      const resolved = await resolveDisclosedPlace(known, signal);
      return db.transaction('rw', db.keyval, async () => {
        const current = await getUserKnownLocation();
        if (!current || current.sourceMessage.id !== sourceId) return current;
        const refreshed = { ...current, ...resolved };
        await db.setVal(USER_KNOWN_LOCATION_KEY, refreshed);
        return refreshed;
      });
    })();
    pendingResolutions.set(sourceId, pending);
    const clear = () => { if (pendingResolutions.get(sourceId) === pending) pendingResolutions.delete(sourceId); };
    void pending.then(clear, clear);
  }
  await waitForResolution(pending, signal);
  return getUserKnownLocation();
}

export const resolveUserKnownLocation = resolveKnownUserLocation;

export async function buildUserKnownLocationContext(language: Language = 'zh'): Promise<string> {
  const known = await getUserKnownLocation();
  if (!known) return language === 'zh'
    ? '[用户所在地认知]\n暂无已保存且有原话出处的位置记录。没有可靠用户披露时，时区、当地时间和天气均未知；软件设置、设备/IP不能补充这些事实。'
    : '[KNOWN USER LOCATION]\nNo saved location record with a user-quote source is available. Without a reliable user disclosure, their timezone, local time and weather are unknown; device/IP/settings cannot supply these facts.';
  const localTime = known.timeZone
    ? new Date().toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', { timeZone: known.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' })
    : null;
  return language === 'zh'
    ? `[用户已告知的所在地]\n地点：${known.locationText}\n用户原话：${JSON.stringify(known.sourceQuote)}\n出处：用户消息 ${known.sourceMessage.id}\n持续认定用户仍在该地，直到用户主动告知新地点；设备/软件位置及时区变化不改变这项认知。\n${localTime ? `已核实该地点时区：${known.timeZone}；当地现在：${localTime}。可以自然关心当地情况，主动调用 query_known_user_weather 查询新鲜天气。` : '地点仍未唯一解析，时区/当地时间/天气未知；自然问清城市或地区，不猜城市。'}\n天气只有工具查询成功后才算已知；本轮首次披露尚未保存时不要声称已查询。`
    : `[USER-DISCLOSED LOCATION]\nLocation: ${known.locationText}\nUser quote: ${JSON.stringify(known.sourceQuote)}\nSource: user message ${known.sourceMessage.id}\nContinue to regard the user as being there until they disclose a new place. Device/settings timezone or location changes do not alter this knowledge.\n${localTime ? `Resolved timezone: ${known.timeZone}; current local time: ${localTime}. You may naturally care about local conditions and proactively call query_known_user_weather for fresh weather.` : 'The place is not uniquely resolved. Timezone, local time and weather remain unknown; naturally ask which city/region instead of guessing.'}\nWeather is known only after a successful tool query. Do not claim it was checked on the first disclosure turn before the location is saved.`;
}

export async function queryKnownUserLocationWeather(signal?: AbortSignal): Promise<Record<string, unknown>> {
  const known = await resolveKnownUserLocation(signal);
  if (!known || known.status !== 'resolved') return { success: false, status: 'unknown', location: known?.locationText || null, reason: known ? 'Location is ambiguous or unresolved; ask the user to clarify.' : 'User has not disclosed their location.' };
  try {
    const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${known.latitude}&longitude=${known.longitude}&current=temperature_2m,apparent_temperature,weather_code,precipitation,wind_speed_10m&timezone=${encodeURIComponent(known.timeZone!)}`, signal);
    const latest = await getUserKnownLocation();
    if (!latest || latest.sourceMessage.id !== known.sourceMessage.id) return { success: false, status: 'unknown', reason: 'User disclosed a different location while weather was in flight. Query again for the new place.' };
    const current = data?.current;
    if (!current || !Number.isFinite(current.temperature_2m) || !Number.isFinite(current.weather_code) || typeof current.time !== 'string') throw new Error('Weather response lacks current conditions');
    return { success: true, location: known.locationText, resolvedLocation: known.resolvedName, timeZone: known.timeZone,
      observedAt: current.time, fetchedAt: Date.now(), weather: current, units: data.current_units || {}, source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/' };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { success: false, status: 'unknown', location: known.locationText, reason: error instanceof Error ? error.message : String(error) };
  }
}
