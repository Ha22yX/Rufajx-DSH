// Company-only adaptation of the pinned npm artifact; never edits upstream source.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ORIGINAL_SHA256 = '00080091516184efe0005d8521cb890ae89032b9abcd514b752c4ef7642fa129';
const PATCHED_SHA256 = '789a880d69d83a76d2efc595b5e8b1f4da5608451b18a7c38ff5d6597bc36adf';
const MARKER = '// RUFA SIDEBAR COMPATIBILITY v1';
const digest = value => createHash('sha256').update(value).digest('hex');

// This exact function is embedded in the published host artifact and exercised
// below through its injectable Node dependencies. No browser-supplied cwd is trusted.
export function createSidebarGuard({ fs, path, AsyncLocalStorage, environment, forbidden }) {
  const requests = new AsyncLocalStorage();
  const deny = () => { throw forbidden('侧栏只能访问当前会话的工作目录，请先通过原生工作目录选择器切换目录。'); };
  const inside = (root, value) => { const rel = path.relative(root, value); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); };
  const valid = value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
    && !(process.platform === 'win32' && (/^\\\\[?.]\\/.test(value) || /:/.test(value.slice(2))));
  function canonical(value, missing = false) {
    try { return fs.realpathSync.native(value); }
    catch (error) {
      if (!missing || error.code !== 'ENOENT') throw error;
      // A broken link is not an ordinary not-yet-created file.
      try { fs.lstatSync(value); deny(); } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      const parent = path.dirname(value);
      if (parent === value) deny();
      return path.join(canonical(parent, true), path.basename(value));
    }
  }
  function protectedPath(value) {
    const home = environment.DSH_HOME, runtime = environment.RUFA_RUNTIME_ROOT;
    if (!valid(home) || !valid(runtime) || !path.isAbsolute(home) || !path.isAbsolute(runtime)) deny();
    const homeReal = canonical(home), runtimeReal = canonical(runtime);
    // Account layout is owned by runtime-configuration.ts: userRoot/accounts/<scope>.
    // Its workspaces are ordinary user documents; caches, login state, other
    // accounts and the installation itself are never sidebar workspace content.
    const privateRoot = path.dirname(path.dirname(homeReal));
    const ownWorkspaces = canonical(path.join(homeReal, 'workspaces'));
    if (inside(runtimeReal, value) || (inside(privateRoot, value) && !inside(ownWorkspaces, value))) deny();
  }
  function root(value) {
    if (!valid(value) || !path.isAbsolute(value)) deny();
    const actual = canonical(value);
    if (!fs.statSync(actual).isDirectory()) deny();
    protectedPath(actual);
    return actual;
  }
  function target(cwd, value) {
    if (!valid(value)) deny();
    const boundary = root(requests.getStore()?.root ?? cwd);
    const base = root(cwd);
    if (!inside(boundary, base)) deny();
    const candidate = path.resolve(base, value);
    if (!inside(boundary, candidate)) deny();
    const actual = canonical(candidate, true);
    if (!inside(boundary, actual)) deny();
    protectedPath(actual);
    // Keep lexical identity so rename/delete still act on an in-workspace link.
    return candidate;
  }
  async function sessionRoot(ctx, id) {
    if (typeof id !== 'string' || !id) deny();
    const session = ctx.sessions.get(id);
    if (session) return root(ctx.get('workingDirectory')?.get(session) ?? session.header.cwd);
    const query = ctx.get('sessionQuery');
    if (!query?.observeSession) deny();
    const observation = await query.observeSession(id, { projectionMode: 'all' });
    try { return root(observation.projections?.values.workingDirectory ?? observation.header.cwd); }
    finally { observation[Symbol.dispose](); }
  }
  async function admit(ctx, id) {
    const persistence = ctx.get('sessionPersistence');
    if (persistence?.rufaExactHistory !== true || typeof persistence.ensureWrite !== 'function')
      throw forbidden('公司会话同步服务尚未就绪，请稍后重试。');
    const result = await persistence.ensureWrite(id, { submission: true });
    if (result?.local !== false || !result?.leaseId) throw forbidden('侧聊尚未取得公司会话写入授权，请联网后重试。');
  }
  function archiveTree(cwd, value, visited = new Set()) {
    const safe = target(cwd, value), actual = canonical(safe);
    if (visited.has(actual)) return;
    visited.add(actual);
    if (fs.statSync(actual).isDirectory()) for (const child of fs.readdirSync(actual)) archiveTree(cwd, path.join(actual, child), visited);
  }
  function git(cwd) {
    const boundary = root(requests.getStore()?.root ?? cwd);
    let current = target(boundary, cwd), found = false;
    while (inside(boundary, current)) {
      const dot = path.join(current, '.git');
      let info;
      try { info = fs.lstatSync(dot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (info) {
        let gitDir = target(boundary, dot);
        if (fs.statSync(gitDir).isFile()) {
          const line = fs.readFileSync(gitDir, 'utf8').trim();
          if (!line.startsWith('gitdir: ')) deny();
          gitDir = target(boundary, path.resolve(current, line.slice(8)));
        }
        const common = path.join(gitDir, 'commondir');
        try { target(boundary, path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim())); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        found = true; break;
      }
      if (current === boundary) break;
      current = path.dirname(current);
    }
    if (!found) throw forbidden('当前工作目录内没有可访问的 Git 仓库，请通过原生入口选择仓库目录。');
  }
  async function invoke(ctx, method, payload, handler, signal) {
    if (method.startsWith('settings.') || method.startsWith('sidechat.') || ['git.models', 'git.commit-model'].includes(method)) return handler(payload, signal);
    const boundary = await sessionRoot(ctx, payload?.sessionId);
    return requests.run({ root: boundary }, async () => {
      for (const field of ['repoRoot', 'worktree']) if (payload?.[field] !== undefined) target(boundary, payload[field]);
      if (method === 'open.external') {
        if (payload.action === 'reveal') target(boundary, payload.path);
        else if (payload.action === 'url') {
          // Preserve the built-in local editors, whose URI has one inspectable
          // file target. Opaque command/custom/remote URLs cannot establish a
          // local workspace boundary and are refused by this host route.
          const uri = new URL(payload.url);
          if (!['vscode:', 'cursor:', 'zed:'].includes(uri.protocol) || uri.hostname !== 'file' || uri.search || uri.hash) deny();
          let file = decodeURIComponent(uri.pathname);
          if (process.platform === 'win32' && /^\/[a-z]:\//i.test(file)) file = file.slice(1);
          target(boundary, file);
        } else deny();
      }
      if (method === 'archive.build') for (const selected of payload?.paths ?? []) archiveTree(boundary, selected);
      return handler(payload, signal);
    });
  }
  return { root, target, sessionRoot, admit, invoke, git };
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Sidebar 0.28.0 patch anchor changed: ${before.slice(0, 90)}`);
  return source.replace(before, after);
}
function replaceFunction(source, start, end, replacement) {
  const at = source.indexOf(start), stop = source.indexOf(end, at + start.length);
  if (at < 0 || stop < 0 || source.indexOf(start, at + start.length) >= 0) throw new Error('Sidebar function boundary changed');
  return source.slice(0, at) + replacement + '\n' + source.slice(stop);
}
function runtimeExtension() {
  return `${MARKER}\nimport * as rufaSidebarFs from 'node:fs';\nimport * as rufaSidebarPath from 'node:path';\nimport { AsyncLocalStorage as RufaSidebarStorage } from 'node:async_hooks';\nconst rufaSidebarGuard = (${createSidebarGuard.toString()})({ fs: rufaSidebarFs, path: rufaSidebarPath, AsyncLocalStorage: RufaSidebarStorage, environment: process.env, forbidden: message => new SidebarError('forbidden', message, 403) });\n// END RUFA SIDEBAR COMPATIBILITY\n`;
}

export function patchSidebarSource(source) {
  if (source.includes(MARKER)) {
    if (digest(source) !== PATCHED_SHA256 || !source.endsWith(runtimeExtension())) throw new Error('Company sidebar patch differs from the expected version');
    return source;
  }
  if (digest(source) !== ORIGINAL_SHA256) throw new Error('Unrecognized Better Sidebar 0.28.0 host artifact');
  let next = source;
  next = replaceOnce(next, 'return requireAbsolute(resolveSessionPath(cwd, isAbsolute(homeExpanded) ? homeExpanded : join(cwd, homeExpanded)));',
    'return rufaSidebarGuard.target(cwd, requireAbsolute(resolveSessionPath(cwd, isAbsolute(homeExpanded) ? homeExpanded : join(cwd, homeExpanded))));');
  next = replaceFunction(next, 'async function sessionCwdOf(ctx, sessionId, clientCwd) {', '/** Optional repository selected by the Git panel',
    'async function sessionCwdOf(ctx, sessionId, clientCwd) { return rufaSidebarGuard.sessionRoot(ctx, sessionId); }');
  next = replaceFunction(next, 'async function activeWorktreeRootOf(ctx, sessionId, base) {', '/** One uncached resolution (see',
    'async function activeWorktreeRootOf(ctx, sessionId, base) { return rufaSidebarGuard.root(base); }');
  next = replaceOnce(next, 'const result = await handler(payload, controller?.signal);', 'const result = await rufaSidebarGuard.invoke(ctx, method, payload, handler, controller?.signal);');
  next = replaceOnce(next, 'cwd: await resolveWorktree(root, requested)', 'cwd: await ensureWorkspacePath(base.cwd, await resolveWorktree(root, requested))');
  next = replaceOnce(next, 'function spawnGit(cwd, args, timeoutMs, safe, options = {}) {', 'function spawnGit(cwd, args, timeoutMs, safe, options = {}) {\n\trufaSidebarGuard.git(cwd);');
  next = replaceOnce(next, 'function readGit(cwd, args, allowMissing = false) {', 'function readGit(cwd, args, allowMissing = false) {\n\trufaSidebarGuard.git(cwd);');
  next = replaceOnce(next, 'function admitFollowup(agent, blocks) {', 'async function admitFollowup(agent, blocks) {\n\tawait rufaSidebarGuard.admit(agent.ctx, agent.id);');
  next = replaceOnce(next, 'function admitFirstContact(agent, injectionText, question) {', 'async function admitFirstContact(agent, injectionText, question) {\n\tawait rufaSidebarGuard.admit(agent.ctx, agent.id);');
  next = replaceOnce(next, 'admitFollowup(agent, textPrompt(question));', 'agent.followup(createUserMessage({ content: textPrompt(question), source: { kind: "user" } }));');
  next = replaceOnce(next, 'admitFollowup(agent, textPrompt(text));', 'await admitFollowup(agent, textPrompt(text));');
  next = replaceOnce(next, 'admitFirstContact(handle.agent, promptParts.join("\\n\\n"), question);', 'await admitFirstContact(handle.agent, promptParts.join("\\n\\n"), question);');
  next = replaceOnce(next, 'admitFirstContact(agent, parts.join("\\n\\n"), text);', 'await admitFirstContact(agent, parts.join("\\n\\n"), text);');
  next = replaceOnce(next, '\t\t\t\tpendingSnapshots.delete(childId);\n\t\t\t\tif (snapshot !== void 0) parts.push(snapshot);', '\t\t\t\tif (snapshot !== void 0) parts.push(snapshot);');
  next = replaceOnce(next, 'await admitFirstContact(agent, parts.join("\\n\\n"), text);', 'await admitFirstContact(agent, parts.join("\\n\\n"), text);\n\t\t\t\tpendingSnapshots.delete(childId);');
  next = replaceOnce(next, '`parent session "${sessionId}" is not running`', '"请先恢复当前会话，再创建侧聊。"');
  return next + '\n' + runtimeExtension();
}

const clientHashes = new Set(['53b70b1b5317205247c074b8121e1ececec1df2dc3771b0641f0a66b8fd127e1', '9862678d65831b031a72b54e560f5ad3dd94f00403429072a4c0a75c52d0da85']);
export function patchSidebarClientSource(source) {
  const before = 'api.openExternal({', after = 'api.openExternal({ sessionId: scope.sessionId,';
  const original = source.replaceAll(after, before);
  if (!clientHashes.has(digest(original)) || original.split(before).length !== 3) throw new Error('Unrecognized sidebar client artifact');
  return original.replaceAll(before, after);
}

export async function applySidebarCompatibility(runtimeInput) {
  const runtime = path.resolve(runtimeInput), packageRoot = path.join(runtime, 'node_modules/dsh-better-sidebar');
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'dsh-better-sidebar' || manifest.version !== '0.28.0') throw new Error('Unsupported sidebar version');
  const updates = [];
  for (const name of ['index.js', 'client.js', 'client-registry.js']) {
    const file = path.join(packageRoot, 'lib', name), source = await readFile(file, 'utf8');
    const patched = name === 'index.js' ? patchSidebarSource(source) : patchSidebarClientSource(source);
    updates.push({ file, source, patched });
  }
  for (const { file, source, patched } of updates) if (source !== patched) {
    const temp = `${file}.rufa-${randomUUID()}.tmp`;
    try { await writeFile(temp, patched, { flag: 'wx' }); await rename(temp, file); }
    finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { sidebarCompatibility: 1, changed: updates.some(item => item.source !== item.patched), hostSha256: digest(updates[0].patched) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/sidebar-compat.mjs <materialized-runtime>');
  console.log(JSON.stringify(await applySidebarCompatibility(process.argv[2])));
}
