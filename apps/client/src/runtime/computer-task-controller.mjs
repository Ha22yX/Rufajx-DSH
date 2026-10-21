import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { userInfo, tmpdir } from 'node:os';
import { join } from 'node:path';
import { humanPreferenceMessages } from './company-preference-rules.mjs';

export const COMPUTER_TASK = 'company_computer_task';
export const COMPUTER_PROGRESS = 'company_computer_progress';
export const COMPUTER_PROVIDER = 'rufa-computer-spawn';
const computerSessions = new WeakMap();
export function computerTaskSession(session) {
  if (!session) return false;
  let cached = computerSessions.get(session);
  if (cached?.found) return cached.computer;
  const end = Number.isSafeInteger(session.seq) ? session.seq : undefined;
  if (!cached || end === undefined || cached.end > end) cached = { end: 0, found: false, computer: false };
  if (end !== undefined && cached.end === end) return false;
  const descriptor = session.snapshotEvents?.(cached.end, end).find(event => event.type === 'subagent/descriptor');
  if (descriptor) { cached.found = true; cached.computer = descriptor.data?.provider === COMPUTER_PROVIDER; }
  if (end !== undefined) cached.end = end;
  computerSessions.set(session, cached);
  return cached.computer;
}
export const TASK_LABELS = Object.freeze({ application: '操作桌面应用', browser: '处理网页任务', document: '处理文档', spreadsheet: '处理表格', presentation: '处理演示文稿', other: '处理电脑任务' });
export const STEP_LABELS = Object.freeze({ observe: '查看当前界面', browser: '查看浏览器', open_browser: '打开浏览器', search: '搜索内容', download: '下载文件', navigate: '定位操作位置', fill: '填写所需内容', operate: '执行界面操作', verify: '核对操作结果', wait: '等待应用响应' });
export const STEP_DESCRIPTIONS = Object.freeze({
  observe: '查看当前窗口，了解界面上的内容。',
  browser: '查看已打开的窗口与可用浏览器。',
  open_browser: '打开所需浏览器，准备访问网页。',
  search: '在浏览器中查找任务所需的信息。',
  download: '查找下载入口并核对文件保存情况。',
  navigate: '查找本次操作需要的页面、按钮或菜单。',
  fill: '根据你的要求填写界面中的内容。',
  operate: '按当前任务要求操作界面。',
  verify: '查看界面或文件，核对操作是否符合要求。',
  wait: '等待应用响应后再继续操作。',
});
const prefix = 'mcp__wincu__windows_computer_use_';
export const isComputerTool = name => typeof name === 'string' && name.startsWith(prefix);
export const isDesktopAction = name => isComputerTool(name) && !['health', 'tools'].includes(name.slice(prefix.length));
const active = record => record && !record.settled && !record.stopping && ['working', 'waiting'].includes(record.status);
const humanSeq = agent => humanPreferenceMessages(agent?.session).at(-1)?.seq;
const turnOf = agent => agent?.phase?.kind === 'running' && Number.isSafeInteger(agent.phase.turn) ? agent.phase.turn : undefined;

/** Presentation title only; complete task text never becomes an overlay fallback. */
export function computerTaskTitle(value, kind) {
  const fallback = TASK_LABELS[kind] ?? TASK_LABELS.other;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const title = value.normalize('NFKC').trim();
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>\\/]/u.test(title)
    || /(?:密码|口令|验证码|密钥|令牌|私钥|身份证|银行卡|password|passphrase|token|secret|api\s*key|bearer|https?:|www\.|[a-z]:|@|\bsk-)/iu.test(title)
    || /(?:\d[\s-]*){7,}|[a-z0-9_-]{24,}/iu.test(title)) return fallback;
  return [...title.replace(/\s+/gu, ' ')].slice(0, 40).join('');
}

