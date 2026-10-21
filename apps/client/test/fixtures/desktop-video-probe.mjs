// Isolated test plugin: native registration and prompt reads; never executes desktop input.
import { apply as profileProbe, inject as profileInject } from '../../../../tests/fixtures/profile-probe.mjs';
export const inject = [...profileInject, 'tools'];
export function apply(ctx) {
  profileProbe(ctx);
  const listener = async message => {
    if (message?.type !== 'rufa:test-desktop-video') return;
    try {
      const lease = await ctx.agentPresets.acquireScope('standard');
      let result;
      try {
        const options = { scope: lease.key };
        const prompt = await ctx.systemPrompt.assemble(options);
        const skills = await ctx.skills.list(options);
        const entry = [...ctx.loader.entries()].find(row => row.options.id === 'mcp-dsh-computer-use-win');
        result = {
          tools: ctx.tools.schemas(lease.key).filter(row => row.name.startsWith('mcp__wincu__windows_computer_use_')).map(row => row.name),
          mainTools: prompt.tools.map(row => row.name),
          computerTasksReady: Boolean(ctx.get('rufaComputerTasks')),
          hints: prompt.contexts.filter(row => row.name === 'company:computer-use'),
          catalog: skills.find(row => row.name === 'remotion-motion-graphics') ?? null,
          loaded: message.load ? await ctx.skills.get('remotion-motion-graphics', options) : null,
          prompt: [...prompt.sections, ...prompt.contexts].map(row => row.text).join('\n'),
          active: entry?.fiber?.state === 2,
          config: entry?.options.config,
          reviewReady: ctx.get('rufaAutoReviewReady')?.active === true,
        };
      } finally { await lease[Symbol.asyncDispose](); }
      process.send?.({ type: 'rufa:test-profile-result', id: message.idNumber, result });
    } catch (error) { process.send?.({ type: 'rufa:test-profile-result', id: message.idNumber, error: String(error?.stack ?? error) }); }
  };
  process.on('message', listener);
  ctx.effect(() => () => process.removeListener('message', listener));
}
