// Test-only adapter to the exact native adjacent-child service. The team plugin
// owns the public send_message name in the standard preset; this avoids that
// unrelated target resolver while exercising real persistence/cold creation.
import { importUpstream } from '../../src/runtime/import-upstream.mjs';
const { defineTool } = await importUpstream('@deepseek-ai/dsh-tools');
export const name = 'rufa-test-computer-resume';
export const inject = ['tools', 'subagents'];
export function apply(ctx) {
  ctx.tools.register(defineTool({ name: 'rufa_test_native_send_message',
    description: 'Isolated test only: invoke the unchanged native adjacent-child sendMessage service. Never touches the desktop.',
    parameters: { childId: { type: 'string', required: true }, message: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      try { await ctx.subagents.sendMessage(exec.agent, args.childId, [{ type: 'text', text: args.message }], { signal: exec.signal }); }
      catch (error) {
        // The native service intentionally projects its public error as NOT_RESUMABLE.
        // Expose the cause only in this synthetic fixture to prove our admission hook ran.
        const causes = []; let value = error;
        while (value && causes.length < 8) { causes.push(`${value.code ?? value.name}: ${value.message}`); value = value.cause; }
        throw new Error(causes.join('\n'));
      }
      return 'Native continuation unexpectedly admitted';
    },
  }));
}
