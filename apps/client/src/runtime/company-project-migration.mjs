// One-time migration between the company's known MSIX-hosted and standalone
// account directories. No credentials, settings, skills, drafts or events copy.
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';

const names = ['storages/workspace.json', 'company-project-folders.json', 'company-preference-projects.json'];
const markerName = '.rufa-project-profile-migration-v1.json';
const key = value => process.platform === 'win32' ? normalize(value).toLowerCase() : normalize(value);
const hash = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const unique = values => [...new Set(values)];
const array = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const copy = value => structuredClone(value);
const emptyWorkspace = () => ({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } });

function workspace(value) {
  if (value?.unit?.name !== 'workspace' || value.unit.version !== 2 || !value.tables?.workspaces || Array.isArray(value.tables.workspaces)
    || value.global?.initialized !== true || !array(value.global.workspaceIds) || value.global.pendingMutation
    || !array(value.global.archivedSessionIds ?? []) || !array(value.global.pinnedSessionIds ?? [])) throw new Error('项目注册数据尚未就绪或格式不兼容。');
  const rows = value.tables.workspaces;
  if (unique(value.global.workspaceIds).length !== value.global.workspaceIds.length
    || Object.keys(rows).length !== value.global.workspaceIds.length) throw new Error('项目注册顺序与记录不一致。');
  const paths = new Set();
  for (const id of value.global.workspaceIds) {
    const row = rows[id];
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id) || !row || typeof row.path !== 'string' || !isAbsolute(row.path)
      || typeof row.title !== 'string' || !array(row.sessionIds) || !Number.isFinite(Date.parse(row.createdAt))
      || !Number.isFinite(Date.parse(row.updatedAt)) || paths.has(key(row.path))) throw new Error('项目注册内容不兼容。');
    paths.add(key(row.path));
  }
  return value;
}
function auxiliary(value, field) {
  if (!value) return { version: 1, [field]: {} };
  if (value.version !== 1 || !value[field] || typeof value[field] !== 'object' || Array.isArray(value[field])) throw new Error('项目关联配置不兼容。');
  return copy(value);
}
function automatic(row, headers, folders) {
  if (row.title !== basename(row.path) || row.createdAt !== row.updatedAt || !row.sessionIds.length
    || Object.values(folders.projects).some(item => item?.workspaceId && key(item.path ?? '') === key(row.path))) return false;
  const group = [...headers.values()].filter(header => typeof header.cwd === 'string' && key(header.cwd) === key(row.path));
  return group.length === row.sessionIds.length && group.every(header => row.sessionIds.includes(header.id))
    && new Date(Math.max(...group.map(header => header.createdAt))).toISOString() === row.createdAt;
}

