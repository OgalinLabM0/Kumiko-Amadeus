// Backup IPC surface. Extracted from electron-main.cjs (Plan 9 SubPhase 3.2);
// extended in Plan 14 Phase B with `backup:build-zip-from-payload` that unifies
// manual / auto-zip paths behind backup-zip-builder.cjs.
//
// Owns the 7 `backup:*` IPC handlers that combine native file dialogs with
// the pure-IO helpers from ./backup-files.cjs:
//
//   - `backup:pick-save-file` / `backup:pick-open-file` drive native save/open
//     dialogs and authorize the chosen path for subsequent read/write via
//     `authorized-paths.authorizeBackupPath`.
//   - `backup:write-file` / `backup:read-file` / `backup:get-file-info`
//     delegate to backup-files helpers.
//   - `backup:parse-import-file` previews an import candidate without
//     loading it into the renderer.
//   - `backup:build-zip-from-payload` is the new manual-export entry point:
//     renderer hands over a serialized `data.json` string, main drives the
//     save dialog + shared zip builder + fs write. Replaces the renderer-
//     side JSZip path that used to live in backupActions.handleExportBackup.
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
const { buildBackupZip } = require('./backup-zip-builder.cjs');

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

function getDefaultBackupZipPath(defaultFileName) {
  const normalizedFileName = defaultFileName && typeof defaultFileName === 'string'
    ? defaultFileName
    : `kumiko_backup_${new Date().toISOString().slice(0, 10)}.zip`;
  return path.join(app.getPath('documents'), normalizedFileName);
}

// Plan 14 Phase B: manual backup export path. Renderer passes the
// already-serialized `data.json` string (renderer has the Zustand store +
// Dexie vectors / episodes / diary / psyche etc. — main process has no
// visibility into those tables). We drive the native save dialog here and
// hand the chosen path + payload to the shared zip builder, which attaches
// userData/images + voice + ringtone and writes the zip.
//
// Behaviour vs. the pre-Plan-14 renderer JSZip path:
//   - Uses the native save dialog (matches backup:pick-save-file's UX)
//     instead of the file-saver library's download-prompt semantics. This
//     is a user-visible improvement: they now get to pick location + file
//     name, and the approved path is authorized for future writes (same
//     allowlist as the JSON backup path).
//   - Images come from userData/images (filesystem source of truth, same
//     as auto-zip), not from the renderer's Dexie ImageEntity rows. For
//     any user whose imageService stayed consistent (every shipped version
//     to date) these are identical; on a corrupted install the fs version
//     is closer to what kumiko-image:// will actually resolve post-restore.
async function handleBuildZipFromPayload(_event, payload = {}) {
  const { dataJsonString, defaultFileName } = payload || {};
  if (typeof dataJsonString !== 'string' || dataJsonString.length === 0) {
    return {
      success: false,
      error: 'dataJsonString is required and must be a non-empty string',
    };
  }

  let outputPath;
  try {
    const result = await dialog.showSaveDialog(dialogParent || undefined, {
      title: '导出备份 ZIP',
      defaultPath: getDefaultBackupZipPath(defaultFileName),
      filters: [{ name: 'Kumiko Backup ZIP', extensions: ['zip'] }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    outputPath = path.resolve(result.filePath);
    // User just approved this path via the native dialog — authorize it for
    // the lifetime of this session (parity with backup:pick-save-file; the
    // zip path won't be re-read for write via backup:write-file anyway, but
    // we keep authorization consistent across all native-picked paths).
    authorizeBackupPath(outputPath);
  } catch (error) {
    console.error('[LOCAL BACKUP] Save dialog failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const buildResult = await buildBackupZip({
      dataJsonString,
      mode: 'manual',
      outputPath,
    });
    if (buildResult.success) {
      return {
        success: true,
        outputPath,
        fileName: path.basename(outputPath),
        bytesWritten: buildResult.bytesWritten,
        imagesIncluded: buildResult.imagesIncluded,
        imagesTotal: buildResult.imagesTotal,
      };
    }
    return {
      success: false,
      outputPath,
      error: buildResult.error || 'Unknown builder failure',
    };
  } catch (error) {
    console.error('[LOCAL BACKUP] Manual zip build failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
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
  handleBuildZipFromPayload,
};
