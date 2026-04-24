// services/capacitorBackupNative.ts
//
// A4.1-2: native-side backup save / share for the Android Capacitor APK.
// Mirrors what `electron/backup-files.cjs` + the user's "Save As" picker
// achieve on PC, but using @capacitor/filesystem + @capacitor/share so
// the APK doesn't need a desktop companion to land a backup zip on the
// user's device storage.
//
// Why two plugins?
//   - @capacitor/filesystem writes the zip bytes to a known path under
//     `Directory.Cache` (not Documents — see comment below) and returns
//     a content:// URI that Android can hand to other apps.
//   - @capacitor/share opens the system share sheet so the user can pick
//     "Save to Files" (Android 11+ MANAGE_EXTERNAL_STORAGE-free path),
//     "Send via email", "Upload to Drive", etc. without us having to
//     request WRITE_EXTERNAL_STORAGE / MANAGE_EXTERNAL_STORAGE.
//
// Why Cache and not Documents?
//   - Capacitor Filesystem's `Directory.Documents` on Android 11+ lands
//     inside the app-private `Android/data/<package>/files/Documents/`
//     which is invisible to other apps via the share sheet. The user
//     CAN'T grab the file from there with a file manager either (scoped
//     storage). We want the zip to be *handoff* material, not internal
//     state.
//   - `Directory.Cache` is also app-private but the file URI we get
//     back is wrapped in our FileProvider (declared in AndroidManifest
//     by the Capacitor template) which makes the share intent give
//     other apps temporary read access via FLAG_GRANT_READ_URI_PERMISSION.
//     This is the standard Android idiom for "let me hand a file to
//     another app without granting global storage permission".
//
// Cache TTL:
//   - Android may evict Cache files when free space is low. That's
//     fine — by the time the user wants the file, the share sheet has
//     already opened the URI and other apps can copy it. A subsequent
//     re-export simply regenerates the file on demand.
//
// Import flow uses the standard HTML `<input type="file">` element,
// which Capacitor's Android WebView wires to Android's Storage Access
// Framework picker out of the box. Returns a File object whose .text() /
// .arrayBuffer() the existing `parseBackupImportFile` web fallback in
// backupActions.ts already handles. So no per-platform import wrapper
// is needed here — just the export side.

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export interface ExportNativeResult {
  ok: boolean;
  /** True if user explicitly tapped Cancel on the share sheet. */
  canceled?: boolean;
  /** Activity / app that consumed the share, when reported by the OS. */
  activityType?: string;
  /** Capacitor-resolved file URI (file:// or content://) used for sharing. */
  uri?: string;
  error?: string;
}

// Convert a Blob to base64 for Filesystem.writeFile (Capacitor 7's
// Filesystem only accepts string + Encoding, not raw bytes — base64 is
// the universal payload). Chunked through String.fromCharCode to avoid
// the V8 ~100k-arg call-stack ceiling on large backups (Kumiko backups
// can run 50-300 MB once voice clips accumulate).
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK_SIZE = 0x8000; // 32 KiB
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Write the backup zip bytes to a Capacitor cache file and open the
 * Android share sheet so the user can pick where to land it. Returns
 * the resolved native URI on success so callers can surface it in a
 * "saved here" toast.
 *
 * Idempotent: re-exporting overwrites the cache file (recursive: false
 * + same path), no per-export-id collision.
 *
 * Failure modes:
 *  - Filesystem write fails (out of space, sandbox revoked) → `ok: false`
 *    with a human-friendly error. Caller should fall back to file-saver
 *    (`saveAs`) which still works inside the WebView via blob URL +
 *    synthesized `<a download>`.
 *  - Share sheet dismissed without selecting a target → `ok: true,
 *    canceled: true`. Treat as success — the file is still on disk and
 *    a future Files app browse picks it up; we just don't toast a
 *    location.
 */
export async function exportBackupZipNative(
  blob: Blob,
  fileName: string,
): Promise<ExportNativeResult> {
  try {
    const base64Data = await blobToBase64(blob);
    // Capacitor 7's Filesystem.writeFile auto-creates parent dirs only
    // when `recursive: true`. We write straight into the directory root
    // so no recursive create is needed; the leaf file is replaced on
    // each re-export.
    const writeResult = await Filesystem.writeFile({
      path: fileName,
      data: base64Data,
      directory: Directory.Cache,
      // Encoding omitted → bytes path (raw base64 → file). Specifying
      // Encoding.UTF8 here would re-encode our base64 ASCII as UTF-8
      // (no-op) but we leave it off to keep the intent explicit.
    });
    const uri = writeResult.uri || '';

    // Android Share API needs an absolute file:// URI; Capacitor wraps
    // Cache writes with one. iOS uses the same path. If the URI is empty
    // (very old Capacitor or a sandbox quirk) we still try to share the
    // file by name — the user gets a "file not found" toast from the
    // share target, which is actionable.
    const shareResult = await Share.share({
      title: 'Kumiko·Amadeus 数据备份',
      text: '请选择保存位置或发送目标。',
      url: uri,
      dialogTitle: 'Save backup',
    }).catch((shareErr: unknown) => {
      // Capacitor's Share.share rejects with a CapacitorException when
      // the user cancels the sheet on Android. Treat that as success
      // (file is still on disk).
      const message = (shareErr as { message?: string })?.message || '';
      if (/cancel/i.test(message)) {
        return { activityType: 'canceled' as string | undefined };
      }
      throw shareErr;
    });

    if (shareResult && (shareResult as { activityType?: string }).activityType === 'canceled') {
      return { ok: true, canceled: true, uri };
    }
    return {
      ok: true,
      uri,
      activityType: (shareResult as { activityType?: string })?.activityType,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('[capacitorBackupNative] export failed:', e);
    return { ok: false, error: message };
  }
}
