import { LocationConfig } from '../types';
import type { TtsConfig } from '../types';

export const AMADEUS_LOGO_COLOR = "#b8860b"; 
// ... (Location Config, System Instructions etc. unchanged) ...
export const DEFAULT_LOCATION_CONFIG: LocationConfig = {
  modelCountry: "Japan", 
  modelTimezone: "Asia/Tokyo",
  userCountry: "Japan",
  userTimezone: "Asia/Tokyo"
};

export const DEFAULT_TTS_CONFIG: TtsConfig = {
    ttsBackend: 'fish',
    voiceMode: 'text',
    fishAudioApiKey: '',
    fishAudioReferenceId: '05ad2ce7133042c282cbb8ed26951352',
    fishAudioModel: 's2-pro',
    format: 'mp3',
    latency: 'balanced',
    speed: 1.0,
    ringtoneFileId: '01.mp3',
    sovitsPort: 9880,
    sovitsTopK: 15,
    sovitsTopP: 1,
    sovitsTemperature: 1,
    sovitsTextSplitMethod: 'cut0',
    sovitsFragmentInterval: 0.3,
};
