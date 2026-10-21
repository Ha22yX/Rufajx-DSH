import { EventEmitter } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

export const COMPANY_UPDATE_FEED = 'https://dsh.example.com/api/v1/client-updates/windows/x64/';
export type UpdatePhase = 'checking' | 'downloading' | 'verifying' | 'installing' | 'error' | 'current' | 'skipped';
export interface StartupUpdateState {
  phase: UpdatePhase; currentVersion: string; targetVersion?: string;
  transferred: number; total: number; bytesPerSecond: number; verified: number;
  canRetry: boolean; canContinue: boolean; message?: string;
}
export interface UpdateArtifact { version: string; filename: string; sha512: string; size: number }
export interface UpdaterPort {
  check(signal: AbortSignal): Promise<unknown>;
  download(signal: AbortSignal, progress: (value: unknown) => void): Promise<string[]>;
  install(onError: () => void): void;
  dispose(): void;
}
interface StartupUpdateOptions {
  enabled: boolean; currentVersion: string;
  createUpdater: () => Promise<UpdaterPort> | UpdaterPort;
  canInstall: () => boolean;
  verify?: typeof verifyUpdateArtifact;
  checkTimeoutMs?: number; idleTimeoutMs?: number;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid update metadata');
  return value as Record<string, unknown>;
}
function stableParts(value: unknown): number[] | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value)) return null;
  return value.split('.').map(Number);
}
export function isNewerStableVersion(candidate: unknown, current: string): boolean {
  const next = stableParts(candidate), prior = stableParts(current);
  if (!next || !prior) return false;
  for (let i = 0; i < 3; i++) if (next[i] !== prior[i]) return next[i] > prior[i];
  return false;
}
export function allowedUpdateRequest(value: string): boolean {
  try {
    const url = new URL(value), base = new URL(COMPANY_UPDATE_FEED);
    if (url.origin !== base.origin || url.username || url.password || url.hash || !url.pathname.startsWith(base.pathname)) return false;
    const name = url.pathname.slice(base.pathname.length);
    if (name === 'latest.yml') return true;
    const match = /^releases\/(\d+\.\d+\.\d+)\/Rufa-DSH-([^/]+)-x64-Setup\.exe(?:\.blockmap)?$/.exec(name);
    return !!match && !!stableParts(match[1]) && match[1] === match[2];
  } catch { return false; }
}
export function readUpdateArtifact(input: unknown, current: string): UpdateArtifact | null {
  const info = record(input);
  if (typeof info.version !== 'string') throw new Error('Missing update version');
  // Only stable releases on the pinned Windows x64 channel can reach download.
  if (!stableParts(info.version)) {
    if (/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)?$/.test(info.version)) return null;
    throw new Error('Invalid stable version');
  }
  if (!isNewerStableVersion(info.version, current)) return null;
  if (info.packages !== undefined || !Array.isArray(info.files) || info.files.length !== 1) throw new Error('Unsupported installer');
  const file = record(info.files[0]), filename = `Rufa-DSH-${info.version}-x64-Setup.exe`;
  const relativeUrl = `releases/${info.version}/${filename}`;
  if (typeof file.url !== 'string' || file.url !== relativeUrl && file.url !== COMPANY_UPDATE_FEED + relativeUrl) throw new Error('Unexpected installer URL');
  if (typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
    || Buffer.from(file.sha512, 'base64').length !== 64 || Buffer.from(file.sha512, 'base64').toString('base64') !== file.sha512) throw new Error('Missing SHA512');
  if (!Number.isSafeInteger(file.size) || Number(file.size) < 1) throw new Error('Missing installer size');
  if (info.path !== undefined && info.path !== relativeUrl && info.path !== COMPANY_UPDATE_FEED + relativeUrl) throw new Error('Conflicting legacy path');
  if (info.sha512 !== undefined && info.sha512 !== file.sha512) throw new Error('Conflicting legacy checksum');
  return { version: info.version, filename, sha512: file.sha512, size: Number(file.size) };
}
export async function verifyUpdateArtifact(path: string, artifact: UpdateArtifact, signal: AbortSignal,
  progress: (bytes: number) => void = () => {}): Promise<void> {
  signal.throwIfAborted();
  if (!isAbsolute(path) || basename(path) !== artifact.filename) throw new Error('Unexpected downloaded file');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== artifact.size) throw new Error('Invalid installer size or type');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw new Error('Installer changed');
    const hash = createHash('sha512'); let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      signal.throwIfAborted(); hash.update(chunk); bytes += chunk.length; progress(bytes);
    }
    signal.throwIfAborted();
    const after = await lstat(path), final = await handle.stat();
    if (!after.isFile() || after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs
      || bytes !== artifact.size || !timingSafeEqual(hash.digest(), Buffer.from(artifact.sha512, 'base64'))) throw new Error('Installer verification failed');
  } finally { await handle.close(); }
}

