import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as tick } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireDesktopLock, createComputerTaskController, computerTaskTitle, COMPUTER_TASK, COMPUTER_PROGRESS, COMPUTER_PROVIDER, desktopStopped } from '../src/runtime/computer-task-controller.mjs';
import { computerUseContext } from '../src/runtime/computer-use-context.mjs';

const click = 'mcp__wincu__windows_computer_use_click';
const screenshot = 'mcp__wincu__windows_computer_use_screenshot';
const task = { action: 'start', kind: 'spreadsheet', task: '打开测试表格并核对结果。' };
function human(seq) { return { seq, type: 'user/message', data: { source: { kind: 'user', rpcId: `human-${seq}` }, content: [{ type: 'text', text: '处理测试表格' }] } }; }
function agent(id, origin = 'user') {
  const events = [human(1)], abort = new AbortController();
  return { id, phase: { kind: 'running', turn: 1, abort }, session: { id, header: { origin }, snapshotEvents: () => [...events] }, events,
    cancel() { this.canceled = true; abort.abort({ kind: 'user' }); } };
}
function fixture({ lock, enabled = true, deferStart = false, failedCleanup = false, deferCleanup = false, now } = {}) {
  const parent = agent('parent'), other = agent('other'), agents = new Map([[parent.id, parent], [other.id, other]]);
  const state = { requests: [], releases: 0, locks: 0, disposed: 0, errors: 0, enabled };
  const startReady = Promise.withResolvers(), cleanupReady = Promise.withResolvers();
  const service = createComputerTaskController({ agents, available: () => state.enabled, onError: () => state.errors++, now,
    lock: lock ?? (async () => { state.locks++; return async () => { state.releases++; }; }),
    subagents: { async startActivation(spec) {
      state.requests.push(spec); const child = agent(spec.childId, 'subagent');
      child.events.unshift({ seq: 0, type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: spec.provider } });
      agents.set(child.id, child); state.child = child;
      assert.equal(service.bindChild(child), true);
      if (deferStart) await startReady.promise;
      const completion = Promise.withResolvers(); let ended = false;
      state.finish = (stopReason = 'completed') => { ended = true; completion.resolve({ stopReason, output: [{ type: 'text', text: '已核实。' }] }); };
      return { childId: child.id, result: completion.promise, async dispose() {
        state.disposed++; if (!ended) state.finish('aborted'); if (deferCleanup) await cleanupReady.promise; if (failedCleanup) throw new Error('synthetic cleanup failure');
      } };
    } } });
  const exec = (who = parent, name = COMPUTER_TASK) => ({ agent: who, signal: who.phase.abort.signal, name });
  return { state, service, parent, other, exec, startReady, cleanupReady };
}
async function settled() { await tick(); await tick(); }

test('native spawn receives only the delegated task and inherits authority/model without overrides', async () => {
  const f = fixture(); f.parent.events.push({ type: 'assistant/message', seq: 2, data: { content: [{ type: 'image', data: 'parent-only-private-image' }] } });
  const result = await f.service.control(task, f.exec());
  const spec = f.state.requests[0]; assert.equal(spec.provider, COMPUTER_PROVIDER); assert.equal(spec.delivery, 'parent');
  assert.equal(spec.childId, result.childId); assert.equal(spec.request.parent, f.parent);
  assert.deepEqual(Object.keys(spec.request).sort(), ['parent', 'prompt']);
  assert(!JSON.stringify(spec.request.prompt).includes('parent-only-private-image'));
  assert.match(spec.request.prompt[0].text, /只向主会话提供简短结果/);
  assert.equal(f.service.activeTask().sessionId, f.state.child.id); assert.equal(f.service.activeTask().turn, 1);
  f.state.finish(); await settled(); assert.equal(f.service.activeTask(), undefined); assert.equal(f.state.releases, 1);
});

test('same-parent repeated starts share the activation; another conversation cannot acquire or read it', async () => {
  const f = fixture(); const first = await f.service.control(task, f.exec());
  const duplicate = await f.service.control(task, f.exec()); assert.equal(duplicate.childId, first.childId); assert.equal(f.state.requests.length, 1);
  await assert.rejects(f.service.control(task, f.exec(f.other)), /另一项电脑任务/);
  const otherStatus = await f.service.control({ action: 'status' }, f.exec(f.other)); assert.equal(otherStatus.childId, undefined);
  assert.equal(f.state.locks, 1); await f.service.close(); await settled(); assert.equal(f.state.releases, 1);
});

