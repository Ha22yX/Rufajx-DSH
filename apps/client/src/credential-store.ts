import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CredentialStore, SavedLogin } from './types.js';

export interface EncryptionProvider { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export class EncryptedCredentialStore implements CredentialStore {
  constructor(private readonly path: string, private readonly encryption: EncryptionProvider) {}
  async read(): Promise<SavedLogin | null> {
    let data: Buffer;
    try { data = await readFile(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!this.encryption.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable');
    const saved = JSON.parse(this.encryption.decryptString(data));
    if (typeof saved.serverUrl !== 'string' || typeof saved.refreshToken !== 'string') throw new Error('Invalid encrypted login');
    return saved;
  }
  async write(value: SavedLogin): Promise<void> {
    if (!this.encryption.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable');
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.pending`;
    await writeFile(temporary, this.encryption.encryptString(JSON.stringify(value)), { mode: 0o600 });
    await rename(temporary, this.path);
  }
  async clear(): Promise<void> { await rm(this.path, { force: true }); await rm(`${this.path}.pending`, { force: true }); }
}
