// Observe native lifecycle facts without changing tool arguments or results.
// Output silence and job cancellation requests are not process-exit evidence.
import { AsyncLocalStorage } from 'node:async_hooks';
export function createVersionActivity(ctx) {
  const calls = new AsyncLocalStorage();
  const sends = new Set(), terminals = new Map(), uncertain = new Set(), jobs = new Map(), pendingJobs = new Set();
  const owners = new Set();
  const jobTerminals = new Map(); let collecting;
  const terminalComplete = id => {
    uncertain.delete(id);
    for (const [jobId, ids] of jobTerminals) { ids.delete(id); if (!ids.size) { jobs.delete(jobId); jobTerminals.delete(jobId); } }
  };
  const recordOwner = owner => { if (owner?.id) owners.add(owner.id); };
  const busy = (includeAgents = true) => {
    const registry = ctx.get('jobs');
    for (const agent of ctx.agents.list()) owners.add(agent.id);
    const terminalService = ctx.get('terminals');
    if (terminalService) for (const id of owners) {
      const owner = ctx.agents.get?.(id); if (!owner) continue;
      for (const terminal of terminalService.list(owner)) {
        // A pre-existing terminal after plugin reload has no completion proof
        // in this observer. Keep recovery blocked until it is closed.
        if (terminal.status?.kind !== 'exited' && !terminals.has(terminal.sessionId)) return true;
      }
    }
    if (registry) for (const id of [undefined, ...owners]) for (const job of registry.list(id)) {
      if (job.status === 'running' || job.status === 'stopping') return true;
    }
    return sends.size > 0 || uncertain.size > 0 || pendingJobs.size > 0 || [...jobs.values()].some(value => value)
      || includeAgents && ctx.agents.list().some(agent => agent.status !== 'idle');
  };
  return {
    busy,
    run(execution, next) { return calls.run(execution, next); },
    terminalDirectory(owner, id) {
      const row = terminals.get(id), native = ctx.get('terminals');
      if (!row || row.owner !== owner || !row.cwd || native && !native.list(owner).some(item => item.sessionId === id)) throw new Error('此终端不属于当前任务，或其工作文件夹尚未确认。');
      return row.cwd;
    },
    hasPersistentOwner(owner) { return [...terminals.values()].some(row => row.owner === owner); },
    watchTerminals(service) {
      const original = service[Symbol.for('cordis.original')] ?? service;
      const saved = { spawn: original.spawn, startSend: original.startSend, read: original.read, kill: original.kill };
      const wrapped = {
        async spawn(owner, spec, ...args) {
          recordOwner(owner); const value = await saved.spawn.call(this, owner, spec, ...args);
          terminals.set(value.sessionId, { owner, cwd: spec.cwd }); return value;
        },
        startSend(owner, id, options, ...args) {
          recordOwner(owner);
          const row = terminals.get(id) ?? { owner };
          const execution = calls.getStore();
          if (execution?.name !== 'pwsh' || execution.agent !== owner) row.marker = undefined;
          else if (options.text) {
            const nonce = /^Write-Output '__DSH_PERSISTENT_PWSH_START_([a-f0-9-]{36})__'; /.exec(options.text)?.[1];
            row.marker = nonce && options.text.endsWith(`Write-Output ('__DSH_PERSISTENT_PWSH_END_${nonce}:' + $__s)`) ? `__DSH_PERSISTENT_PWSH_END_${nonce}:` : undefined;
          }
          terminals.set(id, row); uncertain.add(id);
          collecting?.add(id);
          const operation = saved.startSend.call(this, owner, id, options, ...args); sends.add(operation);
          void operation.done.then(result => {
            if (result.waitReason === 'session_exit' || result.sessionStatus?.kind === 'exited') { terminalComplete(id); terminals.delete(id); }
          }, () => {}).finally(() => sends.delete(operation));
          return operation;
        },
        read(owner, id, ...args) {
          const result = saved.read.call(this, owner, id, ...args), marker = terminals.get(id)?.marker;
          // Echoed input contains the marker expression, but never this complete
          // line with its numeric status. The nonce comes from native pwsh.
          if (marker && new RegExp(`(?:^|\\r?\\n)${marker}[0-9]+ *\\r?\\n`).test(result.text)) terminalComplete(id);
          return result;
        },
        async kill(owner, id, ...args) {
          const value = await saved.kill.call(this, owner, id, ...args);
          terminalComplete(id); terminals.delete(id); return value;
        },
      };
      for (const name of Object.keys(wrapped)) original[name] = wrapped[name];
      return () => { for (const name of Object.keys(wrapped)) if (original[name] === wrapped[name]) original[name] = saved[name]; };
    },
    watchJobs(service) {
      const original = service[Symbol.for('cordis.original')] ?? service, start = original.start;
      const off = service.events.subscribe({ owners: 'all' }, event => {
        if (!event.job) return;
        if (event.job.owner) owners.add(event.job.owner);
        if (event.type === 'registered' || event.type === 'stopping') jobs.set(event.job.id, true);
        // A registry forced failure/removal never clears an unknown producer.
      });
      const wrapped = function(spec) {
        const run = spec.run, related = new Set(); let producer;
        const id = start.call(this, { ...spec, run(...args) {
          const prior = collecting; collecting = related;
          try { const hooks = run.apply(this, args); producer = hooks.done; return hooks; }
          finally { collecting = prior; }
        } });
        if (spec.kind === 'pty-send' && related.size) jobTerminals.set(id, related);
        if (producer) {
          pendingJobs.add(producer);
          void producer.then(outcome => {
            // These pinned native producers await process.done before reporting
            // completed/killed. Other job kinds do not promise resource release.
            if (['bash', 'pwsh'].includes(spec.kind) && ['completed', 'killed'].includes(outcome?.status)) jobs.delete(id);
          }, () => {}).finally(() => pendingJobs.delete(producer));
        }
        return id;
      };
      original.start = wrapped;
      return () => { off(); if (original.start === wrapped) original.start = start; };
    },
  };
}
