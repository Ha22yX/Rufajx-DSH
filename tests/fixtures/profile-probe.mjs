// Test-only IPC control. Never part of the shipped company plugins.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
export const inject = ['pluginManager', 'configEditor', 'hmr', 'agentPresets', 'skills', 'systemPrompt', 'permissionPresets', 'approval', 'sessions', 'rufaAutoReviewReady'];
export function apply(ctx) {
  const entry = id => [...ctx.loader.entries()].find(row => row.options.id === id);
  const state = async () => ({
    bootModuleUrls: [...ctx.loader.internal.loadCache.keys()].filter(url => /dsh-app-boot.*lib\/index\.js/.test(url)),
    adminTools: ['list_users', 'create_user', 'update_user', 'delete_user', 'reset_password', 'list_sessions', 'read_chat', 'list_deleted_users', 'restore_user'].filter(action => ctx.get('tools')?.get(`rufa_admin_${action}`)),
    autoReviewReady: ctx.get('rufaAutoReviewReady')?.active === true,
    autoReviewEntry: { name: entry('auto-review')?.options.name, state: entry('auto-review')?.fiber?.state },
    defaultFeatures: Object.fromEntries(['cot-translation', 'optional-session-search', 'optional-session-title-all-prompts'].map(id => [id, { active: entry(id)?.fiber?.state === 2, config: entry(id)?.options.config }])),
    plugins: (await ctx.pluginManager.listPlugins()).map(row => ({ id: row.patchId, entryId: row.entryId, enabled: row.enabled, readOnlyReason: row.readOnlyReason })),
    bundles: (await ctx.pluginManager.listBundles()).filter(row => row.optional).map(row => ({ name: row.name, enabled: row.enabled })),
    config: Object.fromEntries(['agent-loop', 'ui-theme', 'ui-settings-general'].map(id => [id, entry(id)?.options.config])),
    company: Object.fromEntries(['rufa-brand', 'rufa-credentials', 'rufa-model', 'rufa-persistence', 'rufa-web', 'credentials', 'llm-deepseek', 'llm-pi-ai', 'llm-deepseek-account', 'session-persistence-jsonl', 'web-search-deepseek', 'web-deepseek-api', 'ui-agent-preset', 'ui-settings-plugins', 'ui-settings-plugin-inventory', 'preset-ptc', 'preset-minimal', 'preset-cordis'].map(id => [id, { disabled: entry(id)?.options.disabled === true, active: entry(id)?.fiber?.state === 2 }])),
  });
  let queue = Promise.resolve();
  const listener = message => {
    if (message?.type !== 'rufa:test-profile') return;
    queue = queue.then(async () => {
      try {
        let result;
        if (message.action === 'snapshot') result = await state();
        else if (message.action === 'bundle') result = await ctx.pluginManager.setBundleEnabled(message.name, message.enabled);
        else if (message.action === 'plugin') {
          const row = (await ctx.pluginManager.listPlugins()).find(row => row.patchId === message.id || row.entryId === `include:${message.id}`);
          if (!row) throw new Error(`Unknown test row: ${message.id}`);
          result = await ctx.pluginManager.setPluginEnabled(row.entryId, message.enabled);
        } else if (message.action === 'config') {
          const row = entry(message.id);
          if (!row) throw new Error(`Unknown config row: ${message.id}`);
          await ctx.configEditor.edit(row, current => ({ ...current, ...message.values }));
          result = structuredClone(row.options.config);
        } else if (message.action === 'reconcile') result = await ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile());
        else if (message.action === 'admin-read') result = await ctx.get('tools').get('rufa_admin_list_users').execute({}, { agent: {}, signal: new AbortController().signal });
        else if (message.action === 'auto-review') {
          const { Session } = await import(pathToFileURL(join(process.env.RUFA_RUNTIME_ROOT, 'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href);
          const legacy = Session.create(`legacy-source-${message.idNumber}`);
          legacy.append('permission/preset', { preset: 'workspace-write' });
          legacy.append('sandbox/mode', { mode: 'workspace-write' });
          legacy.append('approval/policy', { policy: 'never' });
          const permissions = ctx.permissionPresets;
          const fresh = ctx.sessions.create();
          const resumed = ctx.sessions.create(undefined, { seed: legacy.snapshotEvents() });
          const child = ctx.sessions.create(undefined, { seed: legacy.snapshotEvents(), meta: { origin: 'subagent', parentSession: fresh.id } });
          let switchBlocked = false;
          try { permissions.set(fresh, 'danger-full-access'); } catch { switchBlocked = true; }
          result = { catalog: permissions.catalog(), defaultPreset: permissions.defaultPreset, switchBlocked,
            modes: [fresh, resumed, child].map(session => ({ current: permissions.current(session), policy: ctx.approval.overrideOf(session) })),
            seedUnchanged: JSON.stringify(resumed.snapshotEvents().slice(0, legacy.snapshotEvents().length)) === JSON.stringify(legacy.snapshotEvents()) };
        }
        else if (message.action === 'standard-mode') {
          const { createScope } = await import(pathToFileURL(join(process.env.RUFA_RUNTIME_ROOT, 'node_modules/@deepseek-ai/dsh-scope/lib/index.js')).href);
          const mounted = [];
          for (const requested of [undefined, 'standard', 'ptc', 'minimal', 'cordis']) {
            const child = createScope(ctx, {});
            try { mounted.push({ requested: requested ?? 'default', resolved: (await ctx.agentPresets.resolve(requested)).id,
              actual: (await ctx.agentPresets.mount(child.ctx, requested)).id }); }
            finally { await child.dispose(); }
          }
          result = { defaultId: ctx.agentPresets.defaultId, roster: await ctx.agentPresets.remoteExportList(), mounted };
        }
        else if (message.action === 'personas') {
          result = [];
          const { createScope } = await import(pathToFileURL(join(process.env.RUFA_RUNTIME_ROOT, 'node_modules/@deepseek-ai/dsh-scope/lib/index.js')).href);
          for (const preset of await ctx.agentPresets.list()) {
            const lease = await ctx.agentPresets.acquireScope(preset.id);
            try {
              const prompt = await ctx.systemPrompt.assemble({ scope: lease.key });
              result.push({ id: preset.id, sections: prompt.sections, contexts: prompt.contexts });
              if (preset.id === 'standard') {
                const key = {}, child = createScope(ctx, key, { parent: lease.key });
                try {
                  child.ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'Review the project schedule only.' });
                  const assembly = await ctx.systemPrompt.assemble({ scope: key });
                  result.push({ id: 'custom-child-role', sections: assembly.sections, contexts: assembly.contexts });
                } finally { await child.dispose(); }
              }
            } finally { await lease[Symbol.asyncDispose](); }
          }
        }
        else if (message.action === 'skills') {
          result = [];
          for (const preset of await ctx.agentPresets.list()) {
            const lease = await ctx.agentPresets.acquireScope(preset.id);
            try { result.push({ id: preset.id, names: (await ctx.skills.list({ cwd: message.cwd, scope: lease.key })).map(skill => skill.name) }); }
            finally { await lease[Symbol.asyncDispose](); }
          }
        }
        else if (message.action === 'badge-capability') {
          const lease = await ctx.agentPresets.acquireScope('standard');
          try {
            result = { tool: Boolean(ctx.get('tools')?.get('company_badge', lease.key)),
              skill: (await ctx.skills.list({ scope: lease.key })).some(skill => skill.name === 'dsh-badge') };
          } finally { await lease[Symbol.asyncDispose](); }
        }
        else throw new Error('Unknown test command');
        process.send?.({ type: 'rufa:test-profile-result', id: message.idNumber, result });
      } catch (error) { process.send?.({ type: 'rufa:test-profile-result', id: message.idNumber, error: String(error?.stack ?? error) }); }
    });
  };
  process.on('message', listener);
  ctx.effect(() => () => process.removeListener('message', listener));
}