test('desktop guard accepts only the exact active child and rejects raw main, nested, and non-desktop child tools', async () => {
  const f = fixture(); assert.match(f.service.guard(f.exec(f.parent, click)), /独立子任务/);
  await f.service.control(task, f.exec());
  assert.equal(f.service.guard(f.exec(f.state.child, click)), undefined);
  assert.match(f.service.guard(f.exec({ ...f.state.child }, click)), /不能直接恢复/);
  assert.match(f.service.guard(f.exec(f.state.child, 'pwsh')), /只能使用/);
  assert.match(f.service.guard(f.exec(f.state.child, 'send_message')), /只能使用/);
  assert.match(f.service.guard(f.exec(f.state.child, COMPUTER_TASK)), /只能使用/);
  assert.match(f.service.guard(f.exec(f.parent, COMPUTER_PROGRESS)), /仅电脑专用/);
  await f.service.close();
});

test('Esc validates child/turn, blocks synchronously, and requires a new real human message before retry', async () => {
  const f = fixture(); await f.service.control(task, f.exec()); const child = f.state.child;
  assert.equal(f.service.stopFromDesktop({ sessionId: child.id, turn: 999 }), false);
  assert.equal(f.service.stopFromDesktop({ sessionId: f.parent.id, turn: 1 }), false);
  assert.equal(f.service.stopFromDesktop({ sessionId: child.id, turn: 1 }), true);
  assert.match(f.service.guard(f.exec(child, click)), /已停止/); assert.equal(f.service.activeTask(), undefined); assert.equal(child.canceled, true);
  await settled(); await assert.rejects(f.service.control(task, f.exec()), /等待新的用户消息/);
  f.parent.events.push({ ...human(2), data: { ...human(2).data, source: { kind: 'subagent-settled', rpcId: 'fake' } } });
  await assert.rejects(f.service.control(task, f.exec()), /等待新的用户消息/);
  f.parent.events.push(human(3)); await f.service.control(task, f.exec()); assert.equal(f.state.requests.length, 2); await f.service.close();
});

test('parent cancellation propagates while child is in reasoning; normal completion leaves no lock', async () => {
  const f = fixture(); await f.service.control(task, f.exec()); f.parent.cancel();
  assert.equal(f.state.child.canceled, true); assert.equal(f.service.activeTask(), undefined);
  await settled(); assert.equal(f.state.releases, 1);
});

test('late Esc after natural settlement still blocks the original human instruction', async () => {
  const f = fixture(); await f.service.control(task, f.exec()); const childId = f.state.child.id;
  f.state.finish(); await settled(); assert.equal(f.service.activeTask(), undefined);
  assert.equal(f.service.stopFromDesktop({ sessionId: childId, turn: 1 }), true);
  await assert.rejects(f.service.control(task, f.exec()), /等待新的用户消息/);
  assert.equal(f.state.requests.length, 1);
});

test('late Esc stops an already restarted task only when it uses the same old human instruction', async () => {
  const f = fixture(); await f.service.control(task, f.exec()); const old = f.state.child.id;
  f.state.finish(); await settled(); await f.service.control(task, f.exec()); const replacement = f.state.child;
  assert.equal(f.service.stopFromDesktop({ sessionId: old, turn: 1 }), true); assert.equal(replacement.canceled, true);
  await settled(); await assert.rejects(f.service.control(task, f.exec()), /等待新的用户消息/);
});

test('late Esc never cancels a replacement authorized by a newer genuine human message', async () => {
  const f = fixture(); await f.service.control(task, f.exec()); const old = f.state.child.id;
  f.state.finish(); await settled(); f.parent.events.push(human(2)); await f.service.control(task, f.exec()); const replacement = f.state.child;
  assert.equal(f.service.stopFromDesktop({ sessionId: old, turn: 1 }), true); assert.equal(replacement.canceled, undefined);
  assert.equal(f.service.activeTask().sessionId, replacement.id); await f.service.close();
});

test('Esc for an earlier published child turn remains effective after the child advances', async () => {
  const f = fixture(); await f.service.control(task, f.exec()); const child = f.state.child;
  assert.equal(f.service.activeTask().turn, 1); child.phase.turn = 2;
  f.service.observe(child.session, { type: 'turn/start', data: { turn: 2 } });
  assert.equal(f.service.stopFromDesktop({ sessionId: child.id, turn: 1 }), true); assert.equal(child.canceled, true); await settled();
});

