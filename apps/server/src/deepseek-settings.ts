import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppError, invalid } from './types.js';

export interface DeepSeekSettingsStatus { configured: boolean; updatedAt: string | null }
interface SavedSecret { version: 1; apiKey: string; updatedAt: string }

function apiKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.trim())) throw invalid('API Key 格式无效');
  return value.trim();
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid secret directory');
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

// This object remains inside the server. Only status() may cross the admin API.
export class DeepSeekSettings {
  private key: string | undefined;
  private updatedAt: string | null = null;
  private pending: Promise<void> = Promise.resolve();
  private constructor(private readonly path: string | undefined, fallback?: string) { this.key = fallback?.trim() ? apiKey(fallback) : undefined; }

  static environmentOnly(key?: string) { return new DeepSeekSettings(undefined, key); }

  static async open(path: string, fallback?: string) {
    try {
      // SMB/NFS mounts must also be excluded by deployment configuration.
      if (!path || path.startsWith('\\\\') || path.startsWith('//')) throw new Error('Local secret path required');
      const location = resolve(path);
      await privateDirectory(dirname(location));
      let secret: SavedSecret | undefined;
      try {
        const info = await lstat(location);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new Error('Invalid secret file');
        if (process.platform !== 'win32') await chmod(location, 0o600);
        const value = JSON.parse(await readFile(location, 'utf8')) as Partial<SavedSecret>;
        if (value?.version !== 1 || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Invalid secret data');
        secret = { version: 1, apiKey: apiKey(value.apiKey), updatedAt: value.updatedAt };
      } catch (error) { if (!missing(error)) throw error; }
      const settings = new DeepSeekSettings(location, secret ? undefined : fallback);
      if (secret) { settings.key = secret.apiKey; settings.updatedAt = secret.updatedAt; }
      return settings;
    } catch { throw new Error('Cannot load server secret configuration'); }
  }

  currentKey() { return this.key; }
  status(): DeepSeekSettingsStatus { return { configured: !!this.key, updatedAt: this.updatedAt }; }

  async update(value: unknown): Promise<DeepSeekSettingsStatus> {
    const key = apiKey(value);
    if (!this.path) throw new AppError(503, 'SECRET_STORAGE_NOT_CONFIGURED', '服务端密钥存储尚未配置');
    const path = this.path;
    // Serialize concurrent admin writes so disk and memory always agree.
    const operation = this.pending.then(async () => {
      const next: SavedSecret = { version: 1, apiKey: key, updatedAt: new Date().toISOString() };
      const temporary = `${path}.${randomUUID()}.tmp`;
      let committed = false;
      try {
        await privateDirectory(dirname(path));
        try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid secret file'); } catch (error) { if (!missing(error)) throw error; }
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next), 'utf8'); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path);
        // Rename is the commit point; there are no fallible operations before the
        // matching in-memory update. Already running gateway calls keep a snapshot.
        committed = true;
        this.key = next.apiKey; this.updatedAt = next.updatedAt;
        // POSIX directory fsync makes the rename durable. Some platforms/filesystems
        // do not support it; never report rollback after the rename has committed.
        if (process.platform !== 'win32') {
          try { const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } } catch { /* rename already committed */ }
        }
        return this.status();
      } catch { throw new AppError(503, 'SECRET_SAVE_FAILED', '密钥保存失败，现有配置保持不变'); }
      finally { if (!committed) await unlink(temporary).catch(() => {}); }
    });
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }
}
