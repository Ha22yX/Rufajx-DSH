// Synthetic integration only. Never shipped in the company plugins.
export const inject = ['sessionController', 'sessionPersistence', 'sessionQuery', 'sessions', 'agents', 'pluginManager', 'skills', 'agentPresets', 'clientModules'];
export function apply(ctx) {
  const follows = new Map();
  const listener = message => {
    if (message?.type !== 'rufa:test-history') return;
    void (async () => {
      let result;
      if (message.action === 'follow') {
        const abort = new AbortController(), frames = [];
        const controller = ctx.sessionController[Symbol.for('cordis.original')] ?? ctx.sessionController;
        const stream = controller.history.follow({ address: { kind: 'session', sessionId: message.sessionId }, maxMessages: 50 }, abort.signal);
        const first = await stream.next(); frames.push(first.value);
        const record = { abort, frames, task: null, error: null };
        record.task = (async () => { try { for await (const frame of stream) frames.push(frame); } catch (error) { record.error = String(error); } })();
        follows.set(message.sessionId, record);
        result = { frame: first.value, live: !!ctx.sessions.get(message.sessionId) };
      } else if (message.action === 'sync') {
        await ctx.sessionPersistence.sync(message.sessionId); result = { ok: true };
      } else if (message.action === 'state') {
        const record = follows.get(message.sessionId);
        result = { frames: record?.frames, error: record?.error, live: !!ctx.sessions.get(message.sessionId), agent: !!ctx.agents.get(message.sessionId) };
      } else if (message.action === 'resume') {
        const resultValue = await ctx.sessionController.resolveAgent(message.sessionId);
        if (resultValue.error) throw resultValue.error;
        const agent = resultValue.agent;
        result = { id: agent.id, seq: agent.session.seq, teamService: Boolean(ctx.get('agentTeams')),
          teamTools: ['spawn_teammate', 'send_message', 'list_agents', 'team_task_create', 'team_task_list'].filter(name => agent.ctx.get('tools').get(name, agent)) };
      } else if (message.action === 'create') result = await ctx.sessionController.create({ cwd: process.cwd() });
      else if (message.action === 'office-plugins') {
        const lease = await ctx.agentPresets.acquireScope('standard');
        try { result = { skills: (await ctx.skills.list({ cwd: process.cwd(), scope: lease.key })).map(skill => skill.name),
          browserEntries: ctx.clientModules.graph().entries.map(entry => entry.id),
          plugins: (await ctx.pluginManager.listPlugins()).filter(row => ['skill-office', 'pdf-reader', 'file-upload-ocr', 'better-sidebar', 'video-preview', 'better-sidebar-audio'].includes(row.patchId)).map(row => ({ id: row.patchId, enabled: row.enabled, readonly: row.readOnlyReason })) }; }
        finally { await lease[Symbol.asyncDispose](); }
      }
      else throw new Error('Unknown history test action');
      process.send?.({ type: 'rufa:test-history-result', id: message.id, result });
    })().catch(error => process.send?.({ type: 'rufa:test-history-result', id: message.id, error: String(error) }));
  };
  process.on('message', listener);
  ctx.effect(() => async () => {
    process.removeListener('message', listener);
    for (const value of follows.values()) value.abort.abort();
    await Promise.allSettled([...follows.values()].map(value => value.task));
  });
}
