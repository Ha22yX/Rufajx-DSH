import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startWorkbenchFixture, until } from './fixtures/desktop-workbench.mjs';
import { importUpstream } from '../apps/client/src/runtime/import-upstream.mjs';
import { createFileVersionStore } from '../apps/client/src/runtime/file-version-store.mjs';
import { createVersionScopes } from '../apps/client/src/runtime/file-version-tracking.mjs';

// Real desktop/IPC/native Session rendering with a synthetic employee account.
// Store seeding here is paired with file-version-tracking's native tool execution
// tests; this fixture never pretends that seeded events executed model tools.
test('employees compare Office versions, safely restore and undo from native deliverable cards',
  { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 150000 }, async t => {
  const id = 'file-versions-fixture';
  let path, original, edited, external, version1, version2, seq;
  const fixture = await startWorkbenchFixture(t, { prefix: 'rufa-file-versions-', role: 'employee', visibleWindow: true,
    seed: async ({ api, account, temporary }) => {
      const directory = join(temporary, 'documents'); await mkdir(directory);
      execFileSync(join(process.env.RUFA_TEST_RUNTIME_ROOT, 'company-python/python.exe'),
        ['-I', '-B', fileURLToPath(new URL('./fixtures/file-version-documents.py', import.meta.url)), directory], { windowsHide: true });
      path = join(account.workspaceRoot, '项目报价.xlsx');
      original = await readFile(join(directory, 'excel-1.blob'));
      edited = await readFile(join(directory, 'excel-2.blob'));
      // A distinct valid Office version simulates an external save between the
      // employee's preview and confirmation. Its exact bytes must survive.
      external = await readFile(join(directory, 'excel-external.blob'));
      const scopes = await createVersionScopes({ accountHome: account.companyHome,
        privateRoot: dirname(dirname(account.companyHome)), runtimeRoot: process.env.RUFA_TEST_RUNTIME_ROOT });
      await scopes.grant(id, account.workspaceRoot, 'directory');
      const store = await createFileVersionStore({ directory: join(account.companyHome, 'file-versions'),
        allowedRoots: sessionId => scopes.roots(sessionId), privateRoots: [process.env.RUFA_TEST_RUNTIME_ROOT] });
      try {
        await writeFile(path, original);
        version1 = await store.capture(path, { sessionId: id, operationId: 'fixture-edit', phase: 'before', tool: 'pwsh' });
        await writeFile(path, edited);
        version2 = await store.capture(path, { sessionId: id, operationId: 'fixture-edit', phase: 'after', tool: 'pwsh', status: 'completed' });
      } finally { await store.close(); }
      const { Session } = await importUpstream('@deepseek-ai/dsh-session');
      const { createUserMessage, createAssistantMessage } = await importUpstream('@deepseek-ai/dsh-llm');
      const header = { id, version: 4, createdAt: Date.now(), cwd: account.workspaceRoot, isSeeded: false, agentPreset: 'standard' };
      const session = Session.create(id, undefined, header);
      session.append('session/title', { title: '项目报价调整', messageSeqs: [], source: { kind: 'user' } });
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '将项目报价调整为 1200 元。' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
      session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 });
      seq = session.append('deliverables/presented', { turn: 1, callId: 'present-fixture', files: [{ path, description: '项目报价已调整，原文件版本已保留。' }] }).seq;
      session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
        source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: '已更新项目报价表。可以在文件卡片中查看改动，或找回以前的版本。' }] }) }, { surfaceOp: 'append' });
      session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      await api.json('POST', '/sessions', { id, title: '项目报价调整', upstreamHeader: header, workspaceRef: header.cwd });
      const lease = await api.json('POST', `/sessions/${id}/lease`, { deviceId: api.state.deviceId });
      await api.json('POST', `/sessions/${id}/events`, { leaseId: lease.leaseId, expectedNextSeq: 0,
        events: session.snapshotEvents().map(event => ({ seq: event.seq, event })) });
      await api.json('DELETE', `/sessions/${id}/lease`, { leaseId: lease.leaseId });
    } });
  const coordinates = { sessionId: id, seq, index: 0, kind: 'present' };
  const bridge = (action, input) => fixture.harness.evaluate(`window.rufaAccount.fileVersions(${JSON.stringify(action)},${JSON.stringify(input)})`);
  const click = selector => fixture.harness.evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled)return false;button.click();return true;})()`);
  const versionAction = async (versionId, action) => {
    await until(() => click('[data-rufa-version-tab="history"]'), 'history tab');
    await until(() => click(`[data-rufa-version-row="${versionId}"]`), 'version selected');
    await until(() => fixture.harness.evaluate(`document.querySelector('[data-rufa-version-row="${versionId}"]')?.getAttribute('aria-pressed')==='true'`), 'selection rendered');
    await until(() => click(`[data-rufa-version-${action}]`), `version ${action}`);
  };
  const openHistory = async () => {
    await until(() => fixture.harness.evaluate(`(()=>{const e=document.querySelector('[data-row-key="session:${id}"]');if(e){e.click();return true;}document.querySelectorAll('[data-rufa-project-id] [data-row-key^="workspace:"][aria-expanded="false"]').forEach(row=>row.click());return false;})()`), 'fixture conversation selected');
    await until(() => click('[data-rufa-versions-action]'), 'history action');
    await until(() => fixture.harness.evaluate('Boolean(document.querySelector("[data-rufa-versions-panel]"))'), 'file changes shown');
  };
  try {
    await openHistory();
    // The employee sees useful differences immediately, without selecting a
    // version and then pressing a second comparison button.
    await until(() => fixture.harness.evaluate('document.querySelector("[data-rufa-version-diff]")?.textContent.includes("1200")'), 'human-readable Excel comparison');
    const comparison = await fixture.harness.evaluate('document.querySelector("[data-rufa-version-diff]").textContent');
    assert.match(comparison, /销售/); assert.match(comparison, /B2/); assert.match(comparison, /1000/);
    assert.match(comparison, /1200/);
    assert.equal(/\b(?:commit|sha256|checkout)\b/i.test(await fixture.harness.evaluate('document.querySelector("[data-rufa-versions-panel]").textContent')), false);
    await fixture.capture('excel-version-comparison');

    // File content changing after confirmation preparation must never be overwritten.
    await until(() => click('[data-rufa-version-undo]'), 'undo latest modification');
    await until(() => fixture.harness.evaluate('Boolean(document.querySelector("[data-rufa-version-confirm]"))'), 'inline confirmation');
    assert.match(await fixture.harness.evaluate('document.querySelector("[data-rufa-versions-panel]").textContent'), /当前|现在/);
    await writeFile(path, external);
    const outsideChange = await bridge('history', coordinates);
    assert.equal(outsideChange.value.tree.currentState, 'changed');
    assert.equal(outsideChange.value.tree.currentId, null, 'external bytes never get an old current-version badge');
    await click('[data-rufa-version-confirm]');
    await until(() => fixture.harness.evaluate('/变化|改变/.test(document.querySelector("[data-rufa-versions-panel]")?.textContent??"")'), 'restore conflict notice');
    assert.deepEqual(await readFile(path), external, 'external save survives stale confirmation');

    // A fresh deliberate confirmation backs up that external save before restoring.
    await versionAction(version1.id, 'restore');
    await until(() => click('[data-rufa-version-confirm]'), 'confirm fresh restore');
    await until(async () => (await readFile(path)).equals(original), 'original Office bytes restored');
    await until(() => fixture.harness.evaluate('!document.querySelector("[data-rufa-version-restore]")?.disabled && document.querySelector("[data-rufa-version-notice]")?.textContent.includes("已恢复")'), 'first restore and history refresh completed');
    const history = await bridge('history', coordinates);
    assert.equal(history.ok, true);
    const beforeRestore = history.value.versions.find(row => row.label === '恢复前保留');
    assert.ok(beforeRestore, 'current version retained before restore');
    const restoredNode = history.value.tree.nodes.find(row => row.kind === 'restored');
    assert.ok(restoredNode);
    assert.equal(restoredNode.parentId, version1.id, 'restoration branches from its exact source');
    assert.equal(restoredNode.compareBeforeId, beforeRestore.id, 'restore comparison uses actual pre-restore bytes');
    assert.equal(history.value.tree.nodes.find(row => row.id === version2.id).parentId, version1.id, 'original route remains beside the restored route');
    assert.equal(history.value.tree.currentId, restoredNode.id);
    await until(() => fixture.harness.evaluate(`document.querySelector('[data-rufa-version-edge="${restoredNode.id}"]')?.getAttribute('data-parent-version')===${JSON.stringify(version1.id)} && document.querySelectorAll('[data-current-version="true"]').length===1`), 'actual restore branch rendered');
    await until(() => fixture.harness.evaluate(`document.querySelector('[data-rufa-version-row="${restoredNode.id}"]')?.getAttribute('aria-pressed')==='true'`), 'restored node selected');
    const geometry = await fixture.harness.evaluate(`(()=>{
      const nodes=[...document.querySelectorAll('[data-rufa-version-row]')].map(e=>({id:e.dataset.rufaVersionRow,r:e.getBoundingClientRect().toJSON()}));
      return {nodes,overlap:nodes.some((a,i)=>nodes.slice(i+1).some(b=>a.r.left<b.r.right&&a.r.right>b.r.left&&a.r.top<b.r.bottom&&a.r.bottom>b.r.top))};
    })()`);
    assert.equal(geometry.overlap, false, 'tree node cards have separate readable positions');
    await until(() => fixture.harness.evaluate('document.querySelector("[data-rufa-version-diff]")?.textContent.includes("1500")'), 'restored node compares against actual previous file');
    await fixture.capture('version-branches');
    await versionAction(beforeRestore.id, 'restore');
    await until(() => click('[data-rufa-version-confirm]'), 'confirm undo');
    await until(async () => (await readFile(path)).equals(external), 'undo recovers exact previous bytes');
    await until(() => fixture.harness.evaluate('!document.querySelector("[data-rufa-version-restore]")?.disabled && document.querySelector("[data-rufa-version-notice]")?.textContent.includes("已恢复")'), 'restore UI settled');
    await fixture.capture('restore-history');
    const secondHistory = await bridge('history', coordinates);
    const secondRestore = secondHistory.value.tree.nodes.at(-1);
    assert.equal(secondRestore.kind, 'restored');
    assert.equal(secondRestore.parentId, beforeRestore.id, 'restoring the backup creates its own exact branch');
    assert.equal(secondHistory.value.tree.currentId, secondRestore.id);
    assert.ok(secondHistory.value.tree.nodes.some(row => row.id === restoredNode.id), 'older restored branch is preserved');
    await fixture.harness.evaluate(`document.querySelector('[data-rufa-version-row="${secondRestore.id}"]').focus()`);
    await fixture.harness.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await fixture.harness.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await until(() => fixture.harness.evaluate(`document.querySelector('[data-rufa-version-row="${beforeRestore.id}"]')?.getAttribute('aria-pressed')==='true'`), 'keyboard selects parent branch');
    await until(() => fixture.harness.evaluate('document.querySelector("[data-rufa-version-diff]")?.textContent.includes("1500")'), 'keyboard-selected comparison ready');
    try {
      await fixture.harness.call('Emulation.setDeviceMetricsOverride', { width: 620, height: 900, deviceScaleFactor: 1, mobile: false });
      await until(() => fixture.harness.evaluate('innerWidth===620'), 'narrow version dialog');
      const narrow = await fixture.harness.evaluate(`(()=>{const dialog=document.querySelector('[data-rufa-versions-panel]').getBoundingClientRect(),viewport=document.querySelector('.rufa-version-tree-viewport');return {left:dialog.left,right:dialog.right,width:innerWidth,scrollable:getComputedStyle(viewport).overflowX};})()`);
      assert.ok(narrow.left >= 0 && narrow.right <= narrow.width);
      assert.equal(narrow.scrollable, 'auto');
      await fixture.capture('version-branches-narrow');
    } finally { await fixture.harness.call('Emulation.clearDeviceMetricsOverride'); }

    for (const bad of [{ ...coordinates, index: 999 }, { ...coordinates, seq: seq - 1 }, { ...coordinates, sessionId: 'other-account-session' }]) {
      assert.equal((await bridge('history', bad)).ok, false, 'forged file coordinates cannot access history');
    }
    assert.equal((await bridge('restore', { ticketId: 'not-a-confirmation' })).ok, false);
    await fixture.restart();
    await openHistory();
    const restarted = await bridge('history', coordinates);
    assert.equal(restarted.ok, true); assert.ok(restarted.value.versions.some(row => row.id === beforeRestore.id));
    assert.deepEqual(restarted.value.tree.nodes.map(({ id, parentId }) => ({ id, parentId })), secondHistory.value.tree.nodes.map(({ id, parentId }) => ({ id, parentId })), 'branch ancestry survives restart');
    assert.equal(restarted.value.tree.currentId, secondRestore.id);
    assert.deepEqual(await readFile(path), external);
    await click('[aria-label="关闭历史版本"]');
    await until(() => fixture.harness.evaluate('!document.querySelector("[data-rufa-versions-panel]")'), 'history dialog closed');
    // Native application discovery is asynchronous after restart. Capture the
    // settled file action rather than its temporary gray icon placeholder.
    await until(() => fixture.harness.evaluate(`(()=>{
      const actions=[...document.querySelectorAll('[data-open-target="file"]')];
      return actions.length>0 && actions.every(action=>
        !action.querySelector('[data-open-target-skeleton]') &&
        !action.querySelector('[data-open-path-open]')?.disabled &&
        [...action.querySelectorAll('img')].every(image=>image.complete && image.naturalWidth>0));
    })()`), 'native file application icons ready');
    await fixture.capture('deliverable-card');
    assert.equal(fixture.gatewayCalls, 0, 'history, comparison and restoration never call a model');
    t.diagnostic(`Real employee Electron branching tree/diff/conflict/restore/undo/keyboard/narrow layout/restart verified: ${fixture.temporary}`);
  } catch (error) {
    t.diagnostic(`Artifacts: ${fixture.temporary}`);
    t.diagnostic(await fixture.harness.evaluate('document.body.innerText').catch(e => e.message));
    t.diagnostic(JSON.stringify(fixture.harness.errors));
    await fixture.capture('failure').catch(() => {}); throw error;
  }
});