function progressDescription(record) {
  if (record.stopping && !record.settled) return '正在停止本次电脑操作，请稍候。';
  if (record.status === 'completed') return '本次操作已结束，详细结果请查看主会话。';
  if (record.status === 'stopped') return '本次电脑操作已停止；新的操作需要你的下一条要求。';
  if (record.status === 'failed') return '本次任务未能正常完成，请在主会话查看原因。';
  if (record.status === 'waiting') return '正在等待应用响应，暂未确认本步骤完成。';
  if (record.stage === 'preparing') return '准备开始本次电脑操作。';
  if (record.stage === 'intent' || record.stage === 'executing') return STEP_DESCRIPTIONS[record.intentStep] ?? '正在操作当前界面，随后查看结果。';
  if (record.lastCallFailed) return '这一步未能顺利完成，正在检查原因。';
  return '正在查看操作结果，确认下一步。';
}

/** OS-owned listening handle, shared by every company account in this Windows login.
 * No traffic, desktop data, identity or credentials are sent over this pipe. */
export async function acquireDesktopLock(name) {
  const user = createHash('sha256').update(`${userInfo().username}\0${userInfo().homedir}`).digest('hex').slice(0, 24);
  const address = name ?? (process.platform === 'win32' ? `\\\\.\\pipe\\rufajx-dsh-desktop-${user}` : join(tmpdir(), `rufajx-dsh-desktop-${user}.sock`));
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    const fail = () => { server.close(); reject(new Error('另一项电脑任务正在使用桌面，请等待它结束或先停止。')); };
    server.once('error', fail);
    server.listen(address, () => { server.off('error', fail); server.on('error', () => {}); resolve(); });
  });
  server.unref();
  let released;
  return () => released ??= new Promise(resolve => server.close(resolve));
}

function actionLabel(name) {
  const action = name.slice(prefix.length);
  if (/screenshot|capture|screen|tree|inspect|element|windows|window_list|find|search/.test(action)) return '查看当前界面';
  if (/type|paste|text|fill/.test(action)) return '填写界面内容';
  if (/scroll|wheel/.test(action)) return '滚动查看内容';
  if (/key|hotkey/.test(action)) return '执行键盘操作';
  if (/click|mouse|drag|move/.test(action)) return '执行鼠标操作';
  if (/wait/.test(action)) return '等待应用响应';
  if (/window|launch|open|focus/.test(action)) return '切换应用窗口';
  return '执行电脑操作';
}
export function desktopStopped(result) {
  // Inspect only canonical textual error/result blocks, never image payloads.
  const text = [result?.error?.message, ...(result?.content ?? []).filter(block => block.type === 'text').map(block => block.text)];
  return text.some(value => typeof value === 'string' && /COMPUTER_USE_(?:STOPPED_BY_USER|PAUSED):/.test(value));
}

