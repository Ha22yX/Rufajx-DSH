import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { StartupUpdateController, isNewerStableVersion, type StartupUpdateState } from './startup-update.js';
import { bootstrapSupports, matchesFile, MAX_MANIFEST_BYTES, parseRelease, safeLocalPath, updateUrl, verifyManifest,
  type ReleaseFile, type UpdateTrust } from './incremental-update-protocol.js';

interface Options {
  root: string; currentVersion: string; trust: UpdateTrust; canInstall: () => boolean;
  onHandoff: () => void; createFallback: () => StartupUpdateController;
  fetch?: typeof fetch; launch?: typeof launchIncrementalInstaller;
}
async function durableWrite(path: string, bytes: Buffer) {
  const temporary = path + '.' + randomUUID().replaceAll('-', '') + '.writing';
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}
async function* responseChunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try { while (true) { const item = await reader.read(); if (item.done) return; yield item.value; } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function launchIncrementalInstaller(root: string, signal: AbortSignal, canInstall: () => boolean): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(join(root, 'Rufajx-DSH.exe'), ['--apply-update', String(process.pid)],
      { detached: true, stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: false });
    let settled = false, received = '', acknowledged = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); }
      else { child.unref(); child.stdout!.destroy(); resolve(); }
    };
    const abort = () => finish(new Error('Update cancelled'));
    const timer = setTimeout(() => finish(new Error('Update window unavailable')), 20_000);
    child.once('error', () => finish(new Error('Update helper failed')));
    child.once('exit', () => finish(new Error('Update helper exited')));
    child.stdin!.on('error', () => finish(new Error('Update handshake failed')));
    child.stdout!.on('data', chunk => {
      received += chunk.toString();
      if (received.length > 128) { finish(new Error('Invalid update handshake')); return; }
      if (!acknowledged && received === 'RUFA_UPDATE_READY\n') {
        if (signal.aborted || !canInstall()) { finish(new Error('Update no longer allowed')); return; }
        acknowledged = true; child.stdin!.end('APPLY\n');
      }
      if (acknowledged && received === 'RUFA_UPDATE_READY\nRUFA_UPDATE_ACCEPTED\n') finish(signal.aborted || !canInstall() ? new Error('Update no longer allowed') : undefined);
    });
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Startup only. Downloads raw changed files; the independent native window
 * owns installation and rollback after the login gate safely hands off. */