export function planProjectMigration({ source, target, sourceHeaders = [], targetHeaders = [] }) {
  const prior = workspace(source[names[0]]), current = workspace(target[names[0]] ?? emptyWorkspace());
  const result = { [names[0]]: copy(current), [names[1]]: auxiliary(target[names[1]], 'projects'), [names[2]]: auxiliary(target[names[2]], 'bindings') };
  const oldFolders = auxiliary(source[names[1]], 'projects'), oldBindings = auxiliary(source[names[2]], 'bindings');
  const oldHeaders = new Map(sourceHeaders.map(row => [row.id, row])), newHeaders = new Map(targetHeaders.map(row => [row.id, row]));
  for (const [id, header] of oldHeaders) if (newHeaders.has(id) && key(newHeaders.get(id).cwd ?? '') !== key(header.cwd ?? '')) throw new Error('同一会话的项目目录不一致，迁移已停止。');
  const doc = result[names[0]], rows = doc.tables.workspaces, changes = [], idMap = new Map();
  const pristine = !target[names[0]] || current.global.workspaceIds.every(id => automatic(current.tables.workspaces[id], newHeaders, result[names[1]]));
  for (const oldId of prior.global.workspaceIds) {
    const old = prior.tables.workspaces[oldId];
    let id = doc.global.workspaceIds.find(id => key(rows[id].path) === key(old.path));
    if (!id) {
      if (Object.hasOwn(rows, oldId)) throw new Error('项目身份冲突，迁移已停止。');
      id = oldId; rows[id] = copy(old); doc.global.workspaceIds.push(id);
      changes.push({ kind: 'import-project', id, title: old.title, path: old.path });
    } else {
      const row = rows[id];
      // Only replace the native path-derived fallback. Preserve explicit titles
      // and existing IDs so current drafts/selections keep their references.
      const explicit = Object.values(result[names[1]].projects).some(item => item?.workspaceId === id);
      if (!explicit && row.title === basename(row.path) && row.title !== old.title) {
        changes.push({ kind: 'restore-title', id, from: row.title, title: old.title, path: row.path }); row.title = old.title;
      }
      const eligible = old.sessionIds.filter(sessionId => {
        const header = newHeaders.get(sessionId) ?? oldHeaders.get(sessionId);
        return header && key(header.cwd ?? '') === key(row.path)
          && !Object.values(rows).some(other => other !== row && other.sessionIds.includes(sessionId));
      });
      row.sessionIds = unique([...row.sessionIds, ...eligible]);
    }
    idMap.set(oldId, id);
  }
  // A previously initialized company registry deliberately omitted these old
  // paths. Remove only a fully evidenced, untouched cloud-bootstrap projection;
  // sessions/files remain and new or edited projects never meet this predicate.
  for (const id of [...current.global.workspaceIds]) {
    const row = current.tables.workspaces[id];
    if (Object.values(prior.tables.workspaces).some(old => key(old.path) === key(row.path))) continue;
    if (automatic(row, newHeaders, result[names[1]]) && row.sessionIds.every(sessionId => oldHeaders.has(sessionId))) {
      delete rows[id]; doc.global.workspaceIds = doc.global.workspaceIds.filter(value => value !== id);
      changes.push({ kind: 'drop-bootstrap-projection', id, path: row.path });
    }
  }
  const targetPins = new Set(current.global.pinnedSessionIds ?? []);
  if (pristine) {
    doc.global.archivedSessionIds = unique([...(current.global.archivedSessionIds ?? []), ...(prior.global.archivedSessionIds ?? []).filter(id => !targetPins.has(id))]);
    doc.global.pinnedSessionIds = unique([...(current.global.pinnedSessionIds ?? []), ...(prior.global.pinnedSessionIds ?? [])]).filter(id => !doc.global.archivedSessionIds.includes(id));
  }
  if (!doc.global.defaultWorkspaceId && prior.global.defaultWorkspaceId && idMap.has(prior.global.defaultWorkspaceId)) doc.global.defaultWorkspaceId = idMap.get(prior.global.defaultWorkspaceId);
  for (const [pathKey, row] of Object.entries(oldFolders.projects)) {
    if (!row || typeof row.path !== 'string' || pathKey !== key(row.path) || !array(row.referencePaths) || row.referencePaths.some(path => !isAbsolute(path))) throw new Error('旧项目参考目录数据不兼容。');
    const id = idMap.get(row.workspaceId);
    if (!id || key(rows[id].path) !== key(row.path) || Object.hasOwn(result[names[1]].projects, pathKey)) continue;
    result[names[1]].projects[pathKey] = { ...copy(row), workspaceId: id };
  }
  for (const [oldId, row] of Object.entries(oldBindings.bindings)) {
    const id = idMap.get(oldId);
    if (!id || !row || typeof row.path !== 'string' || key(rows[id].path) !== key(row.path)) continue;
    if (!Object.hasOwn(result[names[2]].bindings, id)) result[names[2]].bindings[id] = copy(row);
  }
  workspace(doc);
  return { documents: result, changes, archiveStateImported: pristine, skippedModifiedArchiveState: !pristine };
}

