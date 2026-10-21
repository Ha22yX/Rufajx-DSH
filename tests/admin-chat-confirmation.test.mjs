import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { confirmInChat } from '../apps/client/dist/chat-admin-confirmation.js';
import { initialPassword } from '../apps/client/dist/admin-tools.js';

test('initial passwords contain exactly ten random alphanumeric characters and both character types', () => {
  const values = new Set();
  for (let i = 0; i < 100; ++i) { const value = initialPassword(); assert.match(value, /^[A-Za-z0-9]{10}$/); assert.match(value, /[0-9]/); assert.match(value, /[A-Za-z]/); values.add(value); }
  assert.equal(values.size, 100);
});

test('real admin plugin binds a one-use IPC confirmation to its live chat and fails closed', { skip: !process.env.RUFA_RUNTIME_ROOT, timeout: 20000 }, async () => {
  let child, questionCount = 0, writes = 0;
  const approval = { title: '删除账号：测试员工', detail: '这只是隔离测试，不访问任何公司账号。', destructive: true };
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { /* consume without logging */ }
    const aborted = new AbortController();
    res.on('close', () => { if (!res.writableFinished) aborted.abort(); });
    const approved = await confirmInChat(child, approval, { id: req.headers['x-rufa-interaction'], signal: aborted.signal });
    if (approved) writes++;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ approved }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/admin-chat-probe.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, RUFA_BRIDGE_ORIGIN: `http://127.0.0.1:${server.address().port}`, RUFA_BRIDGE_TOKEN: 'isolated-fixture', RUFA_DEVICE_ID: 'fixture' },
  });
  const waitMessage = type => new Promise((resolve, reject) => {
    const listener = value => { if (value.type === type) { child.off('message', listener); resolve(value); } };
    child.on('message', listener); child.once('error', reject);
  });
  child.on('message', message => { if (message.type === 'test:question') questionCount++; });
  try {
    const ready = await waitMessage('test:ready');
    for (const schema of Object.values(ready.schemas)) {
      assert.equal(schema.properties.jobTitle.type, 'string');
      assert.equal(schema.required?.includes('jobTitle') ?? false, false);
    }
    assert.equal(await confirmInChat(child, approval), false);
    assert.equal(await confirmInChat(child, approval, { id: 'not-an-active-call', signal: new AbortController().signal }), false);
    // A forged but well-formed ID has no active tool context and cannot display or grant a question.
    assert.equal(await confirmInChat(child, approval, { id: '00000000-0000-0000-0000-000000000001', signal: new AbortController().signal }), false);
    assert.equal(questionCount, 0);
    for (const mode of ['cancel', 'unavailable', 'confirm', 'abort']) {
      const result = waitMessage('test:result'); child.send({ type: 'test:invoke', mode });
      const value = await result;
      if (mode !== 'abort') assert.equal(value.result.approved, mode === 'confirm');
    }
    assert.equal(writes, 1); assert.equal(questionCount, 4);
  } finally {
    const exited = once(child, 'exit'); child.kill(); await exited;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