test('durable provider descriptor rejects cold restoration and every alternate tool even after controller restart', async () => {
  const f = fixture(); await f.service.control(task, f.exec()); const original = f.state.child;
  f.state.finish(); await settled(); const restored = agent(original.id, 'subagent'); restored.events.unshift(original.events[0]);
  assert.throws(() => f.service.bindChild(restored), /不能直接恢复/);
  assert.match(f.service.guard(f.exec(restored, 'pwsh')), /不能直接恢复/);
  assert.match(f.service.guard(f.exec(restored, 'read')), /不能直接恢复/);
  const restarted = fixture(); assert.throws(() => restarted.service.bindChild(restored), /不能直接恢复/);
  assert.match(restarted.service.guard(restarted.exec(restored, 'send_message')), /不能直接恢复/);
  assert.match(restarted.service.guard(restarted.exec(restored, click)), /不能直接恢复/);
});

test('stop during publication cancels the reserved child and disposes when receipt arrives', async () => {
  const f = fixture({ deferStart: true }); const start = f.service.control(task, f.exec()); await tick();
  f.parent.cancel(); assert.equal(f.state.child.canceled, true); f.startReady.resolve();
  assert.equal((await start).status, 'stopped'); await settled(); assert.equal(f.state.releases, 1);
});

test('progress uses fixed Chinese tool labels and real successful calls, never inputs or image data', async () => {
  const f = fixture(); await f.service.control({ ...task, task: 'business-secret-password@example.com' }, f.exec()); const child = f.state.child;
  f.service.intent(child, 'verify'); assert.equal(f.service.progressFor(child.id).completedCount, 0);
  await assert.rejects(Promise.resolve().then(() => f.service.intent(child, 'private window title')), /可更新/);
  await f.service.dispatch({ ...f.exec(child, screenshot), arguments: { password: 'private-password' } }, async () => ({ isError: false, content: [{ type: 'image', data: 'private-pixels' }] }));
  await f.service.dispatch(f.exec(child, click), async () => ({ isError: true, content: [{ type: 'text', text: 'private-error' }] }));
  const p = f.service.progressFor(child.id); assert.equal(p.completedCount, 1); assert.deepEqual(p.completedSteps, ['查看当前界面']);
  assert.equal(p.currentStep, '核对操作结果 · 操作未成功，检查结果'); assert(!JSON.stringify(p).includes('private')); assert(!JSON.stringify(p).includes('business-secret'));
  assert.equal(p.description, '这一步未能顺利完成，正在检查原因。');
  await f.service.close();
});

test('actual STOPPED results cancel the child even without state-file notification', async () => {
  const f = fixture(); await f.service.control(task, f.exec()); const child = f.state.child;
  await f.service.dispatch(f.exec(child, click), async () => ({ isError: false, content: [{ type: 'text', text: 'COMPUTER_USE_STOPPED_BY_USER: user stopped' }] }));
  assert.equal(child.canceled, true); assert.equal(f.service.activeTask(), undefined); await settled();
  assert.equal(desktopStopped({ content: [{ type: 'image', data: 'COMPUTER_USE_STOPPED_BY_USER:' }] }), false);
});

test('parallel native calls are serialized; queued calls cannot run after stop', async () => {
  const f = fixture(); await f.service.control(task, f.exec()); const child = f.state.child;
  const first = Promise.withResolvers(), order = [];
  const a = f.service.dispatch(f.exec(child, click), async () => { order.push(1); return first.promise; });
  const b = f.service.dispatch(f.exec(child, click), async () => { order.push(2); return { isError: false }; });
  const rejected = assert.rejects(b);
  await tick(); assert.deepEqual(order, [1]); f.service.stopFromDesktop({ sessionId: child.id, turn: 1 });
  first.resolve({ isError: false }); await a; await rejected; assert.deepEqual(order, [1]); await settled();
});

test('unavailable plugin and startup failure cannot create a phantom active task', async () => {
  const f = fixture({ enabled: false }); await assert.rejects(f.service.control(task, f.exec()), /尚未启用/); assert.equal(f.state.locks, 0);
  const g = fixture({ lock: async () => { throw new Error('busy fixture'); } }); await assert.rejects(g.service.control(task, g.exec()), /busy fixture/); assert.equal(g.service.activeTask(), undefined);
  const child = agent('generic-child', 'subagent'); await assert.rejects(f.service.control(task, f.exec(child)), /主会话/);
});

test('cleanup failure keeps desktop admission closed', async () => {
  const f = fixture({ failedCleanup: true }); await f.service.control(task, f.exec()); f.state.finish(); await settled();
  assert.equal(f.state.releases, 0); assert.equal(f.service.activeTask(), undefined);
  assert.equal(f.service.presentationTask(), undefined);
  await assert.rejects(f.service.control(task, f.exec(f.other)), /另一项电脑任务/);
});