/** A one-shot startup gate. No updater can install after the gate admits login. */
export class StartupUpdateController extends EventEmitter {
  private value: StartupUpdateState;
  private started = false;
  private closed = false;
  private generation = 0;
  private abort?: AbortController;
  private port?: UpdaterPort;
  private timer?: ReturnType<typeof setTimeout>;
  private resolve!: (proceed: boolean) => void;
  private readonly gate = new Promise<boolean>(resolve => { this.resolve = resolve; });
  constructor(private readonly options: StartupUpdateOptions) {
    super();
    this.value = { phase: options.enabled ? 'checking' : 'skipped', currentVersion: options.currentVersion,
      transferred: 0, total: 0, bytesPerSecond: 0, verified: 0, canRetry: false, canContinue: false };
  }
  get state(): StartupUpdateState { return { ...this.value }; }
  get blocking(): boolean { return !this.closed; }
  start(): Promise<boolean> {
    if (this.started) return this.gate;
    this.started = true;
    if (!this.options.enabled) this.finish('skipped');
    else if (!stableParts(this.options.currentVersion)) this.fail('当前客户端版本信息异常，请联系管理员。');
    else void this.attempt();
    return this.gate;
  }
  retry(): void {
    if (this.closed || this.value.phase !== 'error') return;
    void this.attempt();
  }
  continueCurrent(): void {
    if (!this.closed && this.value.phase === 'error') this.finish('skipped');
  }
  stop(): void {
    if (this.closed) return;
    this.closed = true; this.cancel(); this.resolve(false);
  }
  private publish(change: Partial<StartupUpdateState>) { this.value = { ...this.value, ...change }; this.emit('change', this.state); }
  private live(id: number) { return !this.closed && id === this.generation; }
  private cancel() {
    ++this.generation; clearTimeout(this.timer); this.abort?.abort(); this.port?.dispose(); this.port = undefined;
  }
  private finish(phase: 'current' | 'skipped') {
    this.closed = true; this.cancel(); this.publish({ phase, canRetry: false, canContinue: false, message: undefined }); this.resolve(true);
  }
  private fail(message = '更新未完成。请检查网络后重试，或继续使用当前版本。') {
    if (this.closed) return;
    this.cancel(); this.publish({ phase: 'error', canRetry: true, canContinue: true, bytesPerSecond: 0, message });
  }
  private arm(id: number, milliseconds: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.live(id)) this.fail('更新连接暂时没有响应。可以重试，或继续使用当前版本。'); }, milliseconds);
    this.timer.unref?.();
  }
  private async attempt() {
    this.cancel(); const id = this.generation, abort = this.abort = new AbortController();
    this.publish({ phase: 'checking', targetVersion: undefined, transferred: 0, total: 0, verified: 0,
      bytesPerSecond: 0, canRetry: false, canContinue: false, message: undefined });
    this.arm(id, this.options.checkTimeoutMs ?? 20_000);
    try {
      const port = await this.options.createUpdater();
      if (!this.live(id)) { port.dispose(); return; }
      this.port = port;
      const metadata = await port.check(abort.signal);
      if (!this.live(id)) return;
      const artifact = readUpdateArtifact(metadata, this.options.currentVersion);
      if (!artifact) { this.finish('current'); return; }
      this.publish({ phase: 'downloading', targetVersion: artifact.version, total: artifact.size });
      this.arm(id, this.options.idleTimeoutMs ?? 90_000);
      const files = await port.download(abort.signal, input => {
        if (!this.live(id) || this.value.phase !== 'downloading') return;
        if (!input || typeof input !== 'object' || Array.isArray(input)) return;
        const data = input as Record<string, unknown>, transferred = Number(data.transferred), speed = Number(data.bytesPerSecond);
        if (!Number.isFinite(transferred) || transferred < 0) return;
        const bytes = Math.min(artifact.size, Math.floor(transferred));
        if (bytes > this.value.transferred) this.arm(id, this.options.idleTimeoutMs ?? 90_000);
        this.publish({ transferred: Math.max(this.value.transferred, bytes), bytesPerSecond: Number.isFinite(speed) && speed > 0 ? speed : 0 });
      });
      if (!this.live(id)) return;
      if (!Array.isArray(files) || files.length !== 1 || typeof files[0] !== 'string') throw new Error('Unexpected download result');
      this.publish({ phase: 'verifying', transferred: artifact.size, bytesPerSecond: 0 });
      this.arm(id, this.options.idleTimeoutMs ?? 90_000);
      let lastVerificationNotice = 0;
      await (this.options.verify ?? verifyUpdateArtifact)(files[0], artifact, abort.signal, bytes => {
        if (!this.live(id)) return;
        const now = Date.now();
        if (bytes !== artifact.size && now - lastVerificationNotice < 100) return;
        lastVerificationNotice = now;
        if (bytes > this.value.verified) this.arm(id, this.options.idleTimeoutMs ?? 90_000);
        this.publish({ verified: Math.min(artifact.size, bytes) });
      });
      if (!this.live(id)) return;
      clearTimeout(this.timer);
      if (!this.options.canInstall()) { this.fail('当前已进入工作状态，本次不会安装。请继续使用当前版本，下次启动时重试。'); return; }
      this.publish({ phase: 'installing', verified: artifact.size });
      // publish is synchronous; a reentrant close/continue must still prevent install.
      if (!this.live(id)) return;
      if (!this.options.canInstall()) { this.fail('当前已进入工作状态，本次不会安装。请继续使用当前版本，下次启动时重试。'); return; }
      port.install(() => { if (this.live(id)) this.fail('无法启动更新安装。请重试，或继续使用当前版本。'); });
      // Keep the startup gate closed to login until the installer quits this process.
    } catch {
      if (this.live(id)) this.fail(this.value.phase === 'verifying'
        ? '更新文件校验未通过，已阻止安装。请重试下载，或继续使用当前版本。' : undefined);
    }
  }
}
