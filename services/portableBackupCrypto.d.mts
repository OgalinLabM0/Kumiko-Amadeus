export function isEncryptedBackup(input: unknown): boolean;
export function encryptPortableBackup(bytes: Uint8Array, password: string, kind: 'zip' | 'json'): Promise<string>;
export function decryptPortableBackup(input: string, password: string): Promise<{ kind: 'zip' | 'json'; bytes: Uint8Array }>;
