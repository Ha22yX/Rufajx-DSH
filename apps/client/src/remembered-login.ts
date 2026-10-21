import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EncryptionProvider } from './credential-store.js';

interface RememberedLogin { version: 1; serverUrl: string; username: string; password: string }
export interface RememberedLoginInfo { remembered: boolean; username: string }

/** Separate from login.enc so existing refresh-token credentials remain compatible. */
export class RememberedPasswordStore {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string, private readonly encryption: EncryptionProvider) {}
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation); this.#tail = result.catch(() => {}); return result;
  }
  private async read(): Promise<RememberedLogin | null> {
    await this.#tail;
    let data: Buffer;
    try { data = await readFile(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Unable to read remembered login'); }
    if (!this.encryption.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable');
    try {
      const value = JSON.parse(this.encryption.decryptString(data)) as RememberedLogin;
      if (value.version !== 1 || typeof value.serverUrl !== 'string' || !value.serverUrl ||
          typeof value.username !== 'string' || !value.username || typeof value.password !== 'string' || !value.password) throw new Error();
      return value;
    } catch { throw new Error('Remembered login cannot be decrypted'); }
  }
  async info(serverUrl: string): Promise<RememberedLoginInfo> {
    const value = await this.read();
    return value?.serverUrl === serverUrl ? { remembered: true, username: value.username } : { remembered: false, username: '' };
  }
  /** Main-process access only; the login IPC may reveal it briefly after an explicit eye-button request. */
  async passwordFor(serverUrl: string, username: string): Promise<string | null> {
    const value = await this.read();
    return value?.serverUrl === serverUrl && value.username === username ? value.password : null;
  }
  write(serverUrl: string, username: string, password: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.encryption.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable');
      if (!serverUrl || !username.trim() || !password) throw new Error('Incomplete remembered login');
      const encrypted = this.encryption.encryptString(JSON.stringify({ version: 1, serverUrl, username: username.trim(), password } satisfies RememberedLogin));
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.pending`, encrypted, { mode: 0o600 });
      await rename(`${this.path}.pending`, this.path);
    });
  }
  clear(): Promise<void> {
    return this.enqueue(async () => { await rm(this.path, { force: true }); await rm(`${this.path}.pending`, { force: true }); });
  }
}
