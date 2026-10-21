import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startWorkbenchFixture, until } from './fixtures/desktop-workbench.mjs';
import { importUpstream } from '../apps/client/src/runtime/import-upstream.mjs';

test('native user message time and copy icons work with plain, native-file and legacy OCR messages',
  { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 90000 }, async t => {
  const id = 'message-actions-fixture'; let original;
  const fixture = await startWorkbenchFixture(t, { prefix: 'rufa-message-actions-', seed: async ({ api, account }) => {
    const { Session } = await importUpstream('@deepseek-ai/dsh-session');
    const { createUserMessage } = await importUpstream('@deepseek-ai/dsh-llm');
    const header = { id, version: 4, createdAt: Date.now(), cwd: account.workspaceRoot, isSeeded: false, agentPreset: 'standard' };
    const session = Session.create(id, undefined, header);
    session.append('session/title', { title: '原版消息操作验收', messageSeqs: [], source: { kind: 'user' } });
    const messages = [
      [{ type: 'text', text: '普通消息复制验收' }],
      [{ type: 'text', text: '原生附件消息' }, { type: 'file', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), name: 'native-report.pdf', bytes: 1234 } }],
      [{ type: 'text', text: '旧版附件消息\n<attached_file name="legacy-report.txt" kind="text">\nPRIVATE_EXTRACT_DO_NOT_DISPLAY\n</attached_file>' }],
    ];
    for (const [index, content] of messages.entries()) {
      session.append('user/message', createUserMessage({ content, source: { kind: 'user' } }), { surfaceOp: 'append' });
      session.append('turn/start', { turn: index + 1 });
      session.append('turn/end', { turn: index + 1, reason: { kind: 'completed' } });
    }
    await api.json('POST', '/sessions', { id, title: '原版消息操作验收', upstreamHeader: header, workspaceRef: header.cwd });
    const lease = await api.json('POST', `/sessions/${id}/lease`, { deviceId: api.state.deviceId });
    await api.json('POST', `/sessions/${id}/events`, { leaseId: lease.leaseId, expectedNextSeq: 0, events: session.snapshotEvents().map(event => ({ seq: event.seq, event })) });
    await api.json('DELETE', `/sessions/${id}/lease`, { leaseId: lease.leaseId });
    original = (await api.json('GET', `/sessions/${id}/events`)).events;
  } });
  const ui = fixture.harness;
  try {
    await until(() => ui.evaluate(`(()=>{const e=document.querySelector('[data-row-key="session:${id}"]');if(e){e.click();return true;}document.querySelectorAll('[data-rufa-project-id] [data-row-key^="workspace:"][aria-expanded="false"]').forEach(row=>row.click());return false;})()`), 'fixture conversation selected');
    await until(() => ui.evaluate('document.querySelectorAll("[data-clock=start]").length===3'), 'three native user action bars');
    const actions = await ui.evaluate('[...document.querySelectorAll("[data-clock=start]")].map(e=>({time:e.querySelector("span")?.textContent,svg:!!e.querySelector("button[aria-label=复制] svg"),text:e.querySelector("button")?.textContent}))');
    assert.ok(actions.every(row => /\d{2}:\d{2}/.test(row.time) && row.svg && row.text === ''));
    assert.equal(await ui.evaluate('document.body.innerText.includes("复制 / Copy")'), false);
    assert.equal(await ui.evaluate('document.body.innerText.includes("PRIVATE_EXTRACT_DO_NOT_DISPLAY")'), false);
    assert.equal(await ui.evaluate('document.querySelectorAll("[data-message-attachments] [title=\\\"native-report.pdf\\\"]").length'), 1);
    assert.equal(await ui.evaluate('document.querySelectorAll("[data-message-attachments] [title=\\\"legacy-report.txt\\\"]").length'), 1);
    assert.equal(await ui.evaluate('document.body.innerText.includes("NaN")'), false);
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Set-Clipboard -Value 'Rufa-copy-before-fixture'"], { windowsHide: true });
    // Record the one-second native feedback in the page; CDP polling can miss it.
    await ui.call('Runtime.evaluate', { expression: `(()=>{
      const b=document.querySelector('[data-clock=start] button[aria-label="复制"]');
      window.__rufaCopyFeedback=[];
      const observer=new MutationObserver(()=>window.__rufaCopyFeedback.push({label:b.getAttribute('aria-label'),svg:b.innerHTML}));
      observer.observe(b,{attributes:true,childList:true,subtree:true});
      setTimeout(()=>observer.disconnect(),3000);b.click();
    })()`, userGesture: true, awaitPromise: true });
    await until(() => ui.evaluate('window.__rufaCopyFeedback?.some(e=>e.label==="复制成功")'), 'native copy success icon');
    // Read from the OS, so this test does not request browser clipboard-read permission.
    // Return only a boolean; never include arbitrary clipboard contents in diagnostics.
    const copied = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::Write((Get-Clipboard -Raw) -ceq '普通消息复制验收')"], { encoding: 'utf8', windowsHide: true });
    assert.equal(copied, 'True', 'System clipboard contains exactly the plain message text');
    assert.deepEqual((await fixture.api.json('GET', `/sessions/${id}/events`)).events, original, 'Display projection never rewrites stored history');
    await fixture.capture('native-message-actions');
    t.diagnostic(`Native clocks/copy SVG/system clipboard and native/legacy file cards verified: ${fixture.temporary}`);
  } catch (error) {
    t.diagnostic(`Artifacts: ${fixture.temporary}`);
    t.diagnostic(await ui.evaluate('JSON.stringify({clocks:document.querySelectorAll("[data-clock=start]").length,text:document.body.innerText})').catch(e => e.message));
    t.diagnostic(await ui.evaluate('JSON.stringify({focused:document.hasFocus(),secure:isSecureContext,visible:document.visibilityState})').catch(e => e.message));
    t.diagnostic(await ui.evaluate('JSON.stringify(window.__rufaCopyFeedback)').catch(e => e.message));
    await fixture.capture('failure').catch(e => t.diagnostic(e.message)); throw error;
  }
});
