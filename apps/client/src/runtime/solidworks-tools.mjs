import { join } from 'node:path';
import { importUpstream, companyRequest } from './import-upstream.mjs';
import { createSolidworksGate, solidworksOwner } from './solidworks-intent.mjs';
import { humanPreferenceMessages } from './company-preference-rules.mjs';
import { createSolidworksCatalog } from './solidworks-catalog.mjs';
import { createSolidworksProcessManager, runSolidworksProcess } from './solidworks-process.mjs';

const { defineTool } = await importUpstream('@deepseek-ai/dsh-tools');
export const name = 'rufa-solidworks';
export const inject = ['tools', 'agents', 'workingDirectory'];
export const SW_TOOLS = new Set(['company_solidworks', 'company_solidworks_run']);
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
export const SW_CONTEXT = { name: 'company:solidworks', order: 145, interpolate: false,
  text: '当前用户明确要求使用SolidWorks。先向用户给出可见的简短建模计划，可用原生计划能力；调用company_solidworks guide/detect按需查SW2016本地接口、已测样例和失败记录。按计划连续分步：每次company_solidworks_run只提交当前步骤的完整可审查Python代码，做一步核对一步，不默认从零完成全部项目的巨型脚本。同一真实会话持续保留专属可见SW、cad/sw和Python变量，后续使用cad.active/已有doc继续，不重复新建、不为重开验证关闭正在工作的文档。stepTitle用员工可理解的简短步骤名。发现普通建模检查失败先查询status、检查现有模型，再修正当前步骤；停止、超时或结果未知后不自动重放，等待新的用户指令。不得GetActiveObject/接管其他SW窗口、另开进程、改全局偏好或操作激活；只用提供的cad/sw。文件放当前工作文件夹，既有文件修改经过版本保护，外部参考用原生已审查文件工具复制。能力目录不等于已验证，逐步核对几何、尺寸、重建及保存结果。完成后保留可见窗口和模型供员工查看，不自动finish；finish只在用户最新真实消息明确要求结束本任务SW控制或交还窗口时可用，只交还、不关闭或丢弃模型。未知连接需解除时也请用户明确结束控制，不自动解除再重放。只有用户最新真实消息明确要求关闭本任务SW窗口才可用close；存在未保存/未命名文档时先报告，获得保存授权并保存后再关闭，不自动丢弃。完整代码可见，不下载或隐藏待执行脚本，不绕过原生审查。按需读取而不整库灌入上下文，交付模型、图片、关键尺寸和实际限制，不让员工写代码。' };

