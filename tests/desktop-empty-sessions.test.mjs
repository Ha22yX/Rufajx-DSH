import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startWorkbenchFixture, until, pause } from './fixtures/desktop-workbench.mjs';

test('leaving an empty desktop conversation removes only its local record and preserves drafts, attachments and submitted work',
  { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 180000 }, async t => {
  const fixture = await startWorkbenchFixture(t, { prefix: 'rufa-empty-sessions-' });
  let ui = fixture.harness;
  const evaluate = expression => ui.evaluate(expression);
  const selected = () => evaluate('JSON.parse(localStorage.getItem("dsh.sessions.current")||"{}").sessionId');
  const selectedReady = async () => until(async () => {
    const id = await selected();
    return id && await evaluate(`Boolean(document.querySelector('[data-conversation-session="${id}"] [contenteditable=true]'))`) && id;
  }, 'selected conversation composer');
  const create = async () => {
    const before = await selected();
    await evaluate('document.querySelector("button[aria-label=新建会话]").click()');
    await until(async () => { const current = await selected(); return current && current !== before; }, 'new selected conversation');
    return selectedReady();
  };
  const removed = async id => {
    await until(() => !fixture.cache().some(row => row.id === id), 'empty local record removed');
    assert.equal(await evaluate(`localStorage.getItem('dsh.conversation.${id}')`), null, 'Discard clears native draft state');
    const state = JSON.parse(await readFile(join(fixture.account.companyHome, 'browser-ui-state.json'), 'utf8'));
    assert.equal(state.entries[`dsh.conversation.${id}`], undefined, 'Discard clears account-local draft mirror');
  };
  const type = async text => {
    await selectedReady(); await evaluate('document.querySelector("[contenteditable=true]").focus()');
    await ui.call('Input.insertText', { text });
    await until(() => evaluate(`document.querySelector('[contenteditable=true]').textContent.includes(${JSON.stringify(text)})`), 'typed draft');
  };
  try {
    const first = await selectedReady();
    const second = await create(); await removed(first);
    const third = await create(); await removed(second);
    await type('   ');
    await evaluate('document.querySelector("button[aria-label=插件]").click()');
    await removed(third);
    assert.equal((await fixture.api.json('GET', '/sessions')).sessions.length, 0);
    assert.equal(fixture.cache().length, 0, 'Opening plugins leaves no local blank conversation');

    const draft = await create(); await type('未发送草稿需要保留');
    const empty = await create();
    assert.ok(fixture.cache().some(row => row.id === draft));
    await evaluate(`document.querySelector('[data-rufa-session-id="${draft}"]').click()`);
    await removed(empty);
    await until(() => evaluate('document.querySelector("[contenteditable=true]").textContent==="未发送草稿需要保留"'), 'saved draft restored');

    const attached = await create();
    const upload = join(fixture.temporary, 'keep-attachment.txt'); await writeFile(upload, 'Keep this unsent attachment.');
    await ui.call('DOM.enable');
    const document = await ui.call('DOM.getDocument');
    const { nodeId } = await ui.call('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'input[type=file][accept^=".pdf"]' });
    assert.ok(nodeId, 'OCR file input exists');
    await ui.call('DOM.setFileInputFiles', { nodeId, files: [upload] });
    await until(() => evaluate('Boolean(document.querySelector("[data-composer-chip=file-attachment]"))'), 'unsent file attachment');
    const fourth = await create();
    assert.ok(fixture.cache().some(row => row.id === attached), 'An unsent attachment is content');
    await evaluate('document.querySelector("button[aria-label=自动化任务]").click()'); await removed(fourth);
    assert.ok(fixture.cache().some(row => row.id === draft));
    assert.ok(fixture.cache().some(row => row.id === attached));

    const fifth = await create();
    await fixture.shell.evaluate('document.querySelector("#open-admin").click()'); await removed(fifth);
    await fixture.shell.evaluate('document.querySelector("#open-harness").click()');
    const submitted = await until(async () => { const id = await selected(); return id !== fifth && await selectedReady(); }, 'fresh conversation after reopening workbench');
    await type('这条已发送记录不能删除');
    await until(() => evaluate('Boolean(document.querySelector("button[aria-label=发送消息]:not(:disabled)"))'), 'send enabled');
    await evaluate('document.querySelector("button[aria-label=发送消息]").click()');
    await until(async () => {
      const events = (await fixture.api.json('GET', `/sessions/${submitted}/events`)).events;
      return events.some(row => row.event.type === 'turn/end');
    }, 'submitted work durably stored');
    const last = await create();
    assert.ok(fixture.cache().some(row => row.id === submitted), 'Submitted work remains after leaving');
    await evaluate(`document.querySelector('[data-rufa-session-id="${draft}"]').click()`); await removed(last);
    await pause(300);
    const before = fixture.cache().map(row => row.id).sort();
    ui = await fixture.restart();
    assert.deepEqual(fixture.cache().map(row => row.id).sort(), before, 'Deleted empty records cannot return from pending journals on restart');
    assert.equal((await fixture.api.json('GET', '/sessions')).sessions.length, 1, 'Only submitted work is on the server');
    const coldBlank = await create();
    ui = await fixture.restart();
    assert.equal(await selectedReady(), coldBlank, 'Existing local blank reopens without a live Agent');
    await evaluate(`document.querySelector('[data-rufa-session-id="${draft}"]').click()`);
    await removed(coldBlank);
    assert.deepEqual(fixture.cache().map(row => row.id).sort(), before, 'Previously saved cold blanks are also disposable');
    t.diagnostic(`Empty-navigation cleanup, draft/attachment protection and restart verified: ${fixture.temporary}`);
  } catch (error) {
    t.diagnostic(`Fixture artifacts: ${fixture.temporary}`);
    t.diagnostic(await evaluate('document.body.innerText').catch(() => 'UI unavailable'));
    await fixture.capture('failure').catch(() => {}); throw error;
  }
});