async function bytesAt(home, name) {
  const path = join(home, name);
  try {
    if (key(await realpath(path)) !== key(path) || !(await stat(path)).isFile()) throw new Error('项目迁移文件被重定向。');
    const bytes = await readFile(path);
    if (bytes.length > 8 * 1024 * 1024) throw new Error('项目迁移元数据过大。');
    return bytes;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function headersAt(home) {
  const file = join(home, 'company-history.sqlite');
  try { if (key(await realpath(file)) !== key(file)) throw new Error('会话索引被重定向。'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT id,header FROM sessions').all().map(row => { const header = JSON.parse(row.header); if (header.id !== row.id) throw new Error('会话索引身份不一致。'); return header; }); }
  finally { db.close(); }
}
async function atomic(home, name, bytes) {
  const path = join(home, name), parent = dirname(path);
  if (key(await realpath(home)) !== key(home)) throw new Error('项目迁移目录被重定向。');
  let cursor = home;
  for (const segment of relative(home, parent).split(/[\\/]/).filter(Boolean)) {
    if (segment === '..') throw new Error('项目迁移目标越界。');
    cursor = join(cursor, segment);
    try { if (key(await realpath(cursor)) !== key(cursor)) throw new Error('项目迁移目录被重定向。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(cursor); }
    if (key(await realpath(cursor)) !== key(cursor)) throw new Error('项目迁移目录被重定向。');
  }
  const temporary = `${path}.${randomUUID()}.pending`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
  await rename(temporary, path);
}

export async function migrateCompanyProjects({ sourceAccountHome, targetAccountHome, serverUrl, userId, dryRun = true, checkpoint }) {
  const scope = createHash('sha256').update(`${serverUrl}:${userId}`).digest('hex');
  const source = resolve(sourceAccountHome), target = resolve(targetAccountHome);
  if (basename(source) !== scope || basename(target) !== scope || basename(dirname(source)) !== 'accounts' || basename(dirname(target)) !== 'accounts') throw new Error('项目迁移必须属于同一公司服务器与账号。');
  if (key(source) === key(target)) return { status: 'same-profile', changes: [] };
  const overlap = relative(source, target);
  if (!overlap.startsWith('..') && !isAbsolute(overlap)) throw new Error('项目迁移目录不可嵌套。');
  try { if (key(await realpath(source)) !== key(source) || key(await realpath(target)) !== key(target)) throw new Error('项目迁移账号目录被重定向。'); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'no-source', changes: [] }; throw error; }
  let stateBytes = await bytesAt(target, markerName), state = stateBytes && JSON.parse(stateBytes);
  if (state && (state.version !== 1 || state.scope !== scope || key(state.source) !== key(source))) throw new Error('项目迁移标记不匹配。');
  if (state?.status === 'complete') return { status: 'complete', changes: state.changes };
  if (!state) {
    const sourceBytes = await Promise.all(names.map(name => bytesAt(source, name)));
    if (!sourceBytes[0]) return { status: 'no-source', changes: [] };
    const targetBytes = await Promise.all(names.map(name => bytesAt(target, name)));
    const parse = values => Object.fromEntries(values.map((bytes, i) => [names[i], bytes && JSON.parse(bytes)]));
    const plan = planProjectMigration({ source: parse(sourceBytes), target: parse(targetBytes), sourceHeaders: await headersAt(source), targetHeaders: await headersAt(target) });
    state = { version: 1, scope, source, status: 'prepared', backupId: randomUUID(), changes: plan.changes,
      archiveStateImported: plan.archiveStateImported, files: names.map((name, i) => ({ name, before: hash(targetBytes[i]), after: `${JSON.stringify(plan.documents[name], null, 2)}\n` })) };
    if (dryRun) return { status: 'planned', changes: plan.changes, archiveStateImported: plan.archiveStateImported, documents: plan.documents };
    // Recheck both read snapshots before committing. Backups are raw bytes and
    // only the three explicitly allowed project metadata files can be written.
    for (let i = 0; i < names.length; i++) {
      if (hash(await bytesAt(source, names[i])) !== hash(sourceBytes[i]) || hash(await bytesAt(target, names[i])) !== hash(targetBytes[i])) throw new Error('项目数据在迁移准备期间变化，请重试。');
      const backupRoot = join('.rufa-project-migration', state.backupId);
      if (sourceBytes[i]) await atomic(target, join(backupRoot, 'source', names[i]), sourceBytes[i]);
      if (targetBytes[i]) await atomic(target, join(backupRoot, 'target', names[i]), targetBytes[i]);
    }
    await atomic(target, markerName, Buffer.from(JSON.stringify(state)));
    await checkpoint?.('prepared');
  }
  if (state.status !== 'prepared' || !Array.isArray(state.files) || state.files.length !== names.length
    || state.files.some((file, i) => file.name !== names[i] || typeof file.after !== 'string' || (file.before !== null && !/^[0-9a-f]{64}$/.test(file.before)))) throw new Error('项目迁移恢复标记无效。');
  workspace(JSON.parse(state.files[0].after));
  if (dryRun) return { status: 'prepared', changes: state.changes, archiveStateImported: state.archiveStateImported };
  for (const file of state.files) {
    const current = hash(await bytesAt(target, file.name)), after = Buffer.from(file.after);
    if (current !== file.before && current !== hash(after)) throw new Error('项目数据已有新修改，保留备份并停止迁移。');
  }
  for (const file of state.files) {
    const after = Buffer.from(file.after), current = hash(await bytesAt(target, file.name));
    if (current !== hash(after)) {
      if (current !== file.before) throw new Error('项目数据已有新修改，迁移已停止。');
      await atomic(target, file.name, after);
    }
    await checkpoint?.(file.name);
  }
  state.status = 'complete'; await atomic(target, markerName, Buffer.from(JSON.stringify(state)));
  return { status: 'complete', changes: state.changes, archiveStateImported: state.archiveStateImported };
}
