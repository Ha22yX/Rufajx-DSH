import { lstat, readdir, readFile, realpath, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, parse, relative, resolve } from 'node:path';
import { parseCompanyBadgeArguments } from './company-badge-paths.mjs';

const key = value => process.platform === 'win32' ? normalize(value).toLowerCase() : normalize(value);
export const inside = (root, path) => { const part = relative(key(root), key(path)); return !part || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); };
export const VERSION_EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache']);
export const VERSION_COVERAGE = '自动保留本工作文件夹内由智能体修改的文件。依赖与缓存文件不保留；其他软件、链接目录或后台程序的修改不一定能记录。';
const sessionKey = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id);

export function serialMutations() {
  let tail = Promise.resolve(), active = 0, stopped = false;
  return {
    get busy() { return active > 0; },
    run(task) {
      if (stopped) return Promise.reject(new Error('文件版本服务已关闭。'));
      const result = tail.then(async () => { active++; try { return await task(); } finally { active--; } });
      tail = result.catch(() => {}); return result;
    },
    async close() { stopped = true; await tail; },
  };
}

// An explicit local grant is minted only after native tool approval. Reading a
// cloud header or a presented-file event never creates a filesystem capability.
export async function createVersionScopes({ accountHome, privateRoot, runtimeRoot }) {
  const home = resolve(accountHome), work = join(home, 'workspaces'), state = join(home, 'file-version-scopes.json');
  const forbidden = resolve(privateRoot), runtime = resolve(runtimeRoot);
  const serial = serialMutations();
  async function identity(path, kind) {
    const directories = [];
    let cursor = kind === 'directory' ? path : dirname(path);
    while (true) {
      try { const info = await lstat(cursor, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('版本保护的文件夹已变化。');
        directories.push({ path: cursor, dev: String(info.dev), ino: String(info.ino), born: String(info.birthtimeNs) });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    return directories;
  }
  async function validate(path, kind) {
    if (typeof path !== 'string' || !isAbsolute(path) || !['file', 'directory'].includes(kind)) throw new Error('文件版本目录无效。');
    const target = resolve(path);
    if (key(target) === key(parse(target).root) || inside(target, forbidden) || inside(target, runtime)
      || inside(runtime, target) || inside(forbidden, target) && (!inside(work, target) || key(target) === key(work))) throw new Error('此位置不属于可保护的工作文件夹。');
    if (key(await realpath(home)) !== key(home)) throw new Error('账号目录已被重定向。');
    let cursor = parse(target).root;
    for (const part of relative(cursor, target).split(/[\\/]/).filter(Boolean)) {
      cursor = join(cursor, part);
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('链接路径不纳入自动版本保护。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; break; }
    }
    try {
      const info = await lstat(target);
      if (kind === 'directory' && !info.isDirectory() || kind === 'file' && !info.isFile()) throw new Error('文件版本目标类型已变化。');
      if (key(await realpath(target)) !== key(target)) throw new Error('文件版本路径已被重定向。');
    } catch (error) { if (error.code !== 'ENOENT' || kind !== 'file') throw error; }
    return target;
  }
  async function read() {
    if (key(await realpath(home)) !== key(home)) throw new Error('账号目录已被重定向。');
    try {
      if ((await lstat(state)).isSymbolicLink()) throw new Error('文件版本范围记录已被重定向。');
      const value = JSON.parse(await readFile(state, 'utf8'));
      if (value?.version !== 1 || !Array.isArray(value.grants) || value.grants.some(row => !sessionKey(row.sessionId) || !['file', 'directory'].includes(row.kind) || typeof row.path !== 'string' || !isAbsolute(row.path))) throw new Error('文件版本范围记录损坏。');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, grants: [] }; throw error; }
  }
  async function save(data) {
    const temp = `${state}.${randomUUID()}.pending`;
    try { await writeFile(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600, flush: true }); await rename(temp, state); }
    finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return {
    validate,
    async grant(sessionId, path, kind) {
      if (!sessionKey(sessionId)) throw new Error('无效的会话。');
      path = await validate(path, kind);
      await serial.run(async () => {
        const data = await read(), directories = await identity(path, kind);
        const found = data.grants.find(row => row.sessionId === sessionId && row.kind === kind && key(row.path) === key(path));
        if (found) found.directories = directories;
        else data.grants.push({ sessionId, path, kind, directories });
        await save(data);
      });
      return path;
    },
    async roots(sessionId) {
      if (!sessionKey(sessionId)) return [];
      const roots = [];
      for (const row of (await read()).grants.filter(row => row.sessionId === sessionId)) {
        // A deleted or redirected directory never inherits the old grant.
        await validate(row.path, row.kind);
        if (!Array.isArray(row.directories) || !row.directories.length) throw new Error('旧版本保护范围需要在下次实际修改时重新确认。');
        const current = await identity(row.path, row.kind);
        if (row.directories.some(prior => !current.some(now => key(now.path) === key(prior.path) && now.dev === prior.dev && now.ino === prior.ino && now.born === prior.born))) throw new Error('版本保护的文件夹已被替换，请重新确认工作文件夹。');
        roots.push(row.kind === 'file' ? { path: row.path, kind: 'file' } : row.path);
      }
      return roots;
    },
    async notice(sessionId) { return (await read()).notices?.[sessionId] ?? null; },
    async recordNotice(sessionId, notice) {
      if (!sessionKey(sessionId)) return;
      await serial.run(async () => { const data = await read(); data.notices ??= {}; if (notice) data.notices[sessionId] = notice; else delete data.notices[sessionId]; await save(data); });
    },
  };
}

export async function scanVersionFiles(root, { maxFiles = 2000, maxBytes = 512 * 1024 * 1024, maxFileBytes = 256 * 1024 * 1024 } = {}) {
  const files = [], excluded = []; let bytes = 0;
  async function visit(directory) {
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || key(await realpath(directory)) !== key(directory)) throw new Error('扫描期间文件夹发生变化，请重试。');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) { excluded.push(path); continue; }
      if (entry.isDirectory()) {
        if (VERSION_EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) { excluded.push(path); continue; }
        await visit(path); continue;
      }
      if (!entry.isFile()) { excluded.push(path); continue; }
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('扫描期间文件发生变化，请重试。');
      bytes += info.size; files.push(path);
      if (info.size > maxFileBytes) throw new Error('文件超过 256 MB，无法在修改前保存版本。');
      if (files.length > maxFiles || bytes > maxBytes) throw new Error('工作文件夹过大，无法完整保存修改前版本；请将本次文件放入更小的工作文件夹。');
    }
  }
  await visit(root); return { files, bytes, excluded };
}

