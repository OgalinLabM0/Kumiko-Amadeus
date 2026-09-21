import { validateBackupImportPayload as validateSharedBackupImportPayload } from '../../electron/backup-import-validation.mjs';

export interface BackupImportValidationResult {
  valid: boolean;
  reason?: string;
  payload?: Record<string, unknown>;
  hasEnvelope?: boolean;
}

// Keep the browser and Electron import paths on the exact same structural
// contract. The shared ESM module has no Node-only dependencies and is bundled
// into the renderer by Vite.
export const validateBackupImportPayload = (candidate: unknown): BackupImportValidationResult => (
  validateSharedBackupImportPayload(candidate) as BackupImportValidationResult
);