test('overlay titles are short and reject paths, credentials, control codes and contact data', () => {
  assert.equal(computerTaskTitle(' 打开浏览器查找资料 ', 'browser'), '打开浏览器查找资料');
  assert.equal([...computerTaskTitle('操作'.repeat(80), 'other')].length, 40);
  for (const value of ['密码 abc123', 'C:\\private\\report.xlsx', 'https://private.example', '张三 user@example.com', '13812345678', '<script>alert(1)</script>', 'hello\u001b[2J']) {
    assert.equal(computerTaskTitle(value, 'browser'), '处理网页任务');
  }
  assert.equal(computerTaskTitle(undefined, 'spreadsheet'), '处理表格');
});

test('presentation has concrete title and stage description, keeps intent between tool calls', async () => {
  const f = fixture(); await f.service.control({ ...task, title: '查找浏览器中的资料' }, f.exec()); const child = f.state.child;
  assert.equal(f.service.presentationTask().progress.task, '查找浏览器中的资料');
  assert.equal(f.service.presentationTask().progress.description, '准备开始本次电脑操作。');
  f.service.intent(child, 'browser'); assert.equal(f.service.presentationTask().progress.description, '查看已打开的窗口与可用浏览器。');
  f.service.intent(child, 'download'); assert.equal(f.service.presentationTask().progress.description, '查找下载入口并核对文件保存情况。');
  f.service.intent(child, 'search'); assert.equal(f.service.presentationTask().progress.description, '在浏览器中查找任务所需的信息。');
  const pending = Promise.withResolvers();
  const execution = f.service.dispatch(f.exec(child, screenshot), () => pending.promise); await tick();
  assert.equal(f.service.presentationTask().progress.currentStep, '搜索内容 · 查看当前界面');
  assert.equal(f.service.presentationTask().progress.description, '在浏览器中查找任务所需的信息。');
  pending.resolve({ isError: false }); await execution;
  assert.equal(f.service.presentationTask().progress.currentStep, '搜索内容 · 分析操作结果');
  assert.equal(f.service.presentationTask().progress.description, '正在查看操作结果，确认下一步。'); await f.service.close();
});

test('terminal presentation lasts two seconds after cleanup without desktop admission or lease', async () => {
  let now = 1000; const f = fixture({ now: () => now }); await f.service.control(task, f.exec()); const child = f.state.child;
  f.state.finish(); await settled(); assert.equal(f.state.releases, 1); assert.equal(f.service.activeTask(), undefined);
  const terminal = f.service.presentationTask(); assert.equal(terminal.progress.status, 'completed'); assert.equal(terminal.expiresAt, 3000);
  assert.equal(terminal.progress.description, '本次操作已结束，详细结果请查看主会话。');
  assert.match(f.service.guard(f.exec(child, click)), /不能直接恢复/);
  now = 2999; assert(f.service.presentationTask()); now = 3000; assert.equal(f.service.presentationTask(), undefined);
});

test('stop hides active task immediately but displays terminal only after native cleanup confirms', async () => {
  const f = fixture({ deferCleanup: true }); await f.service.control(task, f.exec()); const child = f.state.child;
  assert.equal(f.service.stopFromDesktop({ sessionId: child.id, turn: 1 }), true);
  assert.equal(f.service.activeTask(), undefined); assert.equal(f.service.presentationTask(), undefined); assert.equal(f.state.releases, 0);
  f.cleanupReady.resolve(); await settled(); assert.equal(f.state.releases, 1);
  assert.equal(f.service.presentationTask().progress.status, 'stopped'); assert.equal(f.service.activeTask(), undefined);
  await assert.rejects(f.service.control(task, f.exec()), /等待新的用户消息/);
});

test('OS lock excludes two controller processes by shared address and releases for a later task', async () => {
  const token = randomUUID(); const name = process.platform === 'win32' ? `\\\\.\\pipe\\rufa-test-${token}` : join(tmpdir(), `rufa-test-${token}.sock`);
  const release = await acquireDesktopLock(name);
  try {
    await assert.rejects(acquireDesktopLock(name), /另一项电脑任务/);
    const child = 'const {acquireDesktopLock}=await import(process.argv[1]);try{const release=await acquireDesktopLock(process.argv[2]);await release();}catch{process.exitCode=17;}';
    await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', child,
      new URL('../src/runtime/computer-task-controller.mjs', import.meta.url).href, name], { windowsHide: true }), { code: 17 });
  } finally { await release(); }
  const releaseAgain = await acquireDesktopLock(name); await releaseAgain();
});

test('routing hint follows the dedicated task entry and disappears when all computer tools are absent', () => {
  assert.match(computerUseContext([{ name: COMPUTER_TASK }])[0].text, /独立电脑子智能体/);
  assert.deepEqual(computerUseContext([]), []);
});