export function fileMutationTarget(execution, cwd) {
  const args = execution.arguments ?? {};
  if (execution.name === 'company_badge') { parseCompanyBadgeArguments(args); if (args.operation === 'stamp') return resolve(cwd, args.path); }
  if (['write', 'edit'].includes(execution.name) && typeof args.file_path === 'string') return resolve(cwd, args.file_path);
  if (execution.name === 'str_replace_editor' && args.command !== 'view' && typeof args.path === 'string') return resolve(cwd, args.path);
  return undefined;
}
export const SHELL_VERSION_TOOLS = new Set(['pwsh', 'bash', 'terminal_open', 'terminal_send', 'company_solidworks_run']);
export function mutationWorkingDirectory(execution, cwd) {
  const args = execution.arguments ?? {};
  const override = execution.name === 'terminal_open' ? args.cwd : ['pwsh', 'bash'].includes(execution.name) ? args.workdir : undefined;
  return typeof override === 'string' ? resolve(cwd, override) : cwd;
}

export async function recordFileMutation({ store, scopes, execution, cwd, authorize, next, report, incomplete = () => false, scan = scanVersionFiles }) {
  const sessionId = execution.agent.id, operationId = randomUUID(), target = fileMutationTarget(execution, cwd);
  const shell = SHELL_VERSION_TOOLS.has(execution.name);
  if (!target && !shell) return next();
  const root = target ? await scopes.grant(sessionId, target, 'file') : await scopes.grant(sessionId, cwd, 'directory');
  const beforeScan = target ? { files: [target], excluded: [] } : await scan(root);
  const before = new Map();
  for (const path of beforeScan.files) {
    execution.signal.throwIfAborted();
    before.set(path, await store.capture(path, { sessionId, operationId, phase: 'before', tool: execution.name }));
  }
  // Snapshotting/queueing can take time; an obsolete login must not dispatch.
  await authorize(); execution.signal.throwIfAborted();
  let result, failure;
  try { result = await next(); return result; }
  catch (error) { failure = error; throw error; }
  finally {
    const uncertain = shell && (incomplete() || execution.name.startsWith('terminal_') || ['background', 'promoted'].includes(result?.value?.kind) || execution.arguments?.run_in_background === true);
    const status = uncertain ? 'incomplete' : execution.signal.aborted ? 'cancelled' : failure || result?.isError ? 'failed' : 'completed';
    try {
      const afterScan = target ? { files: [target], excluded: [] } : await scan(root);
      const changes = [];
      for (const path of new Set([...before.keys(), ...afterScan.files])) {
        const after = await store.capture(path, { sessionId, operationId, phase: 'after', tool: execution.name, status });
        if ((before.get(path)?.hash ?? null) !== after.hash) changes.push({ path, before: before.get(path)?.id ?? null, after: after.id });
      }
      await report({ sessionId, operationId, status, changes, excluded: [...new Set([...beforeScan.excluded, ...afterScan.excluded])],
        notice: uncertain ? '命令可能仍在运行，或已切换工作文件夹；这里只保留已确认范围内的阶段版本，不能代表最终全部改动。' : null });
    } catch {
      await report({ sessionId, operationId, status: 'incomplete', changes: [], notice: '修改前版本已保留，但修改后版本未完整保存，请在历史版本中核对。' });
    }
  }
}
