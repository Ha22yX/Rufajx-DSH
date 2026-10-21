import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';

const MAX_OUTPUT = 2_000_000;
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|LC_ALL)$/iu.test(key)));
const canonical = path => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);
function validateSession(sessionKey) {
  if (typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 512 || /[\u0000-\u001f]/u.test(sessionKey)) throw new Error('无法确认当前真实会话。');
}
function validateRun(code, timeoutSeconds) {
  if (typeof code !== 'string' || !code.trim() || code.length > 60000) throw new Error('SolidWorks 脚本不能为空或超过60000字。');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 900) throw new Error('任务时限须为30至900秒。');
}
function unknown(message, result) {
  const error = new Error(message + ' 请核对可见模型及已保存文件，不要自动重试。');
  error.code = 'SOLIDWORKS_OUTCOME_UNKNOWN';
  error.outcomeUnknown = true;
  error.result = { ...result, status: 'unknown', stepComplete: false, outcomeUnknown: true, notice: error.message };
  return error;
}

// One manager belongs to one authenticated account runtime. Identity and paths
// come only from trusted host code, never from model-provided tool arguments.
export function createSolidworksProcessManager({ pythonPath, helperPath, stateRoot, onActivity = () => {}, spawnProcess = spawn }) {
  const workers = new Map(), calls = new Map(), closingSessions = new Map();
  let closed = false, closePromise, ownerPath;
  const activity = () => { try { onActivity([...workers.values()].some(row => !row.exited)); } catch {} };
  async function identity(sessionKey, cwd) {
    await mkdir(stateRoot, { recursive: true });
    const statePath = await realpath(stateRoot), path = canonical(statePath), directory = await realpath(cwd);
    if (ownerPath && ownerPath !== path) throw new Error('账号任务目录已改变，拒绝复用SolidWorks实例。');
    ownerPath = path;
    const ownerKey = createHash('sha256').update(path).digest('hex');
    return { sessionKey, ownerKey, cwd: directory, stateRoot: statePath, key: JSON.stringify([ownerKey, sessionKey, canonical(directory)]) };
  }
  function poison(row, error, graceMs = 30000) {
    if (row.fatal) return;
    row.fatal = error;
    const pending = row.pending;
    if (pending) { pending.stop(); pending.failed = true; }
    row.child.stdin.end(); // EOF asks the broker to hand the visible instance back.
    row.termination ??= new Promise(resolve => {
      const finish = () => { clearTimeout(timer); pending?.settle(error); resolve(); };
      const timer = setTimeout(() => { row.child.kill(); finish(); }, graceMs);
      row.ended.then(finish);
    });
  }
  function start(binding) {
    const child = spawnProcess(pythonPath, ['-I', '-B', '-u', helperPath], {
      cwd: binding.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: environment(),
    });
    let ended;
    const row = { ...binding, child, buffer: '', pending: null, fatal: null, released: false, exited: false,
      ended: new Promise(resolve => { ended = resolve; }) };
    workers.set(binding.key, row); activity();
    child.stdout.setEncoding('utf8'); child.stderr.on('data', () => {});
    child.stdin.on('error', () => { if (!row.released && !row.exited) poison(row, unknown('SolidWorks任务连接已中断。')); });
    child.once('error', () => poison(row, unknown('SolidWorks任务进程无法运行。')));
    child.once('close', code => {
      row.exited = true; ended(); activity();
      if (!row.released && !row.fatal) row.fatal = unknown('SolidWorks任务进程已退出（' + (code ?? '未知') + '）。');
      row.pending?.settle(row.fatal ?? unknown('SolidWorks任务未返回完整结果。'));
    });
    child.stdout.on('data', chunk => {
      if (row.fatal) return;
      const pending = row.pending;
      if (!pending || pending.received) return poison(row, unknown('SolidWorks返回了未对应当前请求的数据。'));
      pending.bytes += Buffer.byteLength(chunk, 'utf8');
      if (pending.bytes > MAX_OUTPUT) return poison(row, unknown('SolidWorks任务输出超过限制。'));
      row.buffer += chunk;
      const end = row.buffer.indexOf('\n');
      if (end < 0) return;
      const line = row.buffer.slice(0, end).trim(); row.buffer = row.buffer.slice(end + 1);
      let value;
      try { value = JSON.parse(line); } catch { return poison(row, unknown('SolidWorks返回了无法验证的数据。')); }
      if (!value || Array.isArray(value) || value.requestId !== pending.id) return poison(row, unknown('SolidWorks请求与回执不一致。'));
      pending.received = true;
      row.lastResult = value;
      const closedResult = pending.operation === 'close' && value.status === 'closed' && value.closed === true
        && value.cleanup === true && value.instanceAlive === false && value.retained === false;
      const neverLaunched = !row.everLaunched && value.launched === false && value.instanceAlive === false
        && ['failed', 'stopped', 'not-started'].includes(value.status);
      const releasedWithoutWindow = pending.operation === 'release' && value.status === 'released' && value.released === true
        && value.instanceAlive === false && value.retained === false && value.cleanup === true;
      const complete = value.stepComplete === true && value.outcomeUnknown !== true
        && (closedResult || neverLaunched || releasedWithoutWindow || value.instanceAlive === true && value.retained === true);
      if (!complete || typeof value.status !== 'string') return poison(row, unknown('SolidWorks操作结果未能确认。', value));
      if (pending.operation === 'run' && (!['completed', 'failed', 'stopped'].includes(value.status) || value.cleanup !== false)) return poison(row, unknown('SolidWorks建模回执不完整。', value));
      if (pending.operation === 'release' && (value.status !== 'released' || value.released !== true)) return poison(row, unknown('SolidWorks窗口尚未确认交还。', value));
      if (pending.operation === 'close' && !closedResult && value.status !== 'failed') return poison(row, unknown('SolidWorks关闭结果未能确认。', value));
      if (row.buffer.length) return poison(row, unknown('SolidWorks返回了额外的未对应数据。'));
      if (value.instanceAlive === true) row.everLaunched = true;
      if (pending.operation === 'release' || closedResult) row.released = true;
      pending.settle(null, { ...value, stopRequested: pending.stopRequested, timedOut: pending.timedOut });
    });
    return row;
  }
  async function send(row, operation, { code, stepTitle, timeoutSeconds = 30, signal, preparedState } = {}, call) {
    if (row.fatal) throw row.fatal;
    if (row.exited || row.released) throw unknown('SolidWorks专属连接已结束。');
    signal?.throwIfAborted();
    const state = preparedState ?? await mkdtemp(join(row.stateRoot, 'batch-')), cancel = join(state, 'cancel'), id = randomUUID();
    signal?.throwIfAborted();
    if (row.fatal) throw row.fatal;
    return new Promise((resolve, reject) => {
      let timer, hardStop, settled = false;
      const pending = { id, operation, bytes: 0, received: false, failed: false, stopRequested: false, timedOut: false,
        stop() {
          if (settled || pending.stopRequested) return;
          pending.stopRequested = true;
          void writeFile(cancel, 'stop', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') poison(row, unknown('无法向SolidWorks发送停止请求。')); });
          hardStop = setTimeout(() => {
            const error = unknown('SolidWorks停止后仍未返回，操作结果未知。');
            poison(row, error, 0);
          }, 30000);
        },
        settle(error, value) {
          if (settled) return; settled = true;
          clearTimeout(timer); clearTimeout(hardStop); signal?.removeEventListener('abort', pending.stop);
          if (row.pending === pending) row.pending = null;
          if (call?.cancel === pending.stop) call.cancel = null;
          error ? reject(error) : resolve(value);
        },
      };
      row.pending = pending;
      if (call) call.cancel = pending.stop;
      signal?.addEventListener('abort', pending.stop, { once: true });
      timer = setTimeout(() => { pending.timedOut = true; pending.stop(); }, (timeoutSeconds + 2) * 1000);
      row.child.stdin.write(JSON.stringify({ operation, persistent: true, sessionKey: row.sessionKey, ownerKey: row.ownerKey,
        requestId: id, cwd: row.cwd, state, cancel, ...(operation === 'run' ? { code, ...(stepTitle ? { stepTitle } : {}) } : {}), timeoutSeconds }) + '\n', error => {
        if (error) poison(row, unknown('SolidWorks请求未能确认送达。'));
      });
      if (signal?.aborted || call?.cancelRequested) pending.stop();
    });
  }
  function releaseRow(row, options, call, operation = 'release') {
    if (row.releasePromise) return row.releasePromise;
    if (row.fatal) return Promise.reject(row.fatal);
    row.releasePromise = (async () => {
      const result = await send(row, operation, options, call);
      if (operation === 'close' && result.status === 'failed') { row.releasePromise = null; return result; }
      row.child.stdin.end();
      // Only our Python helper can be ended here, never a SW PID from a report.
      let timer;
      await Promise.race([row.ended, new Promise(resolve => { timer = setTimeout(() => { row.child.kill(); resolve(); }, 30000); })]);
      clearTimeout(timer);
      if (workers.get(row.key) === row) workers.delete(row.key);
      activity(); return result;
    })().catch(error => { if (!row.fatal && !row.released) row.releasePromise = null; throw error; });
    return row.releasePromise;
  }
  async function releaseUnknown(row) {
    await (row.termination ?? row.ended);
    if (!row.exited) throw unknown('原SolidWorks控制进程尚未确认退出，不能开启新实例。');
    if (workers.get(row.key) === row) workers.delete(row.key);
    activity();
    return { status: 'released', released: true, stepComplete: true, workerExited: true,
      instanceAlive: null, retained: null, handoffConfirmed: false, previousOutcomeUnknown: true,
      notice: '原控制进程已退出并解除本会话连接；先前建模结果及窗口交还状态仍未知。请核对可见模型与保存文件，收到新的用户指令后才可启动新任务，不自动重放。' };
  }
  function dispatch(operation, options) {
    const { sessionKey, cwd, signal, code, stepTitle, timeoutSeconds = 300 } = options;
    validateSession(sessionKey); signal?.throwIfAborted();
    if (closed || closingSessions.has(sessionKey)) throw new Error('SolidWorks服务正在交还窗口，请等待完成。');
    if (operation === 'run') validateRun(code, timeoutSeconds);
    if (stepTitle !== undefined && (typeof stepTitle !== 'string' || !stepTitle.trim() || stepTitle.length > 80 || /[\u0000-\u001f]/u.test(stepTitle))) throw new Error('当前步骤名称须为1至80个字，不能换行。');
    if (calls.has(sessionKey)) throw new Error('当前会话已有SolidWorks操作，请等待完成；不会排队或自动重试。');
    const call = { cancel: null, cancelRequested: false, task: null }; calls.set(sessionKey, call);
    call.task = (async () => {
      const binding = await identity(sessionKey, cwd);
      signal?.throwIfAborted();
      if (closed || closingSessions.has(sessionKey)) throw new Error('SolidWorks服务正在退出。');
      let row = workers.get(binding.key);
      if (!row && [...workers.values()].some(value => value.sessionKey === sessionKey)) throw new Error('会话工作文件夹已改变，拒绝重新开窗或复用原实例；请先核对并交还原窗口。');
      if (!row && operation !== 'run') return { status: 'not-started', stepComplete: true, instanceAlive: false, retained: false };
      if (row?.fatal) {
        if (operation === 'status') return { ...row.fatal.result, workerExited: row.exited,
          notice: row.fatal.message + ' 核对后可用finish解除旧连接，之后须新的用户消息才能开始新任务。' };
        if (operation === 'release') return releaseUnknown(row);
        throw row.fatal; // Unknown calls never silently restart a worker.
      }
      let preparedState;
      if (!row) {
        preparedState = await mkdtemp(join(binding.stateRoot, 'batch-'));
        signal?.throwIfAborted();
        if (closed || closingSessions.has(sessionKey)) throw new Error('SolidWorks服务正在退出。');
        row = start(binding);
      }
      return ['release', 'close'].includes(operation) ? releaseRow(row, { signal }, call, operation)
        : send(row, operation, { code, stepTitle, preparedState, timeoutSeconds: operation === 'run' ? timeoutSeconds : 30, signal }, call);
    })().finally(() => { if (calls.get(sessionKey) === call) calls.delete(sessionKey); });
    return call.task;
  }
  function releaseSession(sessionKey) {
    validateSession(sessionKey);
    if (closingSessions.has(sessionKey)) return closingSessions.get(sessionKey);
    const task = (async () => {
      const call = calls.get(sessionKey);
      if (call) { call.cancelRequested = true; call.cancel?.(); await Promise.allSettled([call.task]); }
      return Promise.allSettled([...workers.values()].filter(row => row.sessionKey === sessionKey)
        .map(row => row.fatal ? row.termination ?? row.ended : releaseRow(row)));
    })().finally(() => closingSessions.delete(sessionKey));
    closingSessions.set(sessionKey, task); return task;
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      const pending = [...calls.values()];
      for (const call of pending) { call.cancelRequested = true; call.cancel?.(); }
      await Promise.allSettled(pending.map(call => call.task));
      return Promise.allSettled([...workers.values()].map(row => row.fatal ? row.termination ?? row.ended : releaseRow(row)));
    })();
    return closePromise;
  }
  return { run: options => dispatch('run', options), status: options => dispatch('status', options),
    release: options => dispatch('release', options), closeSession: options => dispatch('close', options), releaseSession, close };
}

