// Diary settlement uses Tokyo calendar dates regardless of the device timezone.
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const getJSTDiaryDate = (timestamp: number): string | null => {
  const shifted = new Date(timestamp + JST_OFFSET_MS);
  return Number.isFinite(shifted.getTime()) ? shifted.toISOString().slice(0, 10) : null;
};

export const getNightlyDiaryDate = (timestamp: number): string | null => {
  const shifted = new Date(timestamp + JST_OFFSET_MS);
  const hour = shifted.getUTCHours();
  if (hour >= 23) return getJSTDiaryDate(timestamp);
  if (hour < 3) return getJSTDiaryDate(timestamp - DAY_MS);
  return null;
};

export const selectDiaryMessages = <T extends { timestamp: number }>(messages: T[], date: string): T[] => (
  messages.filter(message => getJSTDiaryDate(message.timestamp) === date)
);

// The ambient context describes today's holiday. Midnight settlement needs the
// calendar entry for the target date instead; a failed calendar read is unknown.
export const getDiaryHoliday = async (date: string): Promise<boolean | undefined> => {
  try {
    const { fetchJapanHolidaysDirect } = await import('./ambientWeatherDirect');
    const result = await fetchJapanHolidaysDirect();
    if (result?.success && result.holidays && typeof result.holidays === 'object') {
      return Boolean(result.holidays[date]);
    }
  } catch (error) {
    console.warn(`[LifeStream] Failed to read holiday calendar for ${date}:`, error);
  }
  return undefined;
};