// Conservative text guard, not a general natural-language authorization engine.
// A mention of an action in a prohibition or feature request is not consent.
function controlDescription(text, action) {
  const phrase = '[^\\n。！？!?；;]';
  return [
    `(?:不要|别|不必|无需|不用|没(?:有)?必要|不需要|不应(?:该)?|不准|不能|不可|暂不|勿)${phrase}{0,32}${action}`,
    `${action}${phrase}{0,24}(?:没(?:有)?必要|不需要|不应该|不允许)`,
    `\\b(?:do not|don't|never|no need to|not necessary to)\\b${phrase}{0,24}${action}`,
    `(?:介绍|解释|说明|教我|告诉我|怎么|如何)${phrase}{0,24}${action}|\\b(?:how to|explain how)\\b${phrase}{0,24}${action}`,
    `(?:增加|新增|添加|实现|开发|保留|支持|提供|具备|设计)${phrase}{0,48}${action}${phrase}{0,32}(?:功能|能力|按钮|选项|接口|逻辑)`,
    `${action}${phrase}{0,32}(?:功能|能力|按钮|选项|接口|逻辑)${phrase}{0,16}(?:增加|实现|保留|支持|提供)`,
    `\\b(?:add|implement|develop|keep|retain|support|provide|design)\\b${phrase}{0,48}(?:(?:feature|ability|capability|button|option)${phrase}{0,32}${action}|${action}${phrase}{0,32}(?:feature|ability|capability|button|option))`,
  ].some(pattern => new RegExp(pattern, 'iu').test(text));
}
export function solidworksCloseIntent(text = '') {
  if (typeof text !== 'string' || controlDescription(text, '(?:关闭|关掉|退出|\\b(?:close|quit|exit)\\b)')) return false;
  return /(?:关闭|关掉|退出).{0,24}(?:solid\s*works|\bsw\b|(?:本任务|这个任务|当前任务|专属).{0,8}(?:窗口|实例))|(?:solid\s*works|\bsw\b).{0,20}(?:关闭|关掉|退出)|\b(?:close|quit|exit)\b.{0,32}(?:solid\s*works|\bsw\b)/iu.test(text);
}
export function solidworksFinishIntent(text = '') {
  if (typeof text !== 'string' || controlDescription(text, '(?:交还|释放|结束[^\\n。！？!?；;]{0,20}控制|\\b(?:release|hand back|end control)\\b)')) return false;
  return /(?:交还|释放|结束控制).{0,20}(?:solid\s*works|\bsw\b|(?:本任务|当前|专属).{0,8}(?:窗口|实例|控制))|(?:solid\s*works|\bsw\b).{0,20}(?:交还|释放|结束控制)|结束.{0,20}(?:solid\s*works|\bsw\b|本任务|当前任务).{0,8}控制|^(?:请你|请|帮我)?\s*交还窗口[。！.!\s]*$|\b(?:release|hand back|end control)\b.{0,32}(?:solid\s*works|\bsw\b)/iu.test(text);
}

// Only committed, native human events can unlock a stopped step. Delegated
// prompts, pending input, files and tool output never count as a new request.
export function createSolidworksTurnGuard(agents) {
  const blocked = new Map();
  const current = agent => {
    const owner = solidworksOwner(agent?.session, agents), last = owner && humanPreferenceMessages(owner).at(-1);
    return { owner: owner?.id, seq: last?.seq ?? -1, text: last?.text ?? '' };
  };
  return {
    current,
    block(agent) { blocked.set(agent.session.id, current(agent)); },
    check(agent) {
      const before = blocked.get(agent.session.id), now = current(agent);
      if (before && (before.owner !== now.owner || now.seq <= before.seq)) throw new Error('该会话的SolidWorks操作已停止或结束；请等待用户新的明确消息，不要自动重试。');
    },
    forget(sessionId) { blocked.delete(sessionId); },
  };
}

