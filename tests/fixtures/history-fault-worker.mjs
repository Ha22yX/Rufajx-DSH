// Owned child process used for abrupt-exit persistence tests. No agent/model/tool execution.
import { importUpstream } from '../../apps/client/src/runtime/import-upstream.mjs';
import { RemotePersistence } from '../../apps/client/src/runtime/remote-persistence.mjs';
const { Context } = await importUpstream('@deepseek-ai/cordis');
const ctx = new Context(), service = new RemotePersistence(ctx);
const handles = new Map();
process.on('message', async message => {
  try {
    let value;
    if (['write', 'enqueue-crash', 'enqueue-existing-crash'].includes(message.action)) {
      const handle = message.action === 'enqueue-existing-crash' ? handles.get(message.header.id) : await service.create(message.header);
      if (!handle) throw new Error('Expected fixture writer');
      handles.set(message.header.id, handle);
      if (message.action !== 'write') {
        for (const event of message.events) handle.enqueueLive(event);
        // Intentionally bypass shutdown/flush; tests the event callback's durability boundary.
        process.kill(process.pid, 'SIGKILL');
      }
      await handle.append(message.events);
      value = service.readCached(handle.id);
    } else if (message.action === 'explicit-expiry-resume') {
      const handle = handles.get(message.sessionId), oldLease = handle.lease.leaseId;
      handle.lease.expiresAt = new Date(0).toISOString();
      let denied = false;
      try { await service.ensureWrite(message.sessionId, { submission: true }); }
      catch { denied = true; }
      if (!denied) throw new Error('Background admission unexpectedly recovered expired ownership');
      const frozenNative = { header: handle.header, events: service.readCached(message.sessionId).events };
      let observations = 0;
      await service.ensureWrite(message.sessionId, { submission: true, recoverForUser: async () => { observations++; return frozenNative; } });
      await handle.append(message.events);
      value = { oldLease, newLease: handle.lease.leaseId, observations, record: service.readCached(message.sessionId) };
      await handle.close(); handles.delete(message.sessionId);
    } else if (message.action === 'resume') {
      const handle = await service.open(message.sessionId, 'write');
      handles.set(message.sessionId, handle);
      await handle.flush();
      await service.ensureWrite(message.sessionId, { submission: true });
      if (message.events?.length) await handle.append(message.events);
      await handle.close(); handles.delete(message.sessionId);
      value = service.readCached(message.sessionId);
    } else if (message.action === 'cached') value = service.readCached(message.sessionId);
    else if (message.action === 'close') {
      await service.stopBackground();
      await Promise.all([...handles.values()].map(handle => handle.close()));
      service.cache.close(); await ctx.fiber.dispose(); value = true;
    } else throw new Error('Unknown test action');
    process.send({ id: message.id, value });
  } catch (error) { process.send({ id: message.id, error: String(error.stack ?? error) }); }
});
process.send({ ready: true });
