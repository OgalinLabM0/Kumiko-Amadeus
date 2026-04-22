import { isMobilePwa } from '../../services/environment';
import { httpInvoke } from '../../services/httpApi';

// Environment cache to avoid spamming the main process
let cachedEnvironmentStr: string | null = null;
let lastEnvironmentFetchTime = 0;

// Unified invoker. Desktop Electron goes through `window.electronAPI.invoke`;
// the mobile PWA goes through the Fastify `httpInvoke` for the same channel
// names (both `app:get-weather` and `app:get-japan-holidays` are whitelisted
// in `services/httpApi.ts` + `electron/server/ipc-bridge.cjs`). Before this
// helper existed, the function exited early when `isDesktopElectron()` was
// false, so the phone's prompt had no weather / holiday context even though
// the server can answer those channels — see audit report for details.
type AmbientInvoker = (channel: string, args?: unknown) => Promise<any>;

const resolveAmbientInvoker = (): AmbientInvoker | null => {
  const api = (typeof window !== 'undefined' ? (window as any).electronAPI : null);
  if (api && typeof api.invoke === 'function') {
    return (channel: string, args?: unknown) => api.invoke(channel, args);
  }
  if (isMobilePwa()) {
    return (channel: string, args?: unknown) => httpInvoke(channel, args);
  }
  return null;
};

export const getAmbientEnvironmentContext = async (): Promise<string> => {
  const invoke = resolveAmbientInvoker();
  if (!invoke) return '';

  const now = Date.now();
  if (cachedEnvironmentStr && (now - lastEnvironmentFetchTime < 30 * 60 * 1000)) {
    return cachedEnvironmentStr;
  }

  let envStr = `\n[SYSTEM_ENVIRONMENT_DATA]`;
  let hasData = false;

  try {
    const res = await invoke('app:get-weather');
    if (res && res.success) {
      const uji = res.uji;
      const user = res.user;
      
      const mapWeatherCode = (code: number): string => {
        if (code === 0) return '晴';
        if (code === 1 || code === 2 || code === 3) return '多云';
        if (code >= 45 && code <= 48) return '雾';
        if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '雨';
        if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return '雪';
        if (code >= 95) return '雷雨';
        return '未知';
      };

      if (uji) {
        const cond = typeof uji.weathercode === 'number' ? mapWeatherCode(uji.weathercode) : '';
        envStr += `\n- 久美子所在地 (日本宇治市) 当前天气: ${cond ? cond + ', ' : ''}温度 ${uji.temperature}°C, 风速 ${uji.windspeed}km/h`;
        hasData = true;
      }
      if (user) {
        const cond = typeof user.weathercode === 'number' ? mapWeatherCode(user.weathercode) : '';
        envStr += `\n- 用户所在地当前天气: ${cond ? cond + ', ' : ''}温度 ${user.temperature}°C, 风速 ${user.windspeed}km/h`;
        hasData = true;
      }
    }
  } catch (e) {
    console.warn('[Environment] Failed to fetch ambient weather context:', e);
  }

  try {
    const holidayRes = await invoke('app:get-japan-holidays');
    const jstDate = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Tokyo"}));
    const year = jstDate.getFullYear();
    const month = String(jstDate.getMonth() + 1).padStart(2, '0');
    const day = String(jstDate.getDate()).padStart(2, '0');
    const dateString = `${year}-${month}-${day}`;

    if (holidayRes && holidayRes.success && holidayRes.holidays) {
      if (holidayRes.holidays[dateString]) {
        envStr += `\n- 今日特殊历法：日本法定节假日 - ${holidayRes.holidays[dateString]}`;
        hasData = true;
      }
    }

    const { getSchoolTermContext } = await import('../../services/kumikoStateMachine');
    const schoolTerm = getSchoolTermContext(dateString);
    if (schoolTerm) {
      envStr += `\n- 当前学校阶段：${schoolTerm}`;
      hasData = true;
    }
  } catch (e) {
    console.warn('[Environment] Failed to fetch holiday/term context:', e);
  }

  if (hasData) {
    cachedEnvironmentStr = envStr;
    lastEnvironmentFetchTime = now;
    return envStr;
  }
  
  return '';
};
