// services/ambientWeatherDirect.ts
//
// A2: native-side mirror of electron/weather-calendar.cjs so the Android
// Capacitor APK can populate the same ambient weather + Japan holiday
// context without round-tripping through PC's `app:get-weather` /
// `app:get-historical-weather` / `app:get-japan-holidays` IPC channels.
//
// Why a separate module?
//   - electron/weather-calendar.cjs is CommonJS, requires `electron`,
//     `fs`, `path`, and writes the holiday cache to userData. None of
//     that works inside the Capacitor WebView.
//   - The PC and the WebView call EXACTLY the same upstream APIs
//     (api.open-meteo.com, ipapi.co, archive-api.open-meteo.com,
//     holidays-jp.github.io), so the only thing that diverges is the
//     transport (CapacitorHttp instead of node fetch) and the cache
//     storage (Dexie keyval instead of fs.writeFileSync).
//   - Returns are shape-identical to the Electron handlers so call sites
//     can just swap the dispatch target without touching the JSON
//     reading code.
//
// CapacitorHttp is enabled in capacitor.config.ts, which globally
// rewrites `fetch()` to bypass WebView CORS. We therefore use the same
// `fetch()` calls the PC handler does — no per-call plugin import.
//
// PWA / Electron callers never reach this module — see ambientContext.ts
// + lifeStreamService.ts for the dispatch.

import { db } from './db';

const UJI_LATLON = { lat: 34.8906, lon: 135.8016 };
const HOLIDAY_CACHE_KEY = 'kumiko_japan_holidays_cache';
const HOLIDAY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface HolidayCacheEntry {
  holidays: Record<string, string>;
  fetchedAtMs: number;
}

interface OpenMeteoCurrentWeather {
  temperature?: number;
  windspeed?: number;
  winddirection?: number;
  weathercode?: number;
  time?: string;
}

export interface WeatherDirectResult {
  success: boolean;
  uji?: OpenMeteoCurrentWeather | null;
  user?: OpenMeteoCurrentWeather | null;
  error?: string;
}

export interface HistoricalWeatherDirectResult {
  success: boolean;
  weather?: string;
  weathercode?: number;
  conditionText?: string;
  error?: string;
}

export interface JapanHolidaysDirectResult {
  success: boolean;
  holidays?: Record<string, string>;
  error?: string;
}

// Mirrors electron/weather-calendar.cjs `mapWeatherCodeToChinese`.
// Kept in this module so the historical handler can stamp the same
// short condition string into the diary backfill payload.
function mapWeatherCodeToChinese(code: number): string {
  if (code === 0) return '晴';
  if (code === 1 || code === 2 || code === 3) return '多云';
  if (code >= 45 && code <= 48) return '雾';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '雨';
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return '雪';
  if (code >= 95) return '雷雨';
  return '';
}

async function fetchJsonWithTimeout<T = unknown>(url: string, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAmbientWeatherDirect(): Promise<WeatherDirectResult> {
  try {
    const ujiData = await fetchJsonWithTimeout<{ current_weather?: OpenMeteoCurrentWeather }>(
      `https://api.open-meteo.com/v1/forecast?latitude=${UJI_LATLON.lat}&longitude=${UJI_LATLON.lon}&current_weather=true&timezone=Asia%2FTokyo`,
    );

    // User location via ipapi.co. Best-effort — failure here just drops
    // the "user weather" block (PC behaviour, see weather-calendar.cjs).
    let userWeather: OpenMeteoCurrentWeather | null = null;
    try {
      const ipData = await fetchJsonWithTimeout<{ latitude?: number; longitude?: number; lat?: number; lon?: number }>(
        'https://ipapi.co/json/',
        5000,
      );
      const lat = ipData.latitude ?? ipData.lat;
      const lon = ipData.longitude ?? ipData.lon;
      if (typeof lat === 'number' && typeof lon === 'number') {
        const userWeatherResp = await fetchJsonWithTimeout<{ current_weather?: OpenMeteoCurrentWeather }>(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`,
        );
        userWeather = userWeatherResp.current_weather || null;
      }
    } catch (e) {
      console.warn('[Weather/direct] user-location weather skipped:', e);
    }

    return {
      success: true,
      uji: ujiData.current_weather || null,
      user: userWeather,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[Weather/direct] fetch failed:', e);
    return { success: false, error: msg };
  }
}

export async function fetchHistoricalWeatherDirect(dateStr: string): Promise<HistoricalWeatherDirectResult> {
  try {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return { success: false, error: 'Invalid date format' };
    }
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${UJI_LATLON.lat}&longitude=${UJI_LATLON.lon}&start_date=${dateStr}&end_date=${dateStr}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=Asia%2FTokyo`;
    const data = await fetchJsonWithTimeout<{
      daily?: { weathercode?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[] };
    }>(url);
    if (data.daily && Array.isArray(data.daily.weathercode) && data.daily.weathercode.length > 0) {
      const weathercode = data.daily.weathercode[0];
      const tempMax = data.daily.temperature_2m_max?.[0];
      const tempMin = data.daily.temperature_2m_min?.[0];
      const cond = typeof weathercode === 'number' ? mapWeatherCodeToChinese(weathercode) : '';
      const tempStr = tempMax != null && tempMin != null ? `, ${tempMin}~${tempMax}°C` : '';
      return {
        success: true,
        weather: `${cond}${tempStr}`,
        weathercode,
        conditionText: cond,
      };
    }
    return { success: false, error: 'No data for date' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.warn('[Weather/direct] historical fetch failed:', msg);
    return { success: false, error: msg };
  }
}

export async function fetchJapanHolidaysDirect(): Promise<JapanHolidaysDirectResult> {
  // Try Dexie cache first (24h TTL, mirrors electron/weather-calendar.cjs).
  // Failure here is non-fatal — falls through to network fetch.
  try {
    const cached = await db.getVal<HolidayCacheEntry | null>(HOLIDAY_CACHE_KEY, null);
    if (
      cached
      && typeof cached.fetchedAtMs === 'number'
      && cached.holidays
      && typeof cached.holidays === 'object'
      && Date.now() - cached.fetchedAtMs < HOLIDAY_CACHE_TTL_MS
    ) {
      return { success: true, holidays: cached.holidays };
    }
  } catch (e) {
    console.warn('[Holidays/direct] cache read failed:', e);
  }

  try {
    const data = await fetchJsonWithTimeout<Record<string, string>>(
      'https://holidays-jp.github.io/api/v1/date.json',
    );

    // Best-effort cache write; never blocks the return.
    try {
      const entry: HolidayCacheEntry = { holidays: data, fetchedAtMs: Date.now() };
      await db.setVal(HOLIDAY_CACHE_KEY, entry);
    } catch (e) {
      console.warn('[Holidays/direct] cache write failed:', e);
    }

    return { success: true, holidays: data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[Holidays/direct] fetch failed:', e);
    return { success: false, error: msg };
  }
}
