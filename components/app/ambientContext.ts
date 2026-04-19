import { isDesktopElectron } from '../../services/desktopBackupService';

// Environment cache to avoid spamming the main process
let cachedEnvironmentStr: string | null = null;
let lastEnvironmentFetchTime = 0;

export const getAmbientEnvironmentContext = async (): Promise<string> => {
  if (!isDesktopElectron() || !window.electronAPI) return '';
  
  const now = Date.now();
  if (cachedEnvironmentStr && (now - lastEnvironmentFetchTime < 30 * 60 * 1000)) {
    return cachedEnvironmentStr;
  }

  let envStr = `\n[SYSTEM_ENVIRONMENT_DATA]`;
  let hasData = false;

  try {
    const res = await window.electronAPI.invoke('app:get-weather');
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
    const holidayRes = await window.electronAPI.invoke('app:get-japan-holidays');
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
