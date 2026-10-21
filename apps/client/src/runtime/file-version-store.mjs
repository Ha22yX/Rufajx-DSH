import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, realpath, mkdir, open, link, unlink, rename, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, dirname, basename, parse, sep, toNamespacedPath } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const key = path => process.platform === 'win32' ? path.toLowerCase() : path;
const within = (root, path) => { const rest = relative(key(root), key(path)); return !rest || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)); };
const phases = new Set(['before', 'after', 'before-restore', 'restored']);
const locks = new Map();
function failure(code, message, cause) { const error = new Error(message, cause ? { cause } : undefined); error.code = code; return error; }
function text(value, label, limit = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw failure('INVALID_ARGUMENT', `${label}无效。`);
  return value;
}
function absolute(value) {
  text(value, '文件路径', 32768);
  if (!isAbsolute(value) || /^(?:\\\\[?.]\\|\\\?\?\\)/.test(value)) throw failure('UNSAFE_PATH', '不支持此文件路径。');
  const path = resolve(value), rest = path.slice(parse(path).root.length);
  for (const part of rest.split(/[\\/]/)) {
    if (!part || part === '.' || part === '..' || part.includes(':') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      || (process.platform === 'win32' && /[. ]$/.test(part))) throw failure('UNSAFE_PATH', '不支持设备、数据流或不明确的文件路径。');
  }
  return path;
}
const identity = stat => `${stat.dev}:${stat.ino}`;
const freshness = stat => `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}:${stat.nlink}`;
async function probe(path) { try { return await lstat(path, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

// Reject links in EVERY path component, not only the final entry. A file that
// does not yet exist is distinct from an empty file; missing parents are never
// created by restoration. Repeated checks narrow, but cannot abolish, races
// with programs outside this process (including other machines on an SMB share).
async function inspect(path, { allowAbsent = false, directory = false } = {}) {
  path = absolute(path);
  const root = parse(path).root, parts = path.slice(root.length).split(sep).filter(Boolean);
  const parents = [];
  let cursor = root, info = await probe(root), absent = false;
  if (!info?.isDirectory() || info.isSymbolicLink()) throw failure('UNSAFE_PATH', '文件所在位置不可用。');
  parents.push([key(root), identity(info)]);
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]);
    info = absent ? null : await probe(cursor);
    if (!info) { absent = true; continue; }
    if (info.isSymbolicLink()) throw failure('UNSAFE_PATH', '文件路径包含链接或已被重定向。');
    if (index < parts.length - 1 || directory) {
      if (!info.isDirectory()) throw failure('UNSAFE_PATH', '文件所在位置不是普通文件夹。');
      parents.push([key(cursor), identity(info)]);
    } else if (!info.isFile() || info.nlink > 1n) throw failure('UNSAFE_PATH', '只支持没有硬链接的普通文件。');
  }
  if (absent) {
    if (!allowAbsent) throw failure('FILE_UNAVAILABLE', '文件或文件夹已不存在。');
    return { path, info: null, parents };
  }
  if (key(await realpath(path)) !== key(path)) throw failure('UNSAFE_PATH', '文件路径已被重定向。');
  return { path, info, parents };
}
async function exclusive(path, operation) {
  const previous = locks.get(key(path)) ?? Promise.resolve();
  const next = previous.then(operation, operation), tail = next.catch(() => {});
  locks.set(key(path), tail);
  try { return await next; } finally { if (locks.get(key(path)) === tail) locks.delete(key(path)); }
}
async function readBounded(handle, maximum) {
  const chunks = []; let size = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, maximum - size + 1));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (!bytesRead) return Buffer.concat(chunks, size);
    size += bytesRead;
    if (size > maximum) throw failure('FILE_TOO_LARGE', '文件超过版本保护的大小上限，尚未完成备份。');
    chunks.push(chunk.subarray(0, bytesRead));
  }
}