export class IncrementalUpdateController extends EventEmitter {
  private value: StartupUpdateState;
  private closed = false; private started = false; private generation = 0;
  private abort?: AbortController; private fallback?: StartupUpdateController;
  private resolve!: (value: boolean) => void;
  private gate = new Promise<boolean>(resolve => { this.resolve = resolve; });
  constructor(private options: Options) {
    super(); this.value = { phase: 'checking', currentVersion: options.currentVersion, transferred: 0,
      total: 0, verified: 0, bytesPerSecond: 0, canRetry: false, canContinue: false };
  }
  get state() { return { ...this.value }; }
  get blocking() { return !this.closed; }
  start() { if (!this.started) { this.started = true; void this.attempt(); } return this.gate; }
  retry() { if (this.fallback) return this.fallback.retry(); if (!this.closed && this.value.phase === 'error') void this.attempt(); }
  continueCurrent() {
    if (this.fallback) return this.fallback.continueCurrent();
    if (!this.closed && this.value.phase === 'error') this.finish('skipped');
  }
  stop() { if (!this.closed) { this.closed = true; ++this.generation; this.abort?.abort(); this.fallback?.stop(); this.resolve(false); } }
  private publish(value: Partial<StartupUpdateState>) { this.value = { ...this.value, ...value }; this.emit('change', this.state); }
  private finish(phase: 'current' | 'skipped') {
    this.closed = true; ++this.generation; this.abort?.abort(); this.publish({ phase, canRetry: false, canContinue: false }); this.resolve(true);
  }
  private async response(relative: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const requestAbort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => requestAbort.abort(), 20_000);
      timer.unref?.();
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(updateUrl(relative), {
          signal: AbortSignal.any([signal, requestAbort.signal]), redirect: 'error', credentials: 'omit', cache: 'no-store',
        });
      } finally { clearTimeout(timer); }
      if (response.body) {
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            timer = setTimeout(() => requestAbort.abort(), 90_000); timer.unref?.();
            try { const item = await reader.read(); if (item.done) controller.close(); else controller.enqueue(item.value); }
            catch (error) { controller.error(error); }
            finally { clearTimeout(timer); }
          },
          async cancel() { clearTimeout(timer); requestAbort.abort(); await reader.cancel().catch(() => {}); },
        });
        response = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      if (response.ok && response.body) return response;
      if (attempt < 3 && response.status === 503 && response.body) {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of responseChunks(response.body)) { size += chunk.length; if (size > 16384) throw new Error('Invalid busy response'); chunks.push(Buffer.from(chunk)); }
        const error = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (error?.error?.code === 'CLIENT_RELEASE_BUSY') {
          const seconds = Number(response.headers.get('retry-after'));
          await delay(Number.isFinite(seconds) && seconds > 0 ? Math.min(10, seconds) * 1000 : 5000, undefined, { signal }); continue;
        }
      }
      throw new Error('Update unavailable');
    }
    throw new Error('Update unavailable');
  }
  private async document(relative: string, limit: number, signal: AbortSignal): Promise<Buffer> {
    const response = await this.response(relative, signal); let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of responseChunks(response.body!)) { signal.throwIfAborted(); size += chunk.length; if (size > limit) throw new Error('Update document too large'); chunks.push(Buffer.from(chunk)); }
    return Buffer.concat(chunks);
  }
  private async download(file: ReleaseFile, version: string, signal: AbortSignal, progress: (n: number) => void) {
    const path = await safeLocalPath(this.options.root, `.rufa-update/download/${file.sha256}`);
    if (await matchesFile(path, file, signal)) { progress(file.size); return; }
    const part = await safeLocalPath(this.options.root, `.rufa-update/download/${file.sha256}.${randomUUID().replaceAll('-', '')}.part`);
    const handle = await open(part, 'wx'); let received = 0;
    const sha256 = createHash('sha256'), sha512 = createHash('sha512');
    try {
      if (file.size > 0) {
        const response = await this.response(`releases/${version}/payloads/${file.sha256}`, signal);
        for await (const chunk of responseChunks(response.body!)) {
          signal.throwIfAborted(); received += chunk.length; if (received > file.size) throw new Error('Oversized payload');
          sha256.update(chunk); sha512.update(chunk); await handle.writeFile(chunk); progress(chunk.length);
        }
      }
      if (received !== file.size || sha256.digest('hex') !== file.sha256 || sha512.digest('base64') !== file.sha512) throw new Error('Payload mismatch');
      await handle.sync();
    } catch (error) { await handle.close(); await rm(part, { force: true }); throw error; }
    await handle.close(); signal.throwIfAborted(); await rename(part, path);
  }
  private async attempt() {
    this.abort?.abort(); const id = ++this.generation, abort = this.abort = new AbortController(), signal = abort.signal;
    const live = () => !this.closed && id === this.generation;
    this.publish({ phase: 'checking', targetVersion: undefined, transferred: 0, total: 0, verified: 0, bytesPerSecond: 0, canRetry: false, canContinue: false, message: undefined });
    try {
      const release = parseRelease(JSON.parse((await this.document('incremental/latest.json', 64 * 1024, signal)).toString('utf8')));
      if (!live()) return;
      if (!isNewerStableVersion(release.version, this.options.currentVersion)) { this.finish('current'); return; }
      const bytes = await this.document(release.manifest.url, MAX_MANIFEST_BYTES, signal);
      const manifest = verifyManifest(bytes, release, this.options.trust);
      if (!live()) return;
      if (!bootstrapSupports(release)) {
        const fallback = this.fallback = this.options.createFallback();
        fallback.on('change', state => { if (live()) this.publish(state); });
        if (await fallback.start() && live()) this.finish('skipped'); return;
      }
      this.publish({ phase: 'verifying', targetVersion: release.version, total: manifest.files.reduce((n, f) => n + f.size, 0) });
      const changed: ReleaseFile[] = []; let verified = 0, lastNotice = 0;
      for (const file of manifest.files) {
        signal.throwIfAborted();
        if (!await matchesFile(await safeLocalPath(this.options.root, file.path), file, signal)) changed.push(file);
        verified += file.size;
        if (Date.now() - lastNotice > 100) { lastNotice = Date.now(); if (live()) this.publish({ verified }); }
      }
      if (!live()) return;
      const unique = [...new Map(changed.map(file => [file.sha256, file])).values()];
      const total = unique.reduce((n, file) => n + file.size, 0); let transferred = 0;
      this.publish({ phase: 'downloading', total, transferred: 0, verified: 0 });
      const downloadRoot = join(this.options.root, '.rufa-update/download');
      // safeLocalPath checks both the root and .rufa-update before mkdir.
      await safeLocalPath(this.options.root, '.rufa-update/download/' + '0'.repeat(64)); await mkdir(downloadRoot, { recursive: true });
      const begin = Date.now();
      for (const file of unique) await this.download(file, manifest.version, signal, n => {
        transferred += n;
        if (live()) this.publish({ transferred, bytesPerSecond: transferred / Math.max(.1, (Date.now() - begin) / 1000) });
      });
      signal.throwIfAborted();
      await durableWrite(await safeLocalPath(this.options.root, '.rufa-update/pending-manifest.json'), bytes);
      await durableWrite(await safeLocalPath(this.options.root, '.rufa-update/pending.json'), Buffer.from(JSON.stringify(release)));
      if (!live()) return;
      if (!this.options.canInstall()) throw new Error('Login already started');
      this.publish({ phase: 'installing', transferred: total, verified: total, bytesPerSecond: 0 });
      if (!live() || !this.options.canInstall()) throw new Error('Login already started');
      await (this.options.launch ?? launchIncrementalInstaller)(this.options.root, signal, () => live() && this.options.canInstall());
      if (live()) this.options.onHandoff();
    } catch {
      if (live()) { abort.abort(); this.publish({ phase: 'error', bytesPerSecond: 0, canRetry: true, canContinue: true,
        message: '更新未完成，当前安装尚未改动。可以重试，或继续使用当前版本。' }); }
    }
  }
}
