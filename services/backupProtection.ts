import { isDesktopElectron } from './desktopBackupService';
import { encryptPortableBackup, decryptPortableBackup, isEncryptedBackup } from './portableBackupCrypto.mjs';
let sessionPassword: string | null = null;
const REQUIRED_KEY = 'kumiko_backup_protection_required_v1';
export function requiresSessionBackupPassword(): boolean {
  return !isDesktopElectron() && localStorage.getItem(REQUIRED_KEY) === '1' && sessionPassword === null;
}
export async function protectionStatus(): Promise<boolean> {
  if (!isDesktopElectron()) return sessionPassword !== null || localStorage.getItem(REQUIRED_KEY) === '1';
  const result = await window.electronAPI!.invoke('backup:protection-status');
  if (!result?.success) throw new Error(result?.error || 'Unable to inspect backup protection');
  return !!result.enabled;
}
export async function enableProtection(password: string): Promise<void> {
  if (password.length < 12 || password.length > 4096) throw new Error('Password must contain at least 12 characters');
  if (isDesktopElectron()) {
    const result = await window.electronAPI!.invoke('backup:protection-set', { password });
    if (!result?.success) throw new Error(result?.error || 'Unable to save protection');
  } else {
    // Remember the user's protection choice, never the password. A new session
    // must ask for it instead of silently producing an unencrypted backup.
    localStorage.setItem(REQUIRED_KEY, '1');
    sessionPassword = password;
  }
}
export function getSessionBackupPassword(): string | null { return sessionPassword; }
export function clearSessionBackupPassword(): void { sessionPassword = null; }
export async function protectSessionJson(content: string, handle: any): Promise<string> {
  const existing = await handle.getFile();
  const existingEncrypted = existing.size > 0 && isEncryptedBackup(await existing.slice(0, 16).text());
  if (!sessionPassword) {
    if (existingEncrypted || requiresSessionBackupPassword()) throw new Error('Enter the backup password before saving a protected file.');
    return content;
  }
  if (existing.size && !existingEncrypted) throw new Error('Choose a new protected file; the existing plaintext backup is preserved.');
  if (existingEncrypted) await decryptPortableBackup(await existing.text(), sessionPassword);
  return encryptPortableBackup(new TextEncoder().encode(content), sessionPassword, 'json');
}
export async function openSessionJson(content: string): Promise<string> {
  if (!isEncryptedBackup(content)) return content;
  if (!sessionPassword) throw new Error('Enter the backup password in settings for this session.');
  const decoded = await decryptPortableBackup(content, sessionPassword);
  if (decoded.kind !== 'json') throw new Error('Expected a JSON backup.');
  return new TextDecoder().decode(decoded.bytes);
}
