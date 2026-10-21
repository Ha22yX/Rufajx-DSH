import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startWorkbenchFixture, until, pause } from './fixtures/desktop-workbench.mjs';

test('employee preferences UI saves locally, syncs, resolves real cloud conflict, undoes, and survives restart',
  { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 180000 }, async t => {
    let offline = false;
    const fixture = await startWorkbenchFixture(t, { prefix: 'rufa-preferences-ui-', role: 'employee',
      configureServer(server) { server.addHook('onRequest', async (request, reply) => {
        if (offline && request.url.startsWith('/api/v1/preferences')) reply.code(503).send({ error: { code: 'FIXTURE_OFFLINE', message: 'Synthetic offline test' } });
      }); },
    });
    const evaluate = expression => fixture.harness.evaluate(expression);
    const click = async text => {
      await until(() => evaluate(`[...document.querySelectorAll('[data-rufa-preferences] button')].some(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled)`), `${text} available`);
      await evaluate(`[...document.querySelectorAll('[data-rufa-preferences] button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`);
      await pause(150); // Let the UI's 80 ms change-notice debounce render its new local CAS version.
    };
    const snapshot = async () => {
      const response = await evaluate('window.rufaAccount.preferences("snapshot")');
      assert.equal(response.ok, true); return response.value;
    };
    async function settings() {
      await evaluate('document.querySelector(".rufa-more-trigger").click()');
      await until(() => evaluate('[...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.includes("设置"))'), 'settings menu');
      await evaluate('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("设置")).click()');
      await until(() => evaluate('[...document.querySelectorAll("button")].some(e=>e.textContent.trim()==="工作偏好")'), 'work preferences settings tab');
      await evaluate('[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="工作偏好").click()');
      await until(() => evaluate('Boolean(document.querySelector("[data-rufa-preferences]"))'), 'preferences UI');
      await until(async () => Array.isArray((await snapshot()).entries), 'local preferences ready');
    }
    const set = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
    await settings();
    await click('添加偏好');
    await set('[data-rufa-preferences] form input', 'PPT配色');
    await set('[data-rufa-preferences] form textarea', '演示文稿默认使用深蓝色。');
    await set('[data-rufa-preferences] form select:nth-of-type(1)', 'account');
    await evaluate(`(()=>{const selects=document.querySelectorAll('[data-rufa-preferences] form select');selects[1].value='presentation';selects[1].dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click('保存');
    await until(async () => (await snapshot()).entries.some(row => row.text === '演示文稿默认使用深蓝色。'), 'local saved preference');
    const initial = await until(async () => (await fixture.api.json('GET', '/preferences')).entries.find(row => row.topic === 'PPT配色'), 'cloud saved preference');
    assert.equal(initial.scope, 'account');
    await until(() => evaluate('Boolean(document.querySelector(".rufa-pref-toast"))'), 'small saved notification');
    await fixture.capture('work-preferences');
    await click('暂停');
    await until(async () => !(await snapshot()).entries.find(row => row.id === initial.id).enabled, 'paused locally');
    await evaluate('document.querySelector(".rufa-pref-toast button").click()');
    await until(async () => (await snapshot()).entries.find(row => row.id === initial.id).enabled, 'undo restored enabled preference');
    await until(async () => (await snapshot()).pendingCount === 0, 'pause and undo synchronized');
    await pause(200);

    // Real server update from a second logical device, while this client queues
    // an offline change. The UI must preserve both versions for a human choice.
    const cloudBefore = (await fixture.api.json('GET', '/preferences')).entries.find(row => row.id === initial.id);
    const { version, createdAt, updatedAt, deletedAt, ...cloudInput } = cloudBefore;
    await fixture.api.json('POST', '/preferences/mutations', { mutationId: randomUUID(), operation: 'put', expectedVersion: version,
      entry: { ...cloudInput, text: '演示文稿默认使用浅灰色。' } });
    offline = true;
    await click('编辑');
    await set('[data-rufa-preferences] form textarea', '演示文稿默认使用绿色。');
    await click('保存');
    try { await until(async () => (await snapshot()).entries.find(row => row.id === initial.id).text.includes('绿色'), 'offline local edit'); }
    catch (error) { t.diagnostic(await evaluate('document.querySelector("[data-rufa-preferences]").innerText')); throw error; }
    const disk = JSON.parse(await readFile(join(fixture.account.companyHome, 'company-preferences.json'), 'utf8'));
    assert.ok(disk.outbox.length > 0);
    offline = false; await click('同步');
    await until(() => evaluate('document.querySelector("[data-rufa-preferences]").textContent.includes("采用云端")'), 'visible sync conflict');
    await fixture.capture('work-preferences-conflict');
    await click('采用云端');
    await until(async () => (await snapshot()).entries.find(row => row.id === initial.id).text.includes('浅灰色'), 'cloud version chosen explicitly');
    assert.equal((await snapshot()).conflicts.length, 0);
    await until(() => evaluate('document.querySelector("[data-rufa-preferences] input[type=checkbox]")?.disabled === false'), 'master toggle available');
    await evaluate('document.querySelector("[data-rufa-preferences] input[type=checkbox]").click()');
    await until(async () => !(await snapshot()).settings.enabled && (await snapshot()).pendingCount === 0, 'master disabled and synced');
    await evaluate('document.querySelector("[data-shortcut-modal=settings] button[class$=_close]").click()');
    await fixture.restart(); await settings();
    assert.equal((await snapshot()).settings.enabled, false);
    assert.equal((await snapshot()).entries.find(row => row.id === initial.id).text, '演示文稿默认使用浅灰色。');
    await until(() => evaluate('document.querySelector("[data-rufa-preferences]")?.getAttribute("aria-busy") === "false"'), 'preferences controls ready after restart');
    await click('清空全部偏好'); await click('取消');
    assert.ok((await snapshot()).entries.some(row => !row.deletedAt));
    await click('清空全部偏好'); await click('确认清空');
    await until(async () => (await snapshot()).entries.every(row => row.deletedAt), 'clear leaves tombstone');
    await evaluate('document.querySelector(".rufa-pref-toast button").click()');
    await until(async () => (await snapshot()).entries.some(row => !row.deletedAt), 'undo clear restores preference');
    await until(async () => (await snapshot()).pendingCount === 0, 'restoration synced');
    assert.equal((await fixture.api.json('GET', '/sessions')).sessions.length, 0, 'settings never create blank cloud sessions');
    assert.equal(fixture.gatewayCalls, 0);
    t.diagnostic(`Preference UI screenshots: ${fixture.temporary}; no model requests.`);
  });

test('real native agent requests use personal and project preferences with current-task and master overrides',
  { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 120000 }, async t => {
    const f = await startWorkbenchFixture(t, { prefix: 'rufa-preferences-prompt-', role: 'employee', captureGatewayBodies: true });
    const evaluate = expression => f.harness.evaluate(expression);
    const invoke = async (action, input) => {
      const result = await evaluate(`window.rufaAccount.preferences(${JSON.stringify(action)},${JSON.stringify(input)})`);
      assert.equal(result.ok, true); return result.value;
    };
    const texts = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(texts)
      : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, v]) => key === 'text' || ['content', 'messages', 'system'].includes(key) ? texts(v) : []) : [];
    const send = async text => {
      const before = f.gatewayRequests.length;
      await until(() => evaluate('Boolean(document.querySelector("[contenteditable=true]"))'), 'composer ready');
      await evaluate('document.querySelector("[contenteditable=true]").focus()');
      await f.harness.call('Input.insertText', { text });
      await until(() => evaluate('Boolean(document.querySelector("button[aria-label=发送消息]:not(:disabled)"))'), 'send available');
      await evaluate('document.querySelector("button[aria-label=发送消息]").click()');
      const request = await until(() => f.gatewayRequests.slice(before).find(body => body?.tools?.length > 20 && texts(body.messages).some(s => s.includes(text))), 'native model request');
      await until(() => evaluate('!document.querySelector("button[aria-label=停止]")&&!document.querySelector("button[aria-label=停止生成]")'), 'local mock refusal completed');
      // Native history retains older snapshots; the latest explicitly supersedes
      // them. Inspect that active snapshot without deleting historical messages.
      const activeContext = texts(request.messages).filter(text => text.startsWith('Current runtime context.')).at(-1) ?? '';
      const system = [...texts(request.system), activeContext].join('\n');
      assert.ok(request.tools.some(tool => (tool.name ?? tool.function?.name) === 'company_preferences'));
      return { request, system };
    };
    await evaluate('document.querySelector("[data-rufa-create-project]").click()');
    await until(() => evaluate('Boolean(document.querySelector("input[name=projectName]"))'), 'project form');
    await evaluate(`(()=>{const e=document.querySelector('input[name=projectName]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'偏好验收项目');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await evaluate('document.querySelector("[data-rufa-project-submit]").click()');
    const project = await until(async () => (await invoke('snapshot')).projects?.find(p => p.projectName === '偏好验收项目'), 'authoritative project binding');
    await until(() => evaluate('document.querySelector("[data-rufa-project-picker]")?.textContent.includes("偏好验收项目")'), 'project conversation selected');
    const entry = (scope, text) => ({ id: randomUUID(), scope, category: 'presentation', topic: 'PPT配色', text, enabled: true,
      ...(scope === 'project' ? { projectRef: project.projectRef, projectName: project.projectName } : {}) });
    await invoke('mutate', { action: 'put', entry: entry('account', '演示文稿默认使用个人深蓝配色。'), expectedVersion: 0 });
    await invoke('mutate', { action: 'put', entry: entry('project', '演示文稿默认使用项目墨绿配色。'), expectedVersion: 0 });
    const projectTurn = await send('请制作一份演示文稿。');
    await writeFile(join(f.temporary, 'project-native-request.json'), JSON.stringify({ ...projectTurn, snapshot: await invoke('snapshot'), headers: f.cache() }, null, 2));
    assert.ok(projectTurn.system.includes('项目墨绿配色'));
    assert.equal(projectTurn.system.includes('个人深蓝配色'), false, 'Project overrides matching personal topic');
    const previous = await evaluate('JSON.parse(localStorage.getItem("dsh.sessions.current")||"{}").sessionId');
    await evaluate('[...document.querySelectorAll("button")].find(e=>e.textContent.trim().startsWith("新会话")).click()');
    await until(() => evaluate(`JSON.parse(localStorage.getItem('dsh.sessions.current')||'{}').sessionId!==${JSON.stringify(previous)}&&document.querySelector('[data-rufa-project-picker]')?.textContent.includes('无项目')`), 'independent conversation selected');
    const globalTurn = await send('请制作新的PPT。');
    assert.ok(globalTurn.system.includes('个人深蓝配色'));
    assert.equal(globalTurn.system.includes('项目墨绿配色'), false, 'Project preference never leaks to independent conversation');
    const temporary = await send('这次忽略我的工作偏好，继续制作PPT。');
    assert.equal(temporary.system.includes('个人深蓝配色'), false);
    const snapshot = await invoke('snapshot');
    await invoke('mutate', { action: 'settings', enabled: false, expectedVersion: snapshot.settings.version });
    const disabled = await send('另外制作一份新的演示文稿。');
    assert.equal(disabled.system.includes('个人深蓝配色'), false);
    assert.deepEqual(disabled.request.tools, projectTurn.request.tools, 'Preferences never remove native tools');
    assert.ok(texts(disabled.request.messages).some(text => text.includes('请制作新的PPT')), 'Full earlier conversation remains');
    t.diagnostic('Actual native model requests captured and refused on loopback only; no paid model call.');
  });
