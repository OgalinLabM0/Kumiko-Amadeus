// Weather + Japanese-holiday IPC handlers. Extracted from electron-main.cjs
// (Plan 9 SubPhase 3.1). Zero mainWindow dependency: everything in this
// module is pure HTTPS fetch + local file cache.
//
//   - Uji (Kyoto), fixed coordinates, for the primary weather block shown
//     in the home screen.
//   - User's IP-derived coordinates (via ipapi.co HTTPS) for a secondary
//     "your weather" block. If ipapi fails we silently drop that block —
//     original behaviour preserved from the old ip-api.com path (P2 #55).
//   - open-meteo archive API for historical diary backfill.
//   - holidays-jp for the Japanese holiday picker, cached in userData
//     with a 24h TTL so we don't hammer the upstream on every app
//     restart.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const UJI_LATLON = { lat: 34.8906, lon: 135.8016 };
const HOLIDAY_CACHE_FILE_NAME = 'holidays-cache.json';
const HOLIDAY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// open-meteo weathercode → short Chinese summary. Mirrors the mapping the
// original inline implementation used in electron-main.cjs; only called
// from the historical handler below, so keep it module-local.
function mapWeatherCodeToChinese(code) {
  if (code === 0) return '晴';
  if (code === 1 || code === 2 || code === 3) return '多云';
  if (code >= 45 && code <= 48) return '雾';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '雨';
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return '雪';
  if (code >= 95) return '雷雨';
  return '';
}

async function handleGetWeather() {
  try {
    const ujiResponse = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${UJI_LATLON.lat}&longitude=${UJI_LATLON.lon}&current_weather=true&timezone=Asia%2FTokyo`
    );
    const ujiData = await ujiResponse.json();

    // User location based on IP.
    // P2 #55: swapped the free ip-api.com endpoint (HTTP-only unless you pay)
    // for ipapi.co's HTTPS endpoint, so the user's IP-derived coordinates can
    // no longer be observed / modified by a man in the middle. If the HTTPS
    // call fails we simply don't surface a user-side weather block — we used
    // to silently drop it anyway when ip-api timed out.
    let userWeather = null;
    try {
      const ipResponse = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(5000) });
      const ipData = await ipResponse.json();
      const lat = ipData.latitude ?? ipData.lat;
      const lon = ipData.longitude ?? ipData.lon;
      if (typeof lat === 'number' && typeof lon === 'number') {
        const userWeatherResponse = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
        userWeather = await userWeatherResponse.json();
      }
    } catch (e) {
      console.warn('[Weather] Failed to fetch user weather:', e);
    }

    return {
      success: true,
      uji: ujiData.current_weather,
      user: userWeather?.current_weather || null
    };
  } catch (e) {
    console.error('[Weather] Failed to fetch weather data:', e);
    return { success: false, error: e.message };
  }
}

async function handleGetHistoricalWeather(_event, dateStr) {
  try {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return { success: false, error: 'Invalid date format' };
    }
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${UJI_LATLON.lat}&longitude=${UJI_LATLON.lon}&start_date=${dateStr}&end_date=${dateStr}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=Asia%2FTokyo`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.daily && data.daily.weathercode && data.daily.weathercode.length > 0) {
      const weathercode = data.daily.weathercode[0];
      const tempMax = data.daily.temperature_2m_max?.[0];
      const tempMin = data.daily.temperature_2m_min?.[0];
      const cond = typeof weathercode === 'number' ? mapWeatherCodeToChinese(weathercode) : '';
      const tempStr = (tempMax != null && tempMin != null) ? `, ${tempMin}~${tempMax}°C` : '';
      return {
        success: true,
        weather: `${cond}${tempStr}`,
        weathercode,
        conditionText: cond,
      };
    }
    return { success: false, error: 'No data for date' };
  } catch (e) {
    console.warn('[Weather] Historical weather fetch failed:', e.message);
    return { success: false, error: e.message };
  }
}

async function handleGetJapanHolidays() {
  try {
    const cachePath = path.join(app.getPath('userData'), HOLIDAY_CACHE_FILE_NAME);
    let cachedData = null;

    try {
      if (fs.existsSync(cachePath)) {
        const stat = fs.statSync(cachePath);
        const now = new Date().getTime();
        if (now - stat.mtimeMs < HOLIDAY_CACHE_TTL_MS) {
          cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        }
      }
    } catch (e) {
      console.warn('[Holidays] Failed to read cache:', e);
    }

    if (cachedData) {
      return { success: true, holidays: cachedData };
    }

    const response = await fetch('https://holidays-jp.github.io/api/v1/date.json');
    const data = await response.json();

    try {
      fs.writeFileSync(cachePath, JSON.stringify(data), 'utf-8');
    } catch (e) {
      console.warn('[Holidays] Failed to write cache:', e);
    }

    return { success: true, holidays: data };
  } catch (e) {
    console.error('[Holidays] Failed to fetch holiday data:', e);
    return { success: false, error: e.message };
  }
}

module.exports = {
  handleGetWeather,
  handleGetHistoricalWeather,
  handleGetJapanHolidays,
};