// Detection stays a one-shot helper and never opens SW.
export async function runSolidworksProcess({ pythonPath, helperPath, stateRoot, cwd, operation = 'detect', signal, spawnProcess = spawn }) {
  signal?.throwIfAborted();
  if (operation !== 'detect') throw new Error('建模须使用绑定真实会话的SolidWorks管理器。');
  await mkdir(stateRoot, { recursive: true });
  const state = await mkdtemp(join(stateRoot, 'detect-')), cancel = join(state, 'cancel');
  const child = spawnProcess(pythonPath, ['-I', '-B', '-u', helperPath], { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: environment() });
  let stdout = '', overflow = false;
  child.stdout.setEncoding('utf8'); child.stderr.on('data', () => {}); child.stdin.on('error', () => {});
  const stop = () => child.kill(); signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, 32000);
  try {
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    child.stdout.on('data', value => { if (Buffer.byteLength(stdout + value, 'utf8') > MAX_OUTPUT) { overflow = true; stop(); } else stdout += value; });
    child.stdin.end(JSON.stringify({ operation: 'detect', cwd, state, cancel, timeoutSeconds: 30 }) + '\n');
    if (signal?.aborted) stop();
    const exitCode = await done; signal?.throwIfAborted();
    if (overflow || exitCode !== 0) throw new Error('SolidWorks安装检测未完成。');
    try { return JSON.parse(stdout.trim()); } catch { throw new Error('SolidWorks安装检测未返回可验证结果。'); }
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}
