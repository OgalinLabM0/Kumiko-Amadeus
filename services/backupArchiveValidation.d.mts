export function validateBackupArchive(zip: unknown): void;
export function createBackupArchiveReader(zip: unknown, options?: { entryLimit?: number; totalLimit?: number }): {
  read(entry: unknown, type?: 'string' | 'base64'): Promise<string>;
};
