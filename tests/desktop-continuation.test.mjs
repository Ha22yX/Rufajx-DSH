// Isolated real Electron UI + native Harness + local company SQLite. No paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { buildApp } from '../apps/server/dist/app.js';
import { configFromEnv } from '../apps/server/dist/config.js';
import { SqliteStore } from '../apps/server/dist/sqlite-store.js';
import { hashPassword } from '../apps/server/dist/security.js';
import { CompanyApi } from '../apps/client/dist/company-api.js';
import { accountRuntimePaths } from '../apps/client/dist/runtime-configuration.js';
import { checkMediaPreviewUi } from './fixtures/media-ui-check.mjs';

test('desktop continues stopped history, preserves normal send and exposes Better Sidebar settings', { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 180000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'rufa-desktop-continuation-'));
  const store = SqliteStore.open(join(temporary, 'company.sqlite'));
  const password = 'Synthetic-continuation-2026'; // gitleaks:allow -- disposable local test account
  const user = await store.createUser({ username: 'resume-test', displayName: '恢复验收', role: 'admin', passwordHash: await hashPassword(password) }, true);
  const server = buildApp(store, configFromEnv({}), () => store.ping());
  let gatewayCalls = 0;
  server.addHook('onRequest', async (request, reply) => {
    if (request.url.includes('/gateway/')) {
      gatewayCalls++;
      // Refuse before gateway routing; no request can reach an external model.
      reply.code(400).send({ error: { code: 'FIXTURE_ONLY', message: 'Synthetic model refusal' } });
    }
  });
  const endpoint = await server.listen({ host: '127.0.0.1', port: 0 });
  const api = new CompanyApi({ read: async () => null, write: async () => {}, clear: async () => {} }, true);
  await api.login(endpoint, 'resume-test', password);
  const profile = join(temporary, 'desktop-profile');
  const account = accountRuntimePaths(join(profile, 'accounts'), endpoint, user.id);
  await mkdir(account.workspaceRoot, { recursive: true });
  const { importUpstream } = await import('../apps/client/src/runtime/import-upstream.mjs');
  const { Session } = await importUpstream('@deepseek-ai/dsh-session');
  const { createUserMessage } = await importUpstream('@deepseek-ai/dsh-llm');
  const originalHistory = new Map();
  for (const [id, title, reason] of [['stopped-fixture', '手动停止验收', 'aborted'], ['crashed-fixture', '意外退出验收', null], ['completed-fixture', '完成状态验收', 'completed']]) {
    const header = { id, version: 4, createdAt: Date.now(), cwd: account.workspaceRoot, isSeeded: false, agentPreset: 'standard' };
    const session = Session.create(id, undefined, header);
    session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } });
    const text = reason === 'completed' ? `${title}\n${Array.from({ length: 90 }, (_, i) => `第 ${i + 1} 行：合成办公文档内容，仅用于长历史布局验收。`).join('\n')}` : title;
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    session.append('turn/start', { turn: 1 });
    if (reason) session.append('turn/end', { turn: 1, reason: reason === 'aborted' ? { kind: reason, reason: { kind: 'user' } } : { kind: reason } });
    await api.json('POST', '/sessions', { id, title, upstreamHeader: header, workspaceRef: header.cwd });
    const lease = await api.json('POST', `/sessions/${id}/lease`, { deviceId: api.state.deviceId });
    await api.json('POST', `/sessions/${id}/events`, { leaseId: lease.leaseId, expectedNextSeq: 0, events: session.snapshotEvents().map(event => ({ seq: event.seq, event })) });
    await api.json('DELETE', `/sessions/${id}/lease`, { leaseId: lease.leaseId });
    originalHistory.set(id, { header, events: (await api.json('GET', `/sessions/${id}/events`)).events });
  }
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const clientRoot = resolve(process.env.RUFA_TEST_CLIENT_ROOT || 'apps/client');
  const env = { ...process.env, RUFA_TEST_USER_DATA: profile, RUFA_TEST_SERVER_URL: endpoint, RUFA_TEST_HIDE_WINDOW: '1', RUFA_TEST_DIAGNOSTIC: '1', RUFA_UPSTREAM_ROOT: process.env.RUFA_TEST_RUNTIME_ROOT || join(clientRoot, 'runtime') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolve('node_modules/electron/dist/electron.exe'), [clientRoot, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-background-media-suspend', '--autoplay-policy=no-user-gesture-required'], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let runtimeDiagnostics = '';
  child.stderr.on('data', chunk => { runtimeDiagnostics = (runtimeDiagnostics + chunk).slice(-48000); });
  const sockets = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = await fn().catch(() => null); if (result) return result; await pause(100); }
    throw new Error(`Timed out: ${label}`);
  }
  async function connect(predicate) {
    const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(predicate), 'desktop page');
    const ws = new WebSocket(target.webSocketDebuggerUrl); sockets.push(ws);
    await once(ws, 'open');
    let serial = 0; const pending = new Map();
    ws.addEventListener('message', event => { const value = JSON.parse(event.data), waiter = pending.get(value.id); if (waiter) { pending.delete(value.id); clearTimeout(waiter.timer); value.error ? waiter.reject(new Error(value.error.message)) : waiter.resolve(value.result); } });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 10000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const value = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails)); return value.result.value; };
    return { call, evaluate };
  }
  let shell, harness;
  try {
    shell = await connect(target => target.type === 'page' && target.url.endsWith('/renderer/index.html'));
    await until(() => shell.evaluate('window.rufa.call("state").then(r=>!r.value.booting)'), 'login ready');
    await shell.evaluate(`document.querySelector('#username').value='resume-test';document.querySelector('#username').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#password').value=${JSON.stringify(password)};document.querySelector('#password').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit();`);
    await until(() => shell.evaluate('window.rufa.call("state").then(r=>r.value.harness.status==="running")'), 'Harness running', 60000);
    harness = await connect(target => target.type === 'page' && target.url.startsWith('http://127.0.0.1:'));
    await until(() => harness.evaluate('document.documentElement.dataset.rufaStartup==="ready"'), 'startup ready');
    const select = async title => {
      const id = { '手动停止验收': 'stopped-fixture', '完成状态验收': 'completed-fixture', '意外退出验收': 'crashed-fixture' }[title];
      await until(() => harness.evaluate(`(()=>{const e=document.querySelector('[data-row-key="session:${id}"]');if(e){e.click();return true;}document.querySelectorAll('[data-rufa-project-id] [data-row-key^="workspace:"][aria-expanded="false"]').forEach(row=>row.click());return false;})()`), `session ${title}`);
      await pause(300);
    };
    const continues = () => harness.evaluate('Boolean(document.querySelector("button[aria-label=继续任务]:not(:disabled)"))');
    await select('手动停止验收');
    await until(continues, 'manual stopped play button');
    for (const [id, original] of originalHistory) {
      assert.deepEqual((await api.json('GET', `/sessions/${id}`)).session.upstreamHeader, original.header, 'Project migration must retain original history cwd and header');
      assert.deepEqual((await api.json('GET', `/sessions/${id}/events`)).events, original.events, 'Cold history navigation must not rewrite the log');
    }
    await harness.evaluate('document.querySelector("[data-composer-card] button[aria-haspopup=listbox][class$=_add]").click()');
    await until(() => harness.evaluate('document.querySelectorAll("[data-trigger-menu] [role=option] [class$=_itemAlias]").length===3'), 'commands load after opening the plus menu');
    assert.deepEqual(await harness.evaluate('[...document.querySelectorAll("[data-trigger-menu] [role=option] [class$=_itemAlias]")].map(e=>e.textContent)'), ['file', 'goal', 'plan']);
    await harness.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await harness.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await harness.evaluate('document.querySelector("button[aria-label=继续任务] svg path").getAttribute("d")'), 'M5 2.5v11L13 8Z');
    const capture = await harness.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(temporary, 'continue-button.png'), Buffer.from(capture.data, 'base64'));
    await harness.evaluate('document.querySelector("[contenteditable=true]").focus()');
    await harness.call('Input.insertText', { text: '新的任务' });
    await until(async () => !(await continues()), 'text switches to normal send');
    assert.equal(await harness.evaluate('Boolean(document.querySelector("[data-composer-card] button[aria-label=发送消息]:not(:disabled)"))'), true);
    await harness.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await harness.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await harness.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await until(continues, 'empty restores play');
    const firstFile = join(temporary, 'first.txt'), secondFile = join(temporary, 'second.txt');
    await writeFile(firstFile, 'Synthetic office fixture one'); await writeFile(secondFile, 'Synthetic office fixture two');
    await harness.call('DOM.enable');
    const { root } = await harness.call('DOM.getDocument');
    const { nodeId } = await harness.call('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept^=".pdf"]' });
    assert.ok(nodeId, 'OCR file picker must load');
    assert.equal(await harness.evaluate('Boolean(document.querySelector("button[aria-label=\\\"添加文件 / Add file\\\"]"))'), false, 'Duplicate upload shortcut stays removed');
    await harness.call('DOM.setFileInputFiles', { nodeId, files: [firstFile, secondFile] });
    const attachmentCount = () => harness.evaluate('document.querySelectorAll("[aria-label=\\\"已添加的文件 / Added files\\\"] button[aria-label^=\\\"移除 / Remove\\\"]").length');
    await until(async () => (await attachmentCount()) === 2, 'two OCR attachment cards');
    assert.equal(await continues(), false, 'Attachments must use ordinary send');
    const removeAttachment = () => harness.evaluate('document.querySelector("[aria-label=\\\"已添加的文件 / Added files\\\"] button[aria-label^=\\\"移除 / Remove\\\"]").click()');
    await removeAttachment(); await until(async () => (await attachmentCount()) === 1, 'independent attachment removal');
    assert.equal(await harness.evaluate('document.querySelectorAll("[data-composer-chip=file-attachment]").length'), 1);
    await removeAttachment(); await until(continues, 'removed attachments restore empty continuation');
    assert.equal(await harness.evaluate('document.querySelector("[contenteditable=true]").textContent.trim()'), '');
    const dragVisible = () => harness.evaluate('[...document.querySelectorAll("[role=status]")].some(e=>e.textContent.includes("拖放文件以上传"))');
    for (const reset of [
      'document.dispatchEvent(new DragEvent("drop",{bubbles:true,dataTransfer:new DataTransfer()}))',
      'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',
      'window.dispatchEvent(new Event("blur"))',
      'document.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))',
      'window.dispatchEvent(new Event("dragend"))',
    ]) {
      await harness.evaluate('(()=>{const data=new DataTransfer();data.items.add(new File(["fixture"],"fixture.txt",{type:"text/plain"}));document.dispatchEvent(new DragEvent("dragenter",{bubbles:true,dataTransfer:data}));})()');
      await until(dragVisible, 'drag overlay shown');
      await harness.evaluate(reset); await until(async () => !(await dragVisible()), 'drag overlay dismissed');
    }
    await select('完成状态验收'); assert.equal(await continues(), false);
    const layout = () => harness.evaluate(`(()=>{const card=document.querySelector('[data-composer-card]'),body=card.closest('[class$=_scrollBody]'),seat=card.closest('[class$=_composerSeat]');const c=card.getBoundingClientRect(),b=body.getBoundingClientRect();return {top:c.top,bottom:c.bottom,bodyTop:b.top,bodyBottom:b.bottom,seat:seat.offsetHeight,viewport:innerHeight,scroll:body.scrollTop,range:body.scrollHeight-body.clientHeight};})()`);
    const assertLayout = async label => {
      const value = await layout();
      assert.ok(value.top >= value.bodyTop - 1 && value.bottom <= Math.min(value.bodyBottom, value.viewport) + 1, `${label}: ${JSON.stringify(value)}`);
    };
    for (const [width, height] of [[1364, 813], [1000, 600], [918, 560]]) {
      await harness.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await pause(400);
      for (const fraction of [0, .5, 1]) {
        await harness.evaluate(`(()=>{const e=document.querySelector('[data-composer-card]').closest('[class$=_scrollBody]');e.scrollTop=(e.scrollHeight-e.clientHeight)*${fraction};})()`);
        await pause(100); await assertLayout(`history scroll ${fraction} at ${width}x${height}`);
      }
      await harness.evaluate('document.querySelector("button[aria-label=展开底部面板]").click()');
      await pause(500); await assertLayout(`bottom panel open at ${height}`);
      await harness.evaluate('document.querySelector("button[aria-label=折叠底部面板]").click()');
      await pause(500); await assertLayout(`bottom panel closed at ${height}`);
    }
    await harness.call('Emulation.clearDeviceMetricsOverride'); await pause(300);
    await select('意外退出验收'); await until(continues, 'cold unclosed turn can continue');
    await harness.evaluate('window.__rufaReloadFixture=true');
    await harness.call('Page.reload');
    await until(() => harness.evaluate('window.__rufaReloadFixture!==true&&document.documentElement.dataset.rufaStartup==="ready"'), 'fresh page ready');
    await until(continues, 'continued availability after reload');

    await harness.evaluate('document.querySelector(".rufa-more-trigger").click()');
    await until(() => harness.evaluate('[...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.includes("设置"))'), 'settings menu');
    await harness.evaluate('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("设置")).click()');
    await until(() => harness.evaluate('[...document.querySelectorAll("[data-shortcut-modal=settings] button")].some(e=>/侧边卡片|Side card|better.?sidebar/i.test(e.textContent))'), 'Better Sidebar settings entry');
    await harness.evaluate('[...document.querySelectorAll("[data-shortcut-modal=settings] button")].find(e=>/侧边卡片|Side card|better.?sidebar/i.test(e.textContent)).click()');
    await until(() => harness.evaluate('document.querySelectorAll("[data-shortcut-modal=settings] input,[data-shortcut-modal=settings] [role=switch],[data-shortcut-modal=settings] select").length>0'), 'plugin configuration controls');
    const settingsCapture = await harness.call('Page.captureScreenshot', { format: 'png', fromSurface: false }).catch(() => null);
    if (settingsCapture) await writeFile(join(temporary, 'sidebar-settings.png'), Buffer.from(settingsCapture.data, 'base64'));
    await harness.evaluate('document.querySelector("[data-shortcut-modal=settings] button[class$=_close]").click()');
    assert.equal(await harness.evaluate('document.querySelectorAll("[data-slot-id=open-in-app],[data-slot-id=session-log-download]").length'), 0);

    await checkMediaPreviewUi({ harness, workspace: account.workspaceRoot, artifacts: temporary, until, pause });

    for (const [id, original] of originalHistory) {
      assert.deepEqual((await api.json('GET', `/sessions/${id}`)).session.upstreamHeader, original.header, 'Project migration must retain original history cwd and header');
      // Native attachment/draft operations can promote an Agent and append
      // permission/seed metadata. Every original event must remain unchanged.
      assert.deepEqual((await api.json('GET', `/sessions/${id}/events`)).events.slice(0, original.events.length), original.events, 'Original history remains byte-for-byte intact after native editing and previews');
    }

    await select('手动停止验收'); await until(continues, 'ready for actual native submit');
    await harness.evaluate('(()=>{const button=document.querySelector("button[aria-label=继续任务]");button.click();button.click();})()');
    await until(async () => (await api.json('GET', '/sessions/stopped-fixture/events')).events.some(row => row.event.type === 'user/message' && row.event.data.content?.some(block => block.text?.startsWith('继续完成刚才中断'))), 'native continued user message synced');
    await pause(750);
    const events = (await api.json('GET', '/sessions/stopped-fixture/events')).events;
    assert.equal(events.filter(row => row.event.type === 'user/message' && row.event.data.content?.some(block => block.text?.startsWith('继续完成刚才中断'))).length, 1, 'Double click must submit one continuation');
    assert.equal((await api.json('GET', '/sessions')).sessions.length, 3, 'Continue must reuse the same cloud conversation');
    t.diagnostic(`Real Electron stopped/cold/completed states, draft switch, native one-submit, Better Sidebar settings, video/audio decode/play/seek and authenticated Range verified. Mock gateway requests: ${gatewayCalls}. Screenshots: ${temporary}`);
  } catch (error) {
    await writeFile(join(temporary, 'runtime-diagnostics.txt'), runtimeDiagnostics);
    if (harness) {
      const capture = await harness.call('Page.captureScreenshot', { format: 'png' }).catch(() => null);
      if (capture) await writeFile(join(temporary, 'failure.png'), Buffer.from(capture.data, 'base64'));
      t.diagnostic(await harness.evaluate('JSON.stringify({text:document.body.innerText,buttons:[...document.querySelectorAll("button")].map(e=>({text:e.textContent,label:e.getAttribute("aria-label")}))})').catch(() => 'UI unavailable'));
    }
    t.diagnostic(`Fixture artifacts: ${temporary}`); throw error;
  } finally {
    if (shell) await shell.evaluate('window.close()').catch(() => {});
    await Promise.all(sockets.map(ws => new Promise(resolve => { if (ws.readyState === WebSocket.CLOSED) return resolve(); const timer = setTimeout(resolve, 1000); ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true }); ws.close(); })));
    if (child.exitCode === null) { const ended = once(child, 'exit'), timer = setTimeout(() => child.kill(), 12000); await ended; clearTimeout(timer); }
    await api.logout().catch(() => {}); await server.close(); await store.close(); await pause(100);
  }
});
