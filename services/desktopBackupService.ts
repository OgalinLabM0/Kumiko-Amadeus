export interface DesktopBackupResult {
  success?: boolean;
  canceled?: boolean;
  exists?: boolean;
  filePath?: string;
  fileName?: string;
  content?: string;
  error?: string;
}

export const isDesktopElectron = () => typeof window !== 'undefined' && 'electronAPI' in window;

export interface DesktopParsedBackupImage {
  id: string;
  dataUrl: string;
}

export interface DesktopParsedBackupResult extends DesktopBackupResult {
  json?: any;
  images?: DesktopParsedBackupImage[];
  imageCount?: number;
}

export const pickDesktopBackupSaveFile = async (defaultFileName?: string): Promise<DesktopBackupResult> => {
  if (!isDesktopElectron()) {
    return { success: false, error: 'Desktop environment is required.' };
  }

  if (typeof window === 'undefined' || !window.electronAPI) {
    return { success: false, error: 'Desktop IPC is unavailable.' };
  }

  return window.electronAPI.invoke('backup:pick-save-file', { defaultFileName });
};

export const pickDesktopBackupOpenFile = async (): Promise<DesktopBackupResult> => {
  if (!isDesktopElectron()) {
    return { success: false, error: 'Desktop environment is required.' };
  }

  if (typeof window === 'undefined' || !window.electronAPI) {
    return { success: false, error: 'Desktop IPC is unavailable.' };
  }

  return window.electronAPI.invoke('backup:pick-open-file');
};

export const writeDesktopBackupFile = async (filePath: string, content: string): Promise<DesktopBackupResult> => {
  if (!isDesktopElectron()) {
    return { success: false, error: 'Desktop environment is required.' };
  }

  if (typeof window === 'undefined' || !window.electronAPI) {
    return { success: false, error: 'Desktop IPC is unavailable.' };
  }

  return window.electronAPI.invoke('backup:write-file', { filePath, content });
};

export const readDesktopBackupFile = async (filePath: string): Promise<DesktopBackupResult> => {
  if (!isDesktopElectron()) {
    return { success: false, error: 'Desktop environment is required.' };
  }

  if (typeof window === 'undefined' || !window.electronAPI) {
    return { success: false, error: 'Desktop IPC is unavailable.' };
  }

  return window.electronAPI.invoke('backup:read-file', { filePath });
};

export const getDesktopBackupFileInfo = async (filePath: string): Promise<DesktopBackupResult> => {
  if (!isDesktopElectron()) {
    return { success: false, error: 'Desktop environment is required.' };
  }

  if (typeof window === 'undefined' || !window.electronAPI) {
    return { success: false, error: 'Desktop IPC is unavailable.' };
  }

  return window.electronAPI.invoke('backup:get-file-info', { filePath });
};

export const parseDesktopBackupImportFile = async (filePath: string): Promise<DesktopParsedBackupResult> => {
  if (!isDesktopElectron()) {
    return { success: false, error: 'Desktop environment is required.' };
  }

  if (typeof window === 'undefined' || !window.electronAPI) {
    return { success: false, error: 'Desktop IPC is unavailable.' };
  }

  return window.electronAPI.invoke('backup:parse-import-file', { filePath });
};

export interface DesktopBuildZipResult extends DesktopBackupResult {
  outputPath?: string;
  bytesWritten?: number;
  imagesIncluded?: number;
  imagesTotal?: number;
}

// Plan 14 Phase B: hand a serialized backup JSON to the main process, which
// drives the native save dialog + shared zip builder (userData/images/voice/
// ringtone snapshot) and writes the zip. Returns { canceled: true } if the
// user dismissed the dialog; { success: true, outputPath, ... } on write.
export const buildDesktopBackupZip = async (
  dataJsonString: string,
  defaultFileName?: string,
): Promise<DesktopBuildZipResult> => {
  if (!isDesktopElectron()) {
    return { success: false, error: 'Desktop environment is required.' };
  }

  if (typeof window === 'undefined' || !window.electronAPI) {
    return { success: false, error: 'Desktop IPC is unavailable.' };
  }

  return window.electronAPI.invoke('backup:build-zip-from-payload', {
    dataJsonString,
    defaultFileName,
  });
};

export const setDesktopBackgroundThrottling = async (allowed: boolean): Promise<DesktopBackupResult> => {
  if (!isDesktopElectron()) {
    return { success: false, error: 'Desktop environment is required.' };
  }

  if (typeof window === 'undefined' || !window.electronAPI) {
    return { success: false, error: 'Desktop IPC is unavailable.' };
  }

  return window.electronAPI.invoke('app:set-background-throttling', { allowed });
};

export const refocusDesktopWebContents = async (): Promise<void> => {
  if (!isDesktopElectron()) {
    return;
  }

  if (typeof window === 'undefined' || !window.electronAPI) {
    return;
  }

  window.electronAPI.invoke('app:refocus-webcontents').catch(error => {
    console.warn('[IPC] Failed to refocus web contents:', error);
  });
};
