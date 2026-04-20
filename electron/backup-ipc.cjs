// Backup IPC surface. Extracted from electron-main.cjs (Plan 9 SubPhase 3.2).
//
// Owns the 6 `backup:*` IPC handlers that combine native file dialogs with
// the pure-IO helpers from ./backup-files.cjs:
//
//   - `backup:pick-save-file` / `backup:pick-open-file` drive native save/open
//     dialogs and authorize the chosen path for subsequent read/write via
//     `authorized-paths.authorizeBackupPath`.
//   - `backup:write-file` / `backup:read-file` / `backup:get-file-info`
//     delegate to backup-files helpers.
//   - `backup:parse-import-file` previews an import candidate without
//     loading it into the renderer.
//
// The module also owns the `lastWrittenBackupPath` state so that the
// auto-zip-backup before-quit flow can locate the most recent JSON backup
// it should roll media into.

const path = require('path');
const { app, dialog } = require('electron');
const { authorizeBackupPath } = require('./authorized-paths.cjs');
const {
  writeBackupFile,
  readBackupFile,
  getBackupFileInfo,
  parseBackupImportFile,
  getDefaultBackupFilePath,
} = require('./backup-files.cjs');

// Native dialog parent window. Injected via setBackupDialogParent(mainWindow)
// from electron-main.cjs once BrowserWindow is ready. Dialogs fall back to
// `undefined` if the window hasn't been wired yet, matching the pre-refactor
// behaviour where electron-main passed `mainWindow || undefined`.
let dialogParent = null;

// Path of the most recently successful `backup:write-file` call. Consumed by
// auto-zip-backup.cjs to decide which JSON backup to roll media into at
// quit-time (Plan 9 SubPhase 3.3).
let lastWrittenBackupPath = null;

function setBackupDialogParent(win) {
  dialogParent = win || null;
}

function getLastWrittenBackupPath() {
  return lastWrittenBackupPath;
}

async function handlePickSaveFile(_event, payload = {}) {
  try {
    const result = await dialog.showSaveDialog(dialogParent || undefined, {
      title: '选择本地同步文件',
      defaultPath: getDefaultBackupFilePath(payload.defaultFileName),
      filters: [
        { name: 'JSON Backup File', extensions: ['json'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const filePath = path.resolve(result.filePath);
    // The user just approved this path via the native dialog — authorize it for
    // subsequent write/read/parse IPC calls (persisted across restarts).
    authorizeBackupPath(filePath);
    return {
      success: true,
      canceled: false,
      filePath,
      fileName: path.basename(filePath)
    };
  } catch (error) {
    console.error('[LOCAL BACKUP] Failed to select save file:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function handlePickOpenFile() {
  try {
    const result = await dialog.showOpenDialog(dialogParent || undefined, {
      title: '选择本地同步文件',
      properties: ['openFile'],
      filters: [
        { name: 'JSON Backup File', extensions: ['json'] }
      ],
      defaultPath: app.getPath('documents')
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const pickedPath = path.resolve(result.filePaths[0]);
    authorizeBackupPath(pickedPath);
    return readBackupFile(pickedPath);
  } catch (error) {
    console.error('[LOCAL BACKUP] Failed to open backup file:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function handleWriteFile(_event, payload = {}) {
  try {
    if (payload.filePath) lastWrittenBackupPath = payload.filePath;
    return writeBackupFile(payload.filePath, payload.content);
  } catch (error) {
    console.error('[LOCAL BACKUP] Failed to write backup file:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function handleReadFile(_event, payload = {}) {
  try {
    return readBackupFile(payload.filePath);
  } catch (error) {
    console.error('[LOCAL BACKUP] Failed to read backup file:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function handleGetFileInfo(_event, payload = {}) {
  try {
    return getBackupFileInfo(payload.filePath);
  } catch (error) {
    console.error('[LOCAL BACKUP] Failed to inspect backup file:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function handleParseImportFile(_event, payload = {}) {
  try {
    return await parseBackupImportFile(payload.filePath);
  } catch (error) {
    console.error('[LOCAL BACKUP] Failed to parse backup import file:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

module.exports = {
  setBackupDialogParent,
  getLastWrittenBackupPath,
  handlePickSaveFile,
  handlePickOpenFile,
  handleWriteFile,
  handleReadFile,
  handleGetFileInfo,
  handleParseImportFile,
};
