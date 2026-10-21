import { importUpstream } from './import-upstream.mjs';
import { createComputerTaskController, acquireDesktopLock, COMPUTER_TASK, COMPUTER_PROGRESS, COMPUTER_PROVIDER, TASK_LABELS, STEP_LABELS, isComputerTool } from './computer-task-controller.mjs';
import { computerUseContext } from './computer-use-context.mjs';
const { defineTool } = await importUpstream('@deepseek-ai/dsh-tools');
const nativeSpawn = await importUpstream('@deepseek-ai/dsh-subagent-spawn-in-process');
export const name = 'rufa-computer-tasks';
export const inject = ['tools', 'subagents', 'agents'];
const output = { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };

export function apply(ctx, config = {}) {
  // Same pinned native fresh-session provider, with a durable identity in subagent/descriptor.
  // Native cold resume reads that descriptor before agent/created; our admission rejects it.
  nativeSpawn.apply(ctx, { providerName: COMPUTER_PROVIDER });
  const service = createComputerTaskController({ subagents: ctx.subagents, agents: ctx.agents,
    available: agent => Boolean(ctx.subagents.getProvider(COMPUTER_PROVIDER)) && ctx.tools.schemas(agent).some(tool => isComputerTool(tool.name)),
    lock: () => acquireDesktopLock(config.lockName), onError: () => ctx.logger.warn('电脑子任务清理未完成；桌面锁仍受保护。') });
  ctx.provide('rufaComputerTasks', service);
  ctx.tools.guard(exec => service.guard(exec));
  ctx.on('tools/execute', (exec, next) => service.dispatch(exec, next), { global: true });
  ctx.on('session/event', (session, event) => service.observe(session, event), { global: true });
  ctx.on('agent/created', ({ agent }) => {
    if (!service.bindChild(agent)) return;
    // Scope restriction is enforced by the native registry, not just a persona.
    const allow = ctx.tools.schemas(agent).filter(tool => isComputerTool(tool.name) || tool.name === COMPUTER_PROGRESS).map(tool => tool.name);
    agent.ctx.tools.restrict({ allow });
  }, { global: true });
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next();
    const child = service.isChild(context.agent);
    const available = result.tools.some(tool => isComputerTool(tool.name)) && Boolean(ctx.subagents.getProvider(COMPUTER_PROVIDER));
    const tools = result.tools.filter(tool => {
      if (child) return isComputerTool(tool.name) || [COMPUTER_PROGRESS, 'structured_output'].includes(tool.name);
      if (isComputerTool(tool.name)) return child;
      if (tool.name === COMPUTER_TASK) return !child && context.agent?.session?.header?.origin !== 'subagent' && available;
      if (tool.name === COMPUTER_PROGRESS) return child;
      return true;
    });
    return { ...result, tools, contexts: [...result.contexts.filter(row => row.name !== 'company:computer-use'), ...computerUseContext(tools)] };
  }, { global: true, prepend: true });
  const shutdown = () => { void service.close().catch(() => {}); };
  const message = value => { if (value?.type === 'rufa:shutdown') shutdown(); };
  process.on('message', message); process.on('disconnect', shutdown);
  ctx.effect(() => () => { process.off('message', message); process.off('disconnect', shutdown); return service.close(); });
  ctx.tools.register(defineTool({ name: COMPUTER_TASK,
    description: '把本机Windows界面操作委派给独立电脑子智能体，截图和操作细节只留在子会话，最后结果自动送回当前主会话。每次只运行一项；有运行任务时不要重复委派。用户按Esc或停止后，必须等待新的用户消息才能重新开始，不得改用命令、脚本或其他子任务绕过停止。所有操作仍经原生公司授权审查。',
    parameters: { action: { type: 'string', enum: ['start', 'status', 'stop'], required: true },
      kind: { type: 'string', enum: Object.keys(TASK_LABELS), description: 'start时必填，用于无敏感信息的任务提示。' },
      title: { type: 'string', description: '可选，显示在电脑提示上的具体短标题，最多40字。只写操作目标，如“打开浏览器查找资料”，勿含密码、账号、路径、网址或敏感业务内容。省略使用任务类别。' },
      task: { type: 'string', description: 'start时必填，独立、明确的任务与必要上下文。只传完成操作必需的信息，不转发完整主会话或多余秘密。' } },
    output, execute: (args, exec) => service.control(args, exec),
    presentCall: args => ({ card: 'generic', title: args.action === 'stop' ? '停止电脑任务' : args.action === 'status' ? '查看电脑任务' : '委派电脑任务', kind: 'other', rawInput: args }),
  }));
  ctx.tools.register(defineTool({ name: COMPUTER_PROGRESS,
    description: '电脑专用子任务可更新当前操作意图。仅可选固定短语，不填写业务内容、窗口标题、路径、密码、截图或工具参数；进度完成记录来自实际工具结果。',
    parameters: { step: { type: 'string', enum: Object.keys(STEP_LABELS), required: true } }, output,
    execute: (args, exec) => service.intent(exec.agent, args.step),
    presentCall: () => ({ card: 'generic', title: '更新电脑任务进度', kind: 'other' }),
  }));
}
