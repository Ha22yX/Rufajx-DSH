import test from 'node:test';
import assert from 'node:assert/strict';
import { createVersionActivity } from '../src/runtime/file-version-activity.mjs';
import { importUpstream } from '../src/runtime/import-upstream.mjs';
const settle = () => new Promise(done => setImmediate(done));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('terminal observer does not confuse silence, timeout, stdin or an echoed wrapper with completion', async () => {
  const agent = { id: 'employee-session', status: 'idle' }, activity = createVersionActivity({ agents: { list: () => [agent] }, get: () => undefined });
  let result = { waitReason: 'inferred_idle', sessionStatus: { kind: 'running' } }, output = '';
  const native = { async spawn() { return { sessionId: 'terminal-a' }; }, startSend() { return { done: Promise.resolve(result) }; }, read() { return { text: output }; }, async kill() {} };
  const off = activity.watchTerminals(native);
  await native.spawn(agent, { cwd: 'C:/fixture' });
  const nonce = '12345678-1234-1234-1234-123456789012';
  const wrapper = `Write-Output '__DSH_PERSISTENT_PWSH_START_${nonce}__'; fixture; Write-Output ('__DSH_PERSISTENT_PWSH_END_${nonce}:' + $__s)`;
  for (const waitReason of ['inferred_idle', 'timeout', 'stdin_read']) {
    result = { ...result, waitReason }; const operation = activity.run({ name: 'pwsh', agent }, () => native.startSend(agent, 'terminal-a', { text: wrapper }));
    await operation.done; await settle(); assert.equal(activity.busy(), true);
    output = wrapper + '\r\n'; native.read(agent, 'terminal-a'); assert.equal(activity.busy(), true);
  }
  output = `__DSH_PERSISTENT_PWSH_END_${nonce}:0\r\nPS>`;
  native.read(agent, 'terminal-a'); assert.equal(activity.busy(), false);
  native.startSend(agent, 'terminal-a', { text: wrapper }); await settle(); native.read(agent, 'terminal-a');
  assert.equal(activity.busy(), true, 'a raw terminal caller cannot forge the native pwsh completion marker');
  native.startSend(agent, 'terminal-a', { text: 'another foreground command' }); await settle();
  assert.equal(activity.busy(), true); await native.kill(agent, 'terminal-a'); assert.equal(activity.busy(), false);
  native.startSend(agent, 'terminal-b', { text: 'quiet write' }); await settle();
  result = { waitReason: 'session_exit', sessionStatus: { kind: 'exited' } };
  await native.startSend(agent, 'terminal-b', { text: '' }).done; await settle(); assert.equal(activity.busy(), false); off();
});

test('real native Jobs registry blocks running/stopping and only releases after the native producer reports completion', { skip: !process.env.RUFA_RUNTIME_ROOT }, async t => {
  const [{ Context }, { default: Jobs }] = await Promise.all([importUpstream('@deepseek-ai/cordis'), importUpstream('@deepseek-ai/dsh-jobs-local')]);
  const ctx = new Context(); await ctx.plugin(Jobs);
  ctx.jobs.attachController('isolated version test');
  ctx.provide('agents', { list: () => [] });
  const activity = createVersionActivity(ctx), off = activity.watchJobs(ctx.jobs);
  t.after(async () => { off(); await ctx.fiber.dispose(); });
  const complete = defer();
  const id = ctx.jobs.start({ kind: 'pwsh', label: 'controlled native producer', run: () => ({ done: complete.promise, cancel() {} }) });
  assert.equal(ctx.jobs.get(id).status, 'running'); assert.equal(activity.busy(), true);
  ctx.jobs.kill(id, undefined, 'test cancel'); assert.equal(ctx.jobs.get(id).status, 'stopping'); assert.equal(activity.busy(), true);
  complete.resolve({ status: 'killed' }); await settle(); assert.equal(activity.busy(), false);
  const failure = defer();
  const failedId = ctx.jobs.start({ kind: 'bash', label: 'uncertain producer', run: () => ({ done: failure.promise, cancel() {} }) });
  failure.reject(new Error('producer exit unconfirmed')); await settle(); assert.equal(ctx.jobs.get(failedId).status, 'failed');
  assert.equal(activity.busy(), true); ctx.jobs.remove(failedId); assert.equal(activity.busy(), true);
});

test('real native background PTY job remains busy after silence and releases after successful terminal close', { skip: !process.env.RUFA_RUNTIME_ROOT }, async t => {
  const [{ Context }, { default: Jobs }] = await Promise.all([importUpstream('@deepseek-ai/cordis'), importUpstream('@deepseek-ai/dsh-jobs-local')]);
  const ctx = new Context(); await ctx.plugin(Jobs); ctx.jobs.attachController('isolated pty test');
  const agent = { id: 'session-a', status: 'idle' }; ctx.provide('agents', { list: () => [agent] });
  const activity = createVersionActivity(ctx), offJobs = activity.watchJobs(ctx.jobs);
  const native = { async spawn() { return { sessionId: 'terminal-a' }; }, startSend() { return { done: Promise.resolve({ waitReason: 'inferred_idle' }) }; }, read() { return { text: '' }; }, async kill() {} };
  const offTerminals = activity.watchTerminals(native); await native.spawn(agent, { cwd: 'C:/fixture' });
  t.after(async () => { offTerminals(); offJobs(); await ctx.fiber.dispose(); });
  assert.throws(() => activity.terminalDirectory({ id: 'session-b' }, 'terminal-a'), /不属于/);
  assert.throws(() => activity.terminalDirectory(agent, 'unknown-terminal'), /不属于/);
  assert.equal(activity.terminalDirectory(agent, 'terminal-a'), 'C:/fixture');
  const id = ctx.jobs.start({ kind: 'pty-send', label: 'controlled native pty', run: () => {
    const operation = native.startSend(agent, 'terminal-a', { text: 'quiet foreground' });
    return { done: operation.done.then(() => ({ status: 'completed' })), cancel() {} };
  } });
  await settle(); assert.equal(ctx.jobs.get(id).status, 'completed'); assert.equal(activity.busy(), true);
  await native.kill(agent, 'terminal-a'); assert.equal(activity.busy(), false);
});

test('an existing terminal at observer reload is not assumed idle without completion evidence', async () => {
  const owner = { id: 'session-a', status: 'idle' }; let terminals = [{ sessionId: 'old-terminal', status: { kind: 'running' } }];
  const native = { list: () => terminals, async spawn() {}, startSend() {}, read() {}, async kill() { terminals = []; } };
  const activity = createVersionActivity({ agents: { list: () => [owner], get: () => owner }, get: name => name === 'terminals' ? native : undefined });
  const off = activity.watchTerminals(native);
  assert.equal(activity.busy(), true); await native.kill(owner, 'old-terminal'); assert.equal(activity.busy(), false); off();
});