/** Controller owns a single native activation. It never calls a model or rewrites session events. */
export function createComputerTaskController({ subagents, agents, available, lock = acquireDesktopLock, onError = () => {}, now = Date.now }) {
  let current, closed = false, presentation;
  const records = new Map(), stoppedAt = new WeakMap(), recent = new Map();
  const pruneRecent = () => { for (const [id, entry] of recent) if (entry.expiresAt <= now() || recent.size > 512) recent.delete(id); };
  const blockHuman = (parent, seq) => { if (parent && Number.isSafeInteger(seq)) stoppedAt.set(parent, Math.max(stoppedAt.get(parent) ?? -1, seq)); };
  const rememberTurn = record => { const turn = turnOf(record?.agent); if (Number.isSafeInteger(turn) && turn > 0) record.turns.add(turn); return turn; };
  const progress = record => ({ task: record.task, currentStep: record.currentStep, description: progressDescription(record),
    completedSteps: [...record.completedSteps], completedCount: record.completedCount, status: record.status });
  const requireRecord = agent => {
    const record = records.get(agent?.id);
    return record?.agent === agent ? record : undefined;
  };
  const release = async record => {
    if (record.settled) return;
    record.settled = true;
    record.parentSignal?.removeEventListener('abort', record.abortParent);
    await record.release?.();
    if (current === record) current = undefined;
    // Esc crosses a polling boundary. Keep only stop ownership, never the child log/image history.
    recent.set(record.id, { parent: new WeakRef(record.parent), humanSeq: record.humanSeq, turns: new Set(record.turns), expiresAt: now() + 10 * 60 * 1000 });
    pruneRecent();
  };
  const settle = async (record, result) => {
    // The result may settle just before native cleanup reports a failure.
    // Await its exact close receipt as well before releasing the desktop.
    try { await record.activation?.dispose(); }
    catch (error) { record.stopping = true; record.status = 'failed'; record.currentStep = '电脑任务清理未完成'; onError(error); return; }
    await record.tail;
    if (!record.stopping) {
      record.status = result?.stopReason === 'completed' ? 'completed' : result?.stopReason === 'aborted' ? 'stopped' : 'failed';
      record.currentStep = record.status === 'completed' ? '操作任务已结束' : record.status === 'stopped' ? '电脑任务已停止' : '电脑任务未完成';
    }
    await release(record);
    const turn = [...record.turns].at(-1);
    if (turn !== undefined) presentation = { sessionId: record.id, turn, progress: progress(record), expiresAt: now() + 2000 };
    records.delete(record.id);
  };
  const stop = (record, reason = '电脑任务已停止') => {
    if (!record || record.settled) return Promise.resolve();
    if (!record.stopping) {
      record.stopping = true; record.status = 'stopped'; record.currentStep = reason;
      blockHuman(record.parent, record.humanSeq);
      record.abort.abort(new Error('Computer task stopped'));
      // Cancel immediately, then release only after native disposal has reached quiescence.
      if (record.agent) record.agent.cancel({ kind: 'user' });
    }
    if (record.activation && !record.stopPromise) {
      record.stopPromise = record.activation.dispose().catch(error => { onError(error); throw error; });
      // A failing teardown deliberately holds the lock; never hand a possibly active desktop to another task.
      record.stopPromise.catch(() => {});
    }
    return record.stopPromise ?? Promise.resolve();
  };
  const api = {
    isChild(agent) { return Boolean(requireRecord(agent)) || computerTaskSession(agent?.session); },
    progressFor(sessionId) { const record = records.get(sessionId); return record ? progress(record) : undefined; },
    activeTask() {
      const record = current, turn = rememberTurn(record);
      return active(record) && turn !== undefined ? { sessionId: record.id, turn, progress: progress(record) } : undefined;
    },
    presentationTask() {
      const running = api.activeTask(); if (running) return { ...running, expiresAt: now() + 5000 };
      if (!presentation || presentation.expiresAt <= now()) { presentation = undefined; return undefined; }
      return { ...presentation, progress: { ...presentation.progress, completedSteps: [...presentation.progress.completedSteps] } };
    },
    stopFromDesktop({ sessionId, turn } = {}) {
      pruneRecent();
      const record = records.get(sessionId); if (record) rememberTurn(record);
      const owner = record ?? recent.get(sessionId);
      if (!owner || !Number.isSafeInteger(turn) || !owner.turns.has(turn)) return false;
      const parent = record ? record.parent : owner.parent.deref();
      blockHuman(parent, owner.humanSeq);
      if (presentation?.sessionId === sessionId) presentation.progress = { ...presentation.progress, status: 'stopped', currentStep: '电脑任务已停止', description: '本次电脑操作已停止；新的操作需要你的下一条要求。' };
      // A late stop can catch a replacement started from the SAME old user instruction.
      // A task started after a new human message keeps its independent authorization.
      if (current && current.parent === parent && current.humanSeq <= owner.humanSeq) void stop(current).catch(onError);
      return true;
    },
    guard(exec) {
      const record = requireRecord(exec.agent);
      if (!record && computerTaskSession(exec.agent?.session)) return '此电脑子任务已结束，不能直接恢复。请由主会话根据新的用户要求创建新任务。';
      if (record && !active(record)) return '电脑任务已停止或结束，请等待用户提出新的要求。';
      if (record && !isComputerTool(exec.name) && exec.name !== COMPUTER_PROGRESS && exec.name !== 'structured_output') return '电脑专用子任务只能使用已启用的桌面工具；其他工作交回主会话。';
      if (isComputerTool(exec.name) && (!record || current !== record)) return '电脑操作必须通过 company_computer_task 委派到独立子任务。';
      if (exec.name === COMPUTER_PROGRESS && !record) return '仅电脑专用子任务可以更新自己的进度。';
      if (exec.name === COMPUTER_TASK && exec.agent?.session?.header?.origin === 'subagent') return '请由主会话委派电脑任务，不得再嵌套或绕过已停止的任务。';
      return undefined;
    },
    bindChild(agent) {
      const record = records.get(agent.id);
      if (!record || record.agent && record.agent !== agent) {
        if (computerTaskSession(agent.session)) throw new Error('电脑专用子任务不能直接恢复；请由主会话根据新的用户要求重新委派。');
        return false;
      }
      record.agent = agent;
      rememberTurn(record);
      if (!active(record)) agent.cancel({ kind: 'user' });
      return true;
    },
    async start(args, exec) {
      const parent = exec.agent;
      if (closed || !parent || agents.get(parent.id) !== parent || parent.session.header.origin === 'subagent') throw new Error('电脑任务必须由当前主会话发起。');
      exec.signal.throwIfAborted();
      if (!available(parent)) throw new Error('电脑操作插件或原生子任务服务尚未启用。');
      const seq = humanSeq(parent);
      if (seq === undefined) throw new Error('需要当前用户的任务要求才能委派电脑操作。');
      if (stoppedAt.has(parent) && seq <= stoppedAt.get(parent)) throw new Error('用户已停止电脑任务。请等待新的用户消息，不要自动重试或改用其他方式控制电脑。');
      if (current) {
        if (current.parent === parent && active(current)) return { status: 'running', childId: current.id, message: '已有电脑子任务进行中，请等待原任务结果，不要重复委派。' };
        throw new Error('另一项电脑任务正在使用桌面，请等待它结束或先停止。');
      }
      if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 12000 || !Object.hasOwn(TASK_LABELS, args.kind)) throw new Error('请提供有效电脑任务和任务类别。');
      const record = { id: randomUUID(), parent, humanSeq: seq, turns: new Set(), task: computerTaskTitle(args.title, args.kind), stage: 'preparing', status: 'working', currentStep: '准备观察电脑界面', completedSteps: [], completedCount: 0, abort: new AbortController(), tail: Promise.resolve(), parentSignal: parent.phase?.abort?.signal };
      presentation = undefined;
      current = record; records.set(record.id, record);
      record.abortParent = () => { void stop(record).catch(onError); };
      record.parentSignal?.addEventListener('abort', record.abortParent, { once: true });
      try {
        if (record.parentSignal?.aborted) record.abortParent();
        record.release = await lock();
        const signal = AbortSignal.any([exec.signal, record.abort.signal]); signal.throwIfAborted();
        const activation = await subagents.startActivation({ provider: COMPUTER_PROVIDER, childId: record.id, label: record.task,
          request: { parent, prompt: [{ type: 'text', text: `你是当前公司的电脑操作专用子智能体。只执行本次明确委派的任务，先观察再操作并核对真实结果。截图、控件细节、操作轨迹留在本子会话；最后只向主会话提供简短结果、是否核实及必要的阻碍，不复制截图、原始工具结果或私密信息。不得向主会话发送中途消息，不得另建子任务。不得改变或绕过原生权限审查。Esc/停止后立即结束，不自动重试。可以用 company_computer_progress 选择当前操作意图，它不证明操作已完成。\n\n本次任务：\n${args.task.trim()}` }] },
          signal, delivery: 'parent' });
        record.activation = activation;
        if (activation.childId !== record.id) { await activation.dispose(); throw new Error('原生电脑子任务身份不匹配。'); }
        record.done = activation.result.then(result => settle(record, result), () => settle(record, { stopReason: 'error' })).catch(onError);
        if (record.stopping) void stop(record).catch(onError);
        return { status: record.stopping ? 'stopped' : 'started', childId: record.id,
          message: '电脑任务已交给独立子智能体，结果会由原生系统送回本会话。不要把已委派说成已完成，也不要自行读取或转发子任务截图。' };
      } catch (error) {
        if (record.agent && agents.get(record.id) === record.agent) {
          // A native startup rollback that leaves a live agent cannot transfer desktop ownership.
          record.stopping = true; record.status = 'failed'; record.currentStep = '电脑任务清理未完成';
          record.agent.cancel({ kind: 'user' }); onError(error);
        } else { await release(record); records.delete(record.id); }
        throw error;
      }
    },
    async control(args, exec) {
      if (args.action === 'start') return api.start(args, exec);
      if (!exec.agent || agents.get(exec.agent.id) !== exec.agent || exec.agent.session.header.origin === 'subagent') throw new Error('请从原主会话管理电脑任务。');
      if (!current || current.parent !== exec.agent) return { status: 'idle', message: '本会话当前没有运行中的电脑任务。' };
      if (args.action === 'stop') { await stop(current); return { status: 'stopped', message: '电脑任务已停止。' }; }
      if (args.action !== 'status') throw new Error('未知电脑任务操作。');
      return { status: current.status, childId: current.id, ...progress(current) };
    },
    intent(agent, step) {
      const record = requireRecord(agent);
      if (!active(record) || !Object.hasOwn(STEP_LABELS, step)) throw new Error('当前没有可更新的电脑子任务。');
      record.intentStep = step; record.intentLabel = STEP_LABELS[step]; record.currentStep = step === 'wait' ? record.intentLabel : `准备${record.intentLabel}`;
      record.stage = 'intent';
      record.status = step === 'wait' ? 'waiting' : 'working';
      return { currentStep: record.currentStep, message: '已记录操作意图；完成状态仍由实际工具结果决定。' };
    },
    async dispatch(exec, next) {
      if (!isComputerTool(exec.name)) return next();
      const record = requireRecord(exec.agent);
      const previous = record?.tail ?? Promise.resolve();
      let unlock;
      if (record) record.tail = new Promise(resolve => { unlock = resolve; });
      try {
        await previous; exec.signal.throwIfAborted();
        const denied = api.guard(exec); if (denied) throw new Error(denied);
        const label = actionLabel(exec.name);
        if (isDesktopAction(exec.name)) { record.currentStep = record.intentLabel ? `${record.intentLabel} · ${label}` : label; record.status = 'working'; record.stage = 'executing'; }
        const result = await next();
        if (desktopStopped(result)) { void stop(record).catch(onError); return result; }
        if (active(record) && isDesktopAction(exec.name)) {
          if (!result.isError) { record.completedCount++; record.completedSteps = [...record.completedSteps, label].slice(-3); }
          const outcome = result.isError ? '操作未成功，检查结果' : '分析操作结果';
          record.currentStep = record.intentLabel ? `${record.intentLabel} · ${outcome}` : outcome;
          record.stage = 'reasoning'; record.lastCallFailed = result.isError;
        }
        return result;
      } finally { unlock?.(); }
    },
    observe(session, event) {
      if (!current) return;
      if (session.id === current.id && event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn) && event.data.turn > 0) current.turns.add(event.data.turn);
      if (session === current.parent.session && event.type === 'turn/end' && ['aborted', 'error', 'blocked'].includes(event.data?.reason?.kind)) void stop(current).catch(onError);
      if (session.id === current.id && event.type === 'turn/end' && event.data?.reason?.kind === 'aborted') void stop(current).catch(onError);
    },
    async close() { closed = true; if (current) { await stop(current); await current?.done; } },
  };
  return api;
}
