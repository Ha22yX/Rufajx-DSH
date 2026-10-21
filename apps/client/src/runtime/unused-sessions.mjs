import { readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { initializationOnly } from './empty-session-policy.mjs';

const original = value => value[Symbol.for('cordis.original')] ?? value;
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id);

// Use the original owner capability, never stop another running Agent or delete
// arbitrary history. The parent IPC and account UI independently check drafts.
export function attachUnusedSessions(ctx, controller, backend) {
  const agents = original(ctx.agents), owned = new Map(), restores = [];
  let active = true;
  for (const method of ['create', 'resume']) {
    const previous = agents[method], descriptor = Object.getOwnPropertyDescriptor(agents, method);
    if (typeof previous !== 'function') throw new Error('Harness Agent生命周期接口已变化。');
    Object.defineProperty(agents, method, { configurable: true, writable: true, value: async function(...args) {
      const handle = await previous.apply(this, args);
      if (active) owned.set(handle.agent.id, handle);
      return handle;
    } });
    restores.push(() => descriptor ? Object.defineProperty(agents, method, descriptor) : delete agents[method]);
  }
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
    if (owned.get(agent.id)?.agent === agent) owned.delete(agent.id);
  }, { global: true });
  const safeRecord = id => {
    const record = backend.cache.get(id);
    return record && record.cloudState === 'local' && record.syncedSeq === 0 && record.remoteSeq === 0 && !record.conflict
      && !backend.knownCloud.has(id) && !backend.mutations.get(id)
      && !backend.cache.list().some(row => row.header.parentSession === id)
      && initializationOnly(record, backend.cache.read(id)) ? record : undefined;
  };
  const safeWriter = writer => !writer || (writer.local && !writer.lease && !writer.uploadRequested && !writer.failure && !writer.lostOwnership);
  const discard = async (id, confirm = async () => false) => {
    if (!validId(id) || !active || backend.stopped || backend.discarding.has(id)) return { deleted: false };
    if (backend.discarded.has(id)) return { deleted: true };
    if (!safeRecord(id)) return { deleted: false };
    backend.discarding.add(id);
    let staged, removed = false, disposed = false;
    try {
      const writer = backend.writers.get(id);
      if (backend.writers.has(id) && !writer || !safeWriter(writer)) return { deleted: false };
      if (writer) await writer.flush();
      const record = safeRecord(id), session = ctx.sessions.get(id), agent = ctx.agents.get(id), handle = owned.get(id);
      if (!active || !record || !safeWriter(writer)) return { deleted: false };
      if (session && (!agent || !handle || handle.agent !== agent || agent.status !== 'idle'
        || !Array.isArray(agent.inbox?.nextTurn) || agent.inbox.nextTurn.length
        || !Array.isArray(agent.inbox?.nextStep) || agent.inbox.nextStep.length || session.seq !== record.eventCount)) return { deleted: false };
      if (agent && !session) return { deleted: false };
      if (!await confirm() || !active || !safeRecord(id) || !safeWriter(writer)) return { deleted: false };
      if (session) { await handle.dispose(); disposed = true; }
      if (writer) await writer.close();
      for (const reader of [...backend.handles]) if (reader.id === id) await reader.close();
      const final = safeRecord(id);
      if (!active || !final || ctx.sessions.get(id) || ctx.agents.get(id) || backend.writers.has(id)) return { deleted: false };
      const journal = backend.journalPath(id);
      let saved;
      try { saved = JSON.parse(await readFile(journal, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (saved && (saved.id !== id || saved.local !== true || saved.uploadRequested === true || saved.inheritedEventCount !== 0
        || !isDeepStrictEqual(saved.header, final.header) || !isDeepStrictEqual(saved.events, backend.cache.read(id)))) return { deleted: false };
      if (!await confirm() || !active || !safeRecord(id) || ctx.sessions.get(id) || ctx.agents.get(id)) return { deleted: false };
      // Workspace directories and user files remain untouched.
      for (const workspace of ctx.workspaceRegistry.list()) if (workspace.sessionIds.includes(id)) await workspace.detachSession(id);
      if (saved) { staged = `${journal}.discard-${randomUUID()}`; await rename(journal, staged); }
      removed = backend.cache.discardInitialization(id, final.eventCount);
      if (!removed) return { deleted: false };
      backend.discarded.add(id); backend.pendingNotifications.delete(id); backend.syncRequestedAt.delete(id);
      ctx.emit('api-session/removed', id);
      return { deleted: true };
    } finally {
      try {
        if (staged) {
          if (removed) await rm(staged, { force: true });
          else await rename(staged, backend.journalPath(id));
        }
      } catch (error) {
        if (!removed) throw error;
        // An inert .discard-* residue cannot be imported as a journal. The
        // committed deletion must still reach the UI as a successful result.
        ctx.logger?.warn('空白会话已清理，临时清理文件暂未移除。');
      } finally {
        backend.discarding.delete(id);
        // Native disposal also publishes removal; failed final validation must
        // restore the retained row instead of hiding newly discovered content.
        if (disposed && !removed && active) {
          const row = (await controller.listState.list()).find(row => row.sessionId === id);
          if (row) ctx.emit('api-session/added', row);
        }
      }
    }
  };
  backend.discardUnusedSession = discard;
  return () => {
    active = false;
    if (backend.discardUnusedSession === discard) delete backend.discardUnusedSession;
    offDisposed(); for (const restore of restores.reverse()) restore(); owned.clear();
  };
}
