import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { readdir } from 'node:fs/promises';
import { companyRequest } from './import-upstream.mjs';
import { previewFileVersions } from './file-version-preview.mjs';
import { createVersionScopes, serialMutations, recordFileMutation, fileMutationTarget, mutationWorkingDirectory, SHELL_VERSION_TOOLS, VERSION_COVERAGE, inside } from './file-version-tracking.mjs';
import { createVersionActivity } from './file-version-activity.mjs';
import { buildFileVersionGraph, fileVersionTree } from './file-version-tree.mjs';
import { validateBadgePath } from './company-badge-paths.mjs';

export const name = 'rufa-file-versions';
export const inject = ['agents', 'sessionQuery', 'workingDirectory'];
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const phases = { before: '修改前', after: '修改后', 'before-restore': '恢复前保留', restored: '恢复结果' };
const publicVersion = value => ({ id: value.id, name: value.name, size: value.size, createdAt: value.createdAt,
  label: phases[value.phase] ?? '已保存', canRestore: value.hash !== null });
export function distinctFileVersions(rows) {
  return rows.filter((row, index) => index === 0 || row.hash !== rows[index - 1].hash || ['before-restore', 'restored'].includes(row.phase));
}

export async function createVersionService({ store, scopes, ctx, pythonPath, authorize = () => companyRequest('GET', '/account') }) {
  const mutex = serialMutations(), previewQueue = serialMutations(), tickets = new Map(), statuses = new Map(), previews = new Map();
  const activity = createVersionActivity(ctx);
  let active = true;
  const check = () => { if (!active) throw new Error('文件版本服务已关闭，请重新打开工作台。'); };
  async function targetOf(input, historyOnly = false) {
    check();
    const { sessionId, seq, index, kind = 'present' } = input ?? {};
    if (!validId(sessionId) || !Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(index) || index < 0) throw new Error('无效的文件记录。');
    let path;
    if (kind === 'present') {
      const read = await ctx.sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 });
      const event = read.target;
      if (event?.type !== 'deliverables/presented' || !Array.isArray(event.data?.files)) throw new Error('找不到这份成果记录。');
      const value = event.data.files[index]?.path;
      if (typeof value !== 'string') throw new Error('找不到这份成果文件。');
      path = resolve(read.session.cwd ?? '', value);
    } else if (kind === 'change') {
      const summary = ctx.get('workspaceChanges')?.summary(sessionId, seq), value = summary?.files[index]?.path;
      if (typeof value !== 'string' || typeof summary.cwd !== 'string') throw new Error('找不到这份改动记录。');
      path = resolve(summary.cwd, value);
    } else throw new Error('无效的文件记录。');
    if (historyOnly) {
      // Pre-feature cards may have no local grant. Return no versions without
      // probing the historical path; invalid/redirected scope records still fail.
      const roots = await scopes.roots(sessionId);
      const admitted = roots.some(root => typeof root === 'string' ? inside(root, path) : inside(root.path, path) && inside(path, root.path));
      if (!admitted) return { sessionId, path, versions: [], untracked: true };
    }
    // list/current repeat the store's live scope and filesystem validation.
    // Merely seeing a path in history never calls scopes.grant.
    const versions = await store.list(path, { sessionId });
    return { sessionId, path, versions };
  }
  const busy = activity.busy;
  async function compare(target, versionId, beforeId) {
    const after = await store.getVersion(versionId, { sessionId: target.sessionId });
    if (after.path !== target.path) throw new Error('此版本不属于当前文件。');
    const rows = target.versions;
    const graph = buildFileVersionGraph(rows);
    if (!graph.rawToNode.has(versionId)) throw new Error('这个版本不在当前文件的记录中。');
    const selected = beforeId === undefined ? graph.compareByRaw.get(versionId) : beforeId;
    const before = selected ? await store.getVersion(selected, { sessionId: target.sessionId }) : null;
    if (before && before.path !== target.path) throw new Error('比较版本不属于当前文件。');
    const key = JSON.stringify([after.name, before?.hash ?? null, after.hash]);
    if (!previews.has(key)) {
      if (previews.size >= 64) previews.delete(previews.keys().next().value);
      const pending = previewQueue.run(() => previewFileVersions({ beforePath: before?.blobPath ?? null, afterPath: after.blobPath, name: after.name, pythonPath }));
      previews.set(key, pending); pending.catch(() => { if (previews.get(key) === pending) previews.delete(key); });
    }
    return previews.get(key);
  }
  const api = {
    get active() { return active; },
    async validateToolPath(execution, path) {
      check(); execution.signal.throwIfAborted();
      if (!execution.agent || ctx.agents.get(execution.agent.id) !== execution.agent) throw new Error('徽章工具只能访问当前本机任务的文件。');
      return validateBadgePath(path, ctx.workingDirectory.get(execution.agent.session), value => scopes.validate(value, 'file'));
    },
    async request(action, input, { signal, confirm = async () => {} } = {}) {
      check();
      signal?.throwIfAborted();
      if (action === 'restore') {
        const ticket = tickets.get(input?.ticketId); tickets.delete(input?.ticketId);
        if (!ticket || ticket.expires < Date.now()) throw new Error('恢复确认已过期，请重新选择版本。');
        return mutex.run(async () => {
          check(); signal?.throwIfAborted(); await confirm(); await authorize(); signal?.throwIfAborted();
          if (busy()) throw new Error('仍有任务或后台命令在运行，请结束后再恢复。');
          await targetOf(ticket.coordinates);
          const result = await store.restore(ticket.versionId, { sessionId: ticket.sessionId, expectedFingerprint: ticket.fingerprint, signal,
            beforePublish: async () => { check(); await confirm(); signal?.throwIfAborted(); if (busy()) throw new Error('仍有任务或后台命令在运行，请结束后再恢复。'); } });
          return { restored: true, version: publicVersion(result.version) };
        });
      }
      const target = await targetOf(input, action === 'history');
      if (action === 'history') {
        const versions = target.versions;
        const different = versions.find(row => row.hash !== versions[0]?.hash);
        const latest = versions[0];
        const graph = buildFileVersionGraph(versions);
        let current;
        // Historical paths never acquire a grant or get probed just to mark a
        // current node. Read bytes only under the existing live store scope.
        if (!target.untracked && input.summaryOnly !== true) { try { current = await store.current(target.path, { sessionId: target.sessionId }); } catch { /* unavailable, not guessed */ } }
        const tree = fileVersionTree(versions, graph, current);
        return { name: basename(target.path), versions: distinctFileVersions(versions).map(publicVersion),
          tree,
          undoVersionId: different?.hash ? different.id : null,
          summary: latest ? latest.hash === null ? '文件已删除，历史版本仍保留' : `已保留 ${distinctFileVersions(versions).length} 个版本` : '此文件尚无自动保存的版本；从启用后的修改开始记录',
          coverage: VERSION_COVERAGE, notice: versions.some(row => row.operationStatus === 'unknown')
            ? '历史中有尚未确认的恢复记录，请核对文件；恢复前版本已保留。'
            : statuses.get(target.sessionId)?.notice ?? await scopes.notice?.(target.sessionId) ?? null };
      }
      if (action === 'compare') return compare(target, input.versionId, input.beforeId);
      if (action === 'prepareRestore') return mutex.run(async () => {
        check(); signal?.throwIfAborted(); await confirm(); await authorize(); signal?.throwIfAborted();
        if (busy()) throw new Error('仍有任务或后台命令在运行，请结束后再恢复。');
        const version = await store.getVersion(input.versionId, { sessionId: target.sessionId });
        if (version.path !== target.path || version.hash === null) throw new Error('这个记录没有可恢复的文件内容。');
        const current = await store.current(target.path, { sessionId: target.sessionId });
        for (const [id, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(id);
        if (tickets.size >= 32) tickets.delete(tickets.keys().next().value);
        const ticketId = randomUUID();
        tickets.set(ticketId, { coordinates: { sessionId: input.sessionId, seq: input.seq, index: input.index, kind: input.kind },
          sessionId: target.sessionId, versionId: version.id, fingerprint: current.fingerprint, expires: Date.now() + 120000 });
        return { ticketId, name: basename(target.path), createdAt: version.createdAt };
      });
      throw new Error('不支持这个文件版本操作。');
    },
    async execute(execution, next) {
      if (!execution.agent) return next();
      const sessionCwd = ctx.workingDirectory.get(execution.agent.session);
      const cwd = execution.name === 'terminal_send' ? activity.terminalDirectory(execution.agent, execution.arguments?.sessionId) : mutationWorkingDirectory(execution, sessionCwd);
      if (!fileMutationTarget(execution, cwd) && !SHELL_VERSION_TOOLS.has(execution.name)) return next();
      return mutex.run(async () => {
        check(); await authorize(); execution.signal.throwIfAborted();
        if (execution.name === 'company_badge') {
          await api.validateToolPath(execution, execution.arguments.path);
          for (const path of execution.arguments.sources ?? []) await api.validateToolPath(execution, path);
        }
        // Child outputs in the same local workspace remain visible to the
        // live parent that will present them, without trusting a cold header.
        let child = execution.agent;
        for (let depth = 0; depth < 16; depth++) {
          const parentId = child.session.header.parentSession;
          const parent = parentId && ctx.agents.get(parentId);
          if (!parent || parent === child || ctx.workingDirectory.get(parent.session) !== sessionCwd) break;
          const target = fileMutationTarget(execution, cwd);
          await scopes.grant(parent.id, target ?? cwd, target ? 'file' : 'directory'); child = parent;
        }
        return recordFileMutation({ store, scopes, execution, cwd, authorize, next: () => activity.run(execution, next),
          incomplete: () => busy(false) || activity.hasPersistentOwner(execution.agent),
          report: async report => {
            statuses.set(report.sessionId, report);
            await scopes.recordNotice?.(report.sessionId, report.notice);
            if (report.notice) ctx.logger?.warn(report.notice);
          } });
      });
    },
    watchTerminals: activity.watchTerminals,
    watchJobs: activity.watchJobs,
    async close() { active = false; tickets.clear(); await mutex.close(); await previewQueue.close(); await store.close(); },
  };
  return api;
}

export async function apply(ctx, config) {
  let service;
  // Register synchronously before storage/Python readiness. Initialization
  // failure must not silently turn a protected mutator into an untracked one.
  ctx.on('tools/execute', (execution, next) => {
    if (!execution.agent) return next();
    if (!service && (['write', 'edit'].includes(execution.name) || execution.name === 'str_replace_editor' && execution.arguments?.command !== 'view'
      || execution.name === 'company_badge' && execution.arguments?.operation === 'stamp' || SHELL_VERSION_TOOLS.has(execution.name))) throw new Error('文件版本保护尚未就绪，请稍后重试。');
    return service ? service.execute(execution, next) : next();
  }, { global: true, prepend: true });
  const { createFileVersionStore } = await import('./file-version-store.mjs');
  const scopes = await createVersionScopes(config);
  const privateRoots = [config.runtimeRoot];
  const accountParent = dirname(config.accountHome);
  for (const entry of await readdir(accountParent, { withFileTypes: true })) {
    const path = join(accountParent, entry.name);
    if (path !== config.accountHome) privateRoots.push(path);
  }
  for (const entry of await readdir(config.privateRoot, { withFileTypes: true })) {
    const path = join(config.privateRoot, entry.name);
    if (path !== accountParent) privateRoots.push(path);
  }
  for (const entry of await readdir(config.accountHome, { withFileTypes: true })) {
    if (entry.name !== 'workspaces') privateRoots.push(join(config.accountHome, entry.name));
  }
  const store = await createFileVersionStore({ directory: join(config.accountHome, 'file-versions'),
    allowedRoots: sessionId => scopes.roots(sessionId), privateRoots });
  service = await createVersionService({ store, scopes, ctx, pythonPath: config.pythonPath });
  ctx.provide('rufaFileVersions', service);
  ctx.inject(['terminals'], scoped => scoped.effect(() => service.watchTerminals(scoped.terminals)));
  ctx.inject(['jobs'], scoped => scoped.effect(() => service.watchJobs(scoped.jobs)));
  const closeIpc = fileVersionIpc(service);
  ctx.effect(() => async () => { await closeIpc(); await service.close(); });
}

export function fileVersionIpc(service, channel = process) {
  const requests = new Map(), confirmations = new Map(); let stopping = false;
  const cancel = requestId => requests.get(requestId)?.controller.abort(new Error('当前工作台已关闭或操作已取消。'));
  const cancelAll = () => { stopping = true; for (const id of requests.keys()) cancel(id); };
  const send = value => { if (channel.connected) channel.send(value, () => {}); };
  function confirm(requestId, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const checkId = randomUUID();
      const finish = allowed => {
        clearTimeout(timer); signal.removeEventListener('abort', aborted); confirmations.delete(checkId);
        if (allowed && !signal.aborted) resolve(); else reject(new Error('当前工作台授权已失效，恢复已取消。'));
      };
      const aborted = () => finish(false), timer = setTimeout(aborted, 10000);
      confirmations.set(checkId, { requestId, finish }); signal.addEventListener('abort', aborted, { once: true });
      send({ type: 'rufa:file-versions-check', requestId, checkId });
    });
  }
  const receive = message => {
    if (message?.type === 'rufa:shutdown') { cancelAll(); return; }
    if (message?.type === 'rufa:file-versions-cancel') { cancel(message.requestId); return; }
    if (message?.type === 'rufa:file-versions-confirm') {
      const pending = confirmations.get(message.checkId);
      if (pending && pending.requestId === message.requestId) pending.finish(message.allowed === true); return;
    }
    if (stopping || message?.type !== 'rufa:file-versions' || !validId(message.requestId)) return;
    if (requests.has(message.requestId)) return;
    const controller = new AbortController();
    const task = Promise.resolve().then(() => service.request(message.action, message.input, { signal: controller.signal,
      confirm: () => confirm(message.requestId, controller.signal) })).then(value => ({ ok: true, value }), error => ({ ok: false,
      error: { code: 'FILE_VERSIONS_FAILED', message: error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message) ? error.message : '文件版本暂不可用，请重试。' } }));
    requests.set(message.requestId, { controller, task });
    void task.then(result => send({ type: 'rufa:file-versions-result', requestId: message.requestId, ...result }))
      .finally(() => requests.delete(message.requestId));
  };
  channel.on('message', receive); channel.on('disconnect', cancelAll);
  return async () => { cancelAll(); channel.removeListener('message', receive); channel.removeListener('disconnect', cancelAll); await Promise.allSettled([...requests.values()].map(row => row.task)); };
}
