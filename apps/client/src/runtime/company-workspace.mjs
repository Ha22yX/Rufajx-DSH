import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { installProjectRegistryPolicy } from './company-project-directories.mjs';

export const name = 'rufa-company-workspace';
export const inject = ['workspaceRegistry'];
const markerName = '.rufa-default-workspace.json';
const defaultWorkspaceTitle = 'Rufajx默认工作区';
const originalService = value => value[Symbol.for('cordis.original')] ?? value;
const comparablePath = value => process.platform === 'win32' ? normalize(value).toLowerCase() : normalize(value);
const samePath = (a, b) => comparablePath(a) === comparablePath(b);

async function readMarker(path, workspaceRoot) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  let marker;
  try { marker = JSON.parse(text); } catch { throw new Error('公司默认工作区标识文件损坏，请联系管理员。'); }
  if (!marker || marker.version !== 1 || typeof marker.workspaceId !== 'string' || !marker.workspaceId
    || typeof marker.workspacePath !== 'string' || !isAbsolute(marker.workspacePath)
    || (marker.previousDefaultWorkspaceId !== undefined && (typeof marker.previousDefaultWorkspaceId !== 'string' || !marker.previousDefaultWorkspaceId))
    || typeof marker.configuredRoot !== 'string' || !samePath(marker.configuredRoot, workspaceRoot)) {
    throw new Error('公司默认工作区标识无效或目录不匹配，请联系管理员。');
  }
  return marker;
}

async function writeMarker(path, marker) {
  const temporary = `${path}.${randomUUID()}.pending`;
  try {
    await writeFile(temporary, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/**
 * Keep a company-owned default pointer using public registry operations only.
 * Native defaultWorkspaceId is historical first-use state, so it is not rewritten.
 * Old registrations, Session cwd, user-created workspaces, and files stay intact.
 */
export function installCompanyWorkspace(service, { workspaceRoot } = {}) {
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) throw new TypeError('公司默认工作区必须使用绝对路径。');
  const root = resolve(workspaceRoot);
  const markerPath = join(dirname(root), markerName);
  const registry = originalService(service);
  const previous = registry.initializeDefault;
  let disposed = false;
  let pending;
  const active = () => { if (disposed) throw new Error('公司工作区服务已关闭。'); };

  async function renamePreviousDefault(previousId, currentId) {
    active();
    if (previousId === undefined || previousId === currentId) return;
    const historical = registry.get(previousId);
    // This identity came from native initializeDefault, not a guessed filesystem path.
    // Only its original automatic title is migrated; user-authored names stay intact.
    if (historical?.title === 'default-workspace') await historical.setTitle('历史默认工作区');
    active();
  }

  async function prepare() {
    active();
    const marker = await readMarker(markerPath, root);
    active();
    if (marker) {
      const workspace = registry.get(marker.workspaceId);
      // Match native semantics: explicitly deleting a default registration disables recreation.
      if (!workspace) return undefined;
      if (!samePath(workspace.path, marker.workspacePath)) throw new Error('公司默认工作区注册与标识不一致。');
      const canonical = await realpath(root);
      if (!samePath(workspace.path, canonical)) throw new Error('公司默认工作区目录已被重定向，请联系管理员。');
      if (workspace.title === 'default-workspace') await workspace.setTitle(defaultWorkspaceTitle);
      await renamePreviousDefault(marker.previousDefaultWorkspaceId, workspace.id);
      return workspace;
    }

    await mkdir(root, { recursive: true });
    const canonical = await realpath(root);
    active();
    const existingIds = new Set(registry.list().map(workspace => workspace.id));
    // The original resolver is never called: even an empty profile gets only this account's root.
    const firstUse = await previous.call(registry, async () => root);
    active();
    const workspace = firstUse && samePath(firstUse.path, canonical)
      ? firstUse : await registry.create(canonical, defaultWorkspaceTitle);
    active();
    // The native first-use method derives its title from the directory's final segment.
    // Upgrade the prior automatic label, or name a new registration; retain custom user titles.
    if (workspace.title === 'default-workspace' || (!existingIds.has(workspace.id) && workspace.title === basename(root))) await workspace.setTitle(defaultWorkspaceTitle);
    active();
    const nextMarker = {
      version: 1, workspaceId: workspace.id, workspacePath: workspace.path, configuredRoot: root,
      ...(firstUse && firstUse.id !== workspace.id ? { previousDefaultWorkspaceId: firstUse.id } : {}),
    };
    // Save the old identity first so an interrupted title write can retry after restart.
    await writeMarker(markerPath, nextMarker);
    await renamePreviousDefault(nextMarker.previousDefaultWorkspaceId, workspace.id);
    return workspace;
  }

  function initializeDefault() {
    if (disposed) return Promise.reject(new Error('公司工作区服务已关闭。'));
    pending ??= prepare().finally(() => { pending = undefined; });
    return pending;
  }

  registry.initializeDefault = initializeDefault;
  const ready = initializeDefault();
  // A failed startup must not silently leave a bypass around the company directory policy.
  ready.catch(() => {});
  return {
    ready,
    async dispose() {
      disposed = true;
      if (registry.initializeDefault === initializeDefault) registry.initializeDefault = previous;
      await pending?.catch(() => {});
    },
  };
}

/** Publish a startup gate only after the account's default registration is durable. */
export async function apply(ctx, config) {
  if (config.projects === true) {
    const policy = await installProjectRegistryPolicy(ctx.workspaceRegistry);
    ctx.effect(() => () => policy.dispose());
    ctx.provide('rufaWorkspaceReady', { workspaceRoot: resolve(config.workspaceRoot), projects: true });
    return;
  }
  const policy = installCompanyWorkspace(ctx.workspaceRegistry, config);
  ctx.effect(() => () => policy.dispose());
  const workspace = await policy.ready;
  ctx.provide('rufaWorkspaceReady', { workspaceId: workspace?.id, workspaceRoot: resolve(config.workspaceRoot) });
}