export function apply(ctx, config) {
  const gate = createSolidworksGate(ctx.agents), query = createSolidworksCatalog(config.toolkitRoot);
  const turns = createSolidworksTurnGuard(ctx.agents), ownedSessions = new Set();
  const lifetime = new AbortController();
  const stateRoot = join(config.companyHome, 'solidworks-runs');
  const manager = createSolidworksProcessManager({ pythonPath: config.pythonPath,
    helperPath: join(config.toolkitRoot, 'solidworks_runner.py'), stateRoot,
    onActivity(active) { if (process.connected) process.send({ type: 'rufa:solidworks-state', active }, () => {}); } });
  let accountId;
  const stop = () => { lifetime.abort(); return manager.close().then(results => {
    if (results.some(result => result.status === 'rejected')) throw new Error('SolidWorks窗口交还未全部确认。');
  }); };
  const shutdown = () => { void stop().catch(() => ctx.logger.warn('SolidWorks窗口交还尚未确认，请核对可见模型。')); };
  const message = value => { if (value?.type === 'rufa:shutdown') shutdown(); };
  process.on('message', message); process.on('disconnect', shutdown);
  ctx.effect(() => () => { process.off('message', message); process.off('disconnect', shutdown); return stop(); });
  ctx.on('session/disposed', session => {
    ownedSessions.delete(session.id);
    void manager.releaseSession(session.id).catch(() => ctx.logger.warn('SolidWorks会话释放尚未确认，请核对可见模型。'));
  }, { global: true });
  const finishIntent = agent => solidworksFinishIntent(turns.current(agent).text);
  const control = agent => ownedSessions.has(agent?.session?.id) && (solidworksCloseIntent(turns.current(agent).text) || finishIntent(agent)
    || /(?:查看|检查|当前|现在).{0,12}(?:状态|模型|文档|窗口)/u.test(turns.current(agent).text));
  const allowed = (execution, operation) => {
    if (operation === 'close' || operation === 'finish') return ownedSessions.has(execution.agent?.session?.id)
      && (operation === 'close' ? solidworksCloseIntent(turns.current(execution.agent).text) : finishIntent(execution.agent));
    return gate.enabled(execution.agent, true) || operation === 'status' && control(execution.agent);
  };
  ctx.tools.guard(execution => {
    if (!SW_TOOLS.has(execution.name)) return;
    const operation = execution.name === 'company_solidworks_run' ? execution.arguments?.operation ?? 'run' : execution.arguments?.operation;
    if (!allowed(execution, operation)) throw new Error('请由用户在当前主会话明确要求SolidWorks操作；关闭或交还须明确要求关闭本任务窗口、结束本任务SW控制或交还窗口。');
  });
  ctx.on('agent/inbox/claimed', ({ agent, message }) => { gate.observe(agent, [message], true); }, { global: true });
  ctx.on('agent/pre-step', async (execution, next) => {
    const decision = await next(); gate.observe(execution.agent, decision.kind === 'enter' ? decision.messages : []); return decision;
  }, { global: true });
  ctx.on('session/event', (session, event) => { if (event.type === 'user/message') gate.observe({ session }, []); }, { global: true });
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next(), enabled = gate.enabled(context.agent) || control(context.agent);
    return { ...result, tools: result.tools.filter(tool => !SW_TOOLS.has(tool.name) || enabled),
      contexts: [...result.contexts.filter(section => section.name !== SW_CONTEXT.name), ...(enabled ? [SW_CONTEXT] : [])] };
  }, { global: true, prepend: true });
  const authorized = async (execution, operation) => {
    const signal = AbortSignal.any([execution.signal, lifetime.signal]);
    if (!allowed(execution, operation)) throw new Error('当前没有用户授权的SolidWorks操作。');
    const account = await companyRequest('GET', '/account', undefined, signal);
    if (!account?.user?.id) throw new Error('公司登录状态已失效。');
    if (accountId && accountId !== account.user.id) { shutdown(); throw new Error('公司账号已变化，原SolidWorks窗口正在交还。'); }
    accountId = account.user.id; signal.throwIfAborted(); return signal;
  };
  const options = (execution, signal) => ({ sessionKey: execution.agent.session.id,
    cwd: ctx.workingDirectory.get(execution.agent.session), signal });
  ctx.tools.register(defineTool({ name: 'company_solidworks',
    description: '按需查询SolidWorks2016：guide入门与分步规则，detect只检测安装不启动SW，status读取本会话当前模型/窗口状态且不新建进程，libraries类型库，search关键词，member方法签名，type接口，enum枚举，recipe已测参考，evidence测试记录。先查当前状态再继续当前步骤，不因查询失败从零重做。目录覆盖不等于全部验证。',
    parameters: { operation: { type: 'string', enum: ['guide', 'detect', 'status', 'libraries', 'search', 'member', 'type', 'enum', 'recipe', 'evidence'], required: true },
      query: { type: 'string' }, library: { type: 'string' }, type: { type: 'string' }, id: { type: 'string' },
      offset: { type: 'integer' }, limit: { type: 'integer' } }, output,
    async execute(args, execution) {
      const signal = await authorized(execution, args.operation);
      let value;
      if (args.operation === 'status') value = await manager.status(options(execution, signal));
      else if (args.operation === 'detect') value = await runSolidworksProcess({ pythonPath: config.pythonPath,
        helperPath: join(config.toolkitRoot, 'solidworks_runner.py'), stateRoot,
        cwd: ctx.workingDirectory.get(execution.agent.session), signal, operation: 'detect' });
      else value = await query(args);
      signal.throwIfAborted(); return JSON.stringify(value);
    }, presentCall: args => ({ card: 'generic', title: args.operation === 'detect' ? '检查SolidWorks安装' : args.operation === 'status' ? '查看当前SolidWorks模型' : '查阅SolidWorks方法', kind: 'other', rawInput: args }),
  }));
  ctx.tools.register(defineTool({ name: 'company_solidworks_run',
    description: '按用户可见计划连续小步建模，每次run只执行当前步骤的完整可审查Python代码并核对，保留同一会话的可见SW窗口、模型和变量供下一步继续。逐次原生审查、公司鉴权和文件版本保护仍生效；这不是脚本沙箱。普通检查失败先核对现有模型后修正，停止/超时/未知结果不自动重试。finish只在用户最新真实消息明确要求结束本任务SW控制或交还窗口时使用，仅交还不关闭、不丢弃；不得作为每步或任务完成的例行收尾。未知连接需解除时请用户明确结束控制，不自动解除再重放。close只在用户最新消息明确要求关闭本任务SW窗口时使用，未保存模型会拒绝关闭，先获得保存授权再保存。',
    parameters: { operation: { type: 'string', enum: ['run', 'finish', 'close'], description: '默认run。finish交还可见窗口；close请求关闭本任务专属窗口。' },
      stepTitle: { type: 'string', description: '当前步骤简短名称，1–80字，显示在工具卡中。' },
      code: { type: 'string', description: 'run必填：仅当前步骤的完整Python代码。预置cad、sw、get、VARIANT、NULL、pythoncom、math、Path；cad.active和已有doc可延续，不重复建模。不得传脚本路径替代代码。' },
      timeoutSeconds: { type: 'integer', description: 'run为30–900秒，默认300；包含初次启动和本步执行。' } }, output,
    async execute(args, execution) {
      const operation = args.operation ?? 'run';
      if (!['run', 'finish', 'close'].includes(operation)) throw new Error('无效的SolidWorks操作。');
      const signal = await authorized(execution, operation);
      if (!ctx.get('rufaFileVersions')?.active) throw new Error('文件版本保护尚未就绪。');
      if (operation === 'run') turns.check(execution.agent);
      try {
        const binding = options(execution, signal);
        const task = operation === 'finish' ? manager.release(binding) : operation === 'close' ? manager.closeSession(binding)
          : manager.run({ ...binding, code: args.code, stepTitle: args.stepTitle, timeoutSeconds: args.timeoutSeconds ?? 300 });
        if (operation === 'run') ownedSessions.add(binding.sessionKey);
        const result = await task;
        if (result.status === 'stopped' || result.stopRequested || result.timedOut || result.outcomeUnknown) turns.block(execution.agent);
        if (['released', 'closed'].includes(result.status)) { ownedSessions.delete(binding.sessionKey); turns.block(execution.agent); }
        if (result.outcomeUnknown || result.status === 'failed' || result.status === 'stopped' || result.stopRequested || result.timedOut) throw Object.assign(new Error(JSON.stringify(result)), { outcomeUnknown: result.outcomeUnknown });
        signal.throwIfAborted(); return JSON.stringify(result);
      } catch (error) {
        if (signal.aborted || error.outcomeUnknown) turns.block(execution.agent);
        throw error;
      }
    }, presentCall: args => ({ card: 'generic', title: args.operation === 'finish' ? '交还SolidWorks窗口' : args.operation === 'close' ? '关闭本任务SolidWorks窗口' : typeof args.stepTitle === 'string' && args.stepTitle.trim() ? args.stepTitle.trim().slice(0, 80) : '执行当前SolidWorks建模步骤', kind: 'other', rawInput: args }),
  }));
}