async function publicationGuard(guard, signal) {
  signal?.throwIfAborted();
  if (!guard) return;
  if (!signal) return guard();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { await Promise.race([Promise.resolve().then(guard), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

let win32Promise;
async function windowsPublisher() {
  if (!win32Promise) win32Promise = (async () => {
    if (!process.env.RUFA_RUNTIME_ROOT) throw failure('RESTORE_UNAVAILABLE', '文件恢复组件尚未就绪。');
    const requireRuntime = createRequire(join(process.env.RUFA_RUNTIME_ROOT, 'package.json'));
    const requireFs = createRequire(requireRuntime.resolve('@deepseek-ai/dsh-fs-local/package.json'));
    const { default: koffi } = await import(pathToFileURL(requireFs.resolve('koffi')).href);
    const security = koffi.load('advapi32.dll'), kernel = koffi.load('kernel32.dll');
    const get = security.func('int __stdcall GetFileSecurityW(const char16_t *path, uint32_t requested, void *descriptor, uint32_t length, _Out_ uint32_t *needed)');
    const set = security.func('int __stdcall SetFileSecurityW(const char16_t *path, uint32_t information, void *descriptor)');
    const replace = kernel.func('int __stdcall ReplaceFileW(const char16_t *replaced, const char16_t *replacement, void *backup, uint32_t flags, void *exclude, void *reserved)');
    const last = kernel.func('uint32_t __stdcall GetLastError()');
    return {
      copyPermissions(source, destination) {
        const needed = [0]; get(toNamespacedPath(source), 4, null, 0, needed);
        if (!needed[0]) throw failure('RESTORE_PERMISSION_FAILED', `无法保留文件权限（${last()}）。`);
        const descriptor = Buffer.alloc(needed[0]);
        if (!get(toNamespacedPath(source), 4, descriptor, descriptor.length, needed)
          || !set(toNamespacedPath(destination), 0x80000004, descriptor)) throw failure('RESTORE_PERMISSION_FAILED', `无法保留文件权限（${last()}）。`);
      },
      replace(destination, staged) {
        if (!replace(toNamespacedPath(destination), toNamespacedPath(staged), null, 0, null, null)) throw failure('RESTORE_WRITE_FAILED', `文件替换未完成（${last()}），请检查文件是否正在使用。`);
      },
    };
  })().catch(error => { win32Promise = undefined; throw error; });
  return win32Promise;
}

class FileVersionStore {
  constructor(config) {
    this.directory = absolute(config.directory);
    this.allowedRoots = config.allowedRoots;
    if (!(Array.isArray(this.allowedRoots) || typeof this.allowedRoots === 'function')) throw failure('INVALID_ARGUMENT', '缺少授权文件范围。');
    this.privateRoots = (config.privateRoots ?? []).map(absolute);
    this.maxFileBytes = config.maxFileBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1 || this.maxFileBytes > 256 * 1024 * 1024) throw failure('INVALID_ARGUMENT', '文件大小上限无效。');
    this.blobs = join(this.directory, 'blobs'); this.database = join(this.directory, 'versions.sqlite');
    this.ownerDatabase = join(this.directory, 'owner.sqlite');
    this.lockPath = join(this.directory, 'store.lock'); this.owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    this.inflight = new Set();
  }
  async initialize() {
    if (process.platform === 'win32' && this.directory.startsWith('\\\\')) throw failure('STORE_UNAVAILABLE', '版本数据库必须保存在本机账号目录。');
    const missing = [];
    let parent = this.directory;
    while (!await probe(parent)) { missing.unshift(parent); parent = dirname(parent); }
    await inspect(parent, { directory: true });
    for (const path of missing) { await inspect(dirname(path), { directory: true }); await mkdir(path, { mode: 0o700 }); await inspect(path, { directory: true }); }
    this.storeIdentity = identity((await inspect(this.directory, { directory: true })).info);
    try { await this.acquireOwner();
      if (!await probe(this.blobs)) await mkdir(this.blobs, { mode: 0o700 });
      this.blobIdentity = identity((await inspect(this.blobs, { directory: true })).info);
      await inspect(this.database, { allowAbsent: true });
      for (const suffix of ['-wal', '-shm', '-journal']) await inspect(`${this.database}${suffix}`, { allowAbsent: true });
      this.db = new DatabaseSync(this.database);
      this.databaseIdentity = identity((await inspect(this.database)).info);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw failure('STORE_UNAVAILABLE', '版本数据库来自更新的客户端，请升级后重试。');
      this.db.exec(`CREATE TABLE IF NOT EXISTS versions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL, path_key TEXT NOT NULL, name TEXT NOT NULL,
        hash TEXT, size INTEGER NOT NULL, created_at TEXT NOT NULL,
        phase TEXT NOT NULL, operation_id TEXT NOT NULL, session_id TEXT NOT NULL,
        tool TEXT, status TEXT, fingerprint TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS versions_path ON versions(path_key,seq DESC);
        CREATE TABLE IF NOT EXISTS restores (id TEXT PRIMARY KEY, state TEXT NOT NULL,
          source_id TEXT NOT NULL, current_id TEXT NOT NULL, result_id TEXT);
        UPDATE restores SET state='unknown' WHERE state='prepared';
        PRAGMA user_version=1;`);
      return this;
    } catch (error) { this.db?.close(); await this.releaseOwner(); throw error; }
  }
  async acquireOwner() {
    // A separate SQLite EXCLUSIVE transaction is the lifetime process lock.
    // The OS releases it after a crash; PID-file stale deletion alone has a
    // check/unlink race and can let two recovering processes both become owner.
    await inspect(this.ownerDatabase, { allowAbsent: true });
    await inspect(`${this.ownerDatabase}-journal`, { allowAbsent: true });
    let handle;
    try {
      this.ownerDb = new DatabaseSync(this.ownerDatabase);
      this.ownerDb.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS ownership (id INTEGER);');
      this.ownerDatabaseIdentity = identity((await inspect(this.ownerDatabase)).info);
      await inspect(this.lockPath, { allowAbsent: true });
      handle = await open(this.lockPath, 'w', 0o600); await handle.writeFile(this.owner); await handle.sync(); this.ownsLock = true;
    } catch (error) {
      this.ownerDb?.close(); this.ownerDb = null;
      throw failure('STORE_BUSY', '文件版本库正在使用或暂不可用。', error);
    } finally { await handle?.close(); }
  }
  async releaseOwner() {
    if (!this.ownsLock) return;
    this.ownsLock = false;
    try { await inspect(this.lockPath); if (await readFile(this.lockPath, 'utf8') === this.owner) await unlink(this.lockPath); } catch { /* Keep uncertain state rather than deleting someone else's lock. */ }
    finally { try { this.ownerDb?.exec('ROLLBACK'); } finally { this.ownerDb?.close(); this.ownerDb = null; } }
  }
  run(operation) {
    if (this.closing || this.closed) return Promise.reject(failure('STORE_CLOSED', '文件版本服务已关闭。'));
    const promise = Promise.resolve().then(operation); this.inflight.add(promise);
    return promise.finally(() => this.inflight.delete(promise));
  }
  async storage() {
    if (identity((await inspect(this.directory, { directory: true })).info) !== this.storeIdentity
      || identity((await inspect(this.blobs, { directory: true })).info) !== this.blobIdentity
      || identity((await inspect(this.ownerDatabase)).info) !== this.ownerDatabaseIdentity
      || identity((await inspect(this.database)).info) !== this.databaseIdentity) throw failure('STORE_UNAVAILABLE', '版本库位置已改变，已停止操作。');
    await inspect(this.lockPath);
    if (await readFile(this.lockPath, 'utf8') !== this.owner) throw failure('STORE_BUSY', '版本库所有权已改变。');
    for (const suffix of ['-wal', '-shm']) await inspect(`${this.database}${suffix}`, { allowAbsent: true });
  }
  async authorize(path, sessionId) {
    text(sessionId, '会话'); path = absolute(path);
    await this.storage();
    for (const denied of [this.directory, ...this.privateRoots]) {
      if (within(denied, path)) throw failure('PATH_NOT_ALLOWED', '此文件不在当前任务允许的范围内。');
      // Resolve an existing denied root too, so an alias cannot expose private data.
      try { if (within(await realpath(denied), path)) throw failure('PATH_NOT_ALLOWED', '此文件属于客户端私有数据。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const roots = typeof this.allowedRoots === 'function' ? await this.allowedRoots(sessionId) : this.allowedRoots;
    if (!Array.isArray(roots)) throw failure('PATH_NOT_ALLOWED', '无法核实当前任务的文件范围。');
    let matched = false;
    for (const entry of roots) {
      const exact = typeof entry === 'object' && entry?.kind === 'file';
      if (typeof entry !== 'string' && !exact) throw failure('PATH_NOT_ALLOWED', '文件授权范围无效。');
      const root = absolute(exact ? entry.path : entry);
      if (exact ? key(root) !== key(path) : !within(root, path)) continue;
      await inspect(root, { directory: !exact, allowAbsent: exact }); matched = true;
    }
    if (!matched) throw failure('PATH_NOT_ALLOWED', '此文件不在当前任务允许的范围内。');
    return inspect(path, { allowAbsent: true });
  }
  async snapshot(path, sessionId) {
    const before = await this.authorize(path, sessionId);
    if (!before.info) return { ...before, bytes: null, hash: null, size: 0,
      fingerprint: digest(JSON.stringify([key(before.path), before.parents, 'absent'])) };
    if (before.info.size > BigInt(this.maxFileBytes)) throw failure('FILE_TOO_LARGE', '文件超过版本保护的大小上限，尚未完成备份。');
    const handle = await open(before.path, 'r');
    let bytes, opened, after;
    try {
      opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink > 1n || freshness(opened) !== freshness(before.info)) throw failure('VERSION_CONFLICT', '文件已变化，请刷新后重试。');
      bytes = await readBounded(handle, this.maxFileBytes); after = await handle.stat({ bigint: true });
    } finally { await handle.close(); }
    const checked = await this.authorize(path, sessionId);
    if (!checked.info || freshness(opened) !== freshness(after) || freshness(after) !== freshness(checked.info)
      || JSON.stringify(before.parents) !== JSON.stringify(checked.parents) || BigInt(bytes.length) !== after.size) throw failure('VERSION_CONFLICT', '文件正在变化，尚未保存不完整版本。');
    const hash = digest(bytes);
    return { ...checked, bytes, hash, size: bytes.length,
      fingerprint: digest(JSON.stringify([key(checked.path), checked.parents, freshness(after), hash])) };
  }
  decode(row) {
    return { id: row.id, path: row.path, name: row.name, hash: row.hash, size: row.size,
      createdAt: row.created_at, phase: row.phase, operationId: row.operation_id, sessionId: row.session_id,
      ...(row.tool ? { tool: row.tool } : {}), ...(row.status ? { status: row.status } : {}),
      ...(row.operation_state ? { operationStatus: row.operation_state } : {}),
      // Only the committed result row establishes a branch. Equal bytes,
      // backups and partially recorded restorations never imply ancestry.
      ...(row.phase === 'restored' && row.operation_state === 'completed' && row.restore_result_id === row.id
        ? { restoredFromId: row.restore_source_id, restoredFromCurrentId: row.restore_current_id } : {}) };
  }
  query(id) {
    text(id, '版本');
    const row = this.db.prepare('SELECT v.*,r.state AS operation_state,r.source_id AS restore_source_id,r.current_id AS restore_current_id,r.result_id AS restore_result_id FROM versions v LEFT JOIN restores r ON r.id=v.operation_id WHERE v.id=?').get(id);
    if (!row) throw failure('VERSION_NOT_FOUND', '此版本在当前账号的本机记录中不存在。');
    return row;
  }
  async blob(hash, size) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(size) || size < 0 || size > this.maxFileBytes) throw failure('BLOB_CORRUPT', '文件版本内容无效。');
    await this.storage();
    const path = join(this.blobs, hash), checked = await inspect(path);
    if (checked.info.size !== BigInt(size)) throw failure('BLOB_CORRUPT', '文件版本内容不完整。');
    const handle = await open(path, 'r'); let bytes;
    try { bytes = await readBounded(handle, this.maxFileBytes); }
    finally { await handle.close(); }
    if (bytes.length !== size || digest(bytes) !== hash || freshness((await inspect(path)).info) !== freshness(checked.info)) throw failure('BLOB_CORRUPT', '文件版本校验失败，已停止操作。');
    return { path, bytes };
  }
  async save(snapshot, meta) {
    await this.storage();
    if (snapshot.hash !== null) {
      const destination = join(this.blobs, snapshot.hash);
      await exclusive(destination, async () => {
      if (!await probe(destination)) {
        const temporary = join(this.blobs, `.pending-${randomUUID()}`); let handle;
        try {
          handle = await open(temporary, 'wx', 0o600); await handle.writeFile(snapshot.bytes); await handle.sync(); await handle.close(); handle = null;
          await this.storage();
          try { await link(temporary, destination); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        } finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      }
      await this.blob(snapshot.hash, snapshot.size);
      });
    }
    // Content-addressed blobs deduplicate bytes; separate operation associations
    // remain. Only an exact same-operation repeat reuses a metadata row.
    const old = this.db.prepare('SELECT * FROM versions WHERE path_key=? AND session_id=? AND operation_id=? AND phase=? ORDER BY seq DESC LIMIT 1')
      .get(key(snapshot.path), meta.sessionId, meta.operationId, meta.phase);
    if (old && old.hash === snapshot.hash && old.fingerprint === snapshot.fingerprint && old.tool === (meta.tool ?? null) && old.status === (meta.status ?? null)) return this.decode(old);
    const id = randomUUID(), createdAt = new Date().toISOString();
    this.db.prepare('INSERT INTO versions(id,path,path_key,name,hash,size,created_at,phase,operation_id,session_id,tool,status,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, snapshot.path, key(snapshot.path), basename(snapshot.path), snapshot.hash, snapshot.size, createdAt, meta.phase, meta.operationId, meta.sessionId, meta.tool ?? null, meta.status ?? null, snapshot.fingerprint);
    return this.decode(this.query(id));
  }
  capture(path, meta) {
    return this.run(() => exclusive(absolute(path), async () => {
      if (!meta || !phases.has(meta.phase)) throw failure('INVALID_ARGUMENT', '文件版本阶段无效。');
      text(meta.sessionId, '会话'); text(meta.operationId, '操作');
      if (meta.tool !== undefined) text(meta.tool, '工具'); if (meta.status !== undefined) text(meta.status, '状态', 80);
      const snapshot = await this.snapshot(path, meta.sessionId);
      return this.save(snapshot, meta);
    }));
  }
  current(path, { sessionId } = {}) {
    return this.run(() => exclusive(absolute(path), async () => {
      const { hash, size, fingerprint } = await this.snapshot(path, sessionId); return { hash, size, fingerprint };
    }));
  }
  list(path, { sessionId } = {}) {
    return this.run(async () => {
      const checked = await this.authorize(path, sessionId);
      return this.db.prepare('SELECT v.*,r.state AS operation_state,r.source_id AS restore_source_id,r.current_id AS restore_current_id,r.result_id AS restore_result_id FROM versions v LEFT JOIN restores r ON r.id=v.operation_id WHERE path_key=? ORDER BY seq DESC').all(key(checked.path)).map(row => this.decode(row));
    });
  }
  getVersion(id, { sessionId } = {}) {
    return this.run(async () => {
      await this.storage(); const row = this.query(id); await this.authorize(row.path, sessionId);
      const blobPath = row.hash === null ? null : (await this.blob(row.hash, row.size)).path;
      await this.authorize(row.path, sessionId);
      return { ...this.decode(row), blobPath };
    });
  }
  restore(id, { sessionId, expectedFingerprint, beforePublish, signal } = {}) {
    return this.run(async () => {
      if (beforePublish !== undefined && typeof beforePublish !== 'function') throw failure('INVALID_ARGUMENT', '恢复发布校验无效。');
      signal?.throwIfAborted();
      await this.storage(); const row = this.query(id);
      return exclusive(row.path, async () => {
        signal?.throwIfAborted();
        text(expectedFingerprint, '待恢复文件状态', 512);
        await this.authorize(row.path, sessionId);
        if (row.hash === null) throw failure('ABSENT_VERSION', '此记录表示文件原先不存在；恢复不会自动删除当前文件。');
        const source = await this.blob(row.hash, row.size);
        const current = await this.snapshot(row.path, sessionId);
        if (current.fingerprint !== expectedFingerprint) throw failure('VERSION_CONFLICT', '文件已在预览后变化，请重新查看差异。');
        signal?.throwIfAborted();
        const parent = await inspect(dirname(row.path), { directory: true });
        const operationId = randomUUID();
        const currentVersion = await this.save(current, { sessionId, operationId, phase: 'before-restore', status: 'saved' });
        this.db.prepare("INSERT INTO restores(id,state,source_id,current_id) VALUES(?,'prepared',?,?)").run(operationId, row.id, currentVersion.id);
        const temporary = join(parent.path, `.rufa-restore-${randomUUID()}.tmp`);
        let handle, attempted = false, staged = false;
        try {
          signal?.throwIfAborted();
          const windows = process.platform === 'win32' && current.info ? await windowsPublisher() : null;
          await this.authorize(row.path, sessionId);
          handle = await open(temporary, 'wx', 0o600); staged = true;
          if (windows) windows.copyPermissions(row.path, temporary);
          await handle.writeFile(source.bytes); await handle.sync();
          if (current.info && process.platform !== 'win32') await handle.chmod(Number(current.info.mode & 0o777n));
          await handle.close(); handle = null;
          // The parent may wait for a current-frame/account/epoch check here.
          // Its response never replaces the freshness checks: the file may
          // have changed while that request was pending. Cancellation also
          // releases a stalled guard and prevents publication.
          await publicationGuard(beforePublish, signal);
          signal?.throwIfAborted();
          const final = await this.snapshot(row.path, sessionId);
          if (final.fingerprint !== current.fingerprint || identity((await inspect(parent.path, { directory: true })).info) !== identity(parent.info)) throw failure('VERSION_CONFLICT', '文件在恢复前发生变化，原内容已保留。');
          await this.storage();
          // No await may separate this cancellation check from publication.
          signal?.throwIfAborted();
          attempted = true;
          if (!current.info) { await link(temporary, row.path); await unlink(temporary); } // no-replace publication
          else if (windows) windows.replace(row.path, temporary);
          else await rename(temporary, row.path);
          const restored = await this.snapshot(row.path, sessionId);
          if (restored.hash !== row.hash || restored.size !== row.size) throw failure('RESTORE_UNKNOWN', '文件恢复后的状态已变化，请核对文件；恢复前的版本已保存。');
          const version = await this.save(restored, { sessionId, operationId, phase: 'restored', status: 'verified' });
          this.db.prepare("UPDATE restores SET state='completed',result_id=? WHERE id=?").run(version.id, operationId);
          return { version: { ...version, operationStatus: 'completed', restoredFromId: row.id, restoredFromCurrentId: currentVersion.id },
            currentVersion: { ...currentVersion, operationStatus: 'completed' } };
        } catch (error) {
          this.db.prepare('UPDATE restores SET state=? WHERE id=?').run(attempted ? 'unknown' : 'failed', operationId);
          const result = attempted ? failure('RESTORE_UNKNOWN', '恢复结果尚不能确认，请核对文件；恢复前的版本已保存。', error)
            : error instanceof Error ? error : failure('RESTORE_REFUSED', '恢复校验未通过，原文件未覆盖。', error);
          result.currentVersion = currentVersion; throw result;
        } finally {
          await handle?.close().catch(() => {});
          // Never remove a path through a redirected parent. A harmless staging
          // residue is preferable to deleting anything outside this operation.
          if (staged) try {
            if (identity((await inspect(parent.path, { directory: true })).info) === identity(parent.info)) {
              const entry = await inspect(temporary, { allowAbsent: true }); if (entry.info) await unlink(temporary);
            }
          } catch { /* Kept for manual recovery. */ }
        }
      });
    });
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    return this.closePromise = (async () => {
      await Promise.allSettled([...this.inflight]);
      try { this.db.close(); } finally { this.closed = true; await this.releaseOwner(); }
    })();
  }
}

/** All roots and session identities come from the host, never a renderer path.
 * Directory strings authorize their descendants; {path,kind:'file'} grants only
 * that exact file (including a not-yet-created target). Private roots always win.
 * The host must serialize capture → tool execution → after with UI restoration,
 * recheck company identity/epoch and preserve the native permission decision.
 * restore's beforePublish guard and signal bind the final publication to that
 * live request. A rejection/cancellation before publication retains the backup
 * without changing the target; cancellation cannot undo an OS write in flight.
 */
export async function createFileVersionStore(config) { return new FileVersionStore(config).initialize(); }
