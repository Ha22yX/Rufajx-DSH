import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { startWorkbenchFixture, until, pause } from './fixtures/desktop-workbench.mjs';

test('desktop projects separate ordinary sessions, share explicit folders, and persist grouping without blank cloud sessions',
  { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 240000 }, async t => {
  const fixture = await startWorkbenchFixture(t, { nativeDirectoryPicker: true, captureGatewayBodies: true, visibleWindow: true });
  let ui = fixture.harness;
  const evaluate = expression => ui.evaluate(expression);
  const projectIds = () => evaluate('[...document.querySelectorAll("[data-rufa-project-id]")].filter(e=>e.getBoundingClientRect().height>0).map(e=>e.dataset.rufaProjectId)');
  const readHeaders = () => fixture.cache();
  const latest = () => readHeaders().at(-1);
  const newSession = async (keyboard = false) => {
    const before = new Set(readHeaders().map(row => row.id));
    if (keyboard) {
      await evaluate('[...document.querySelectorAll("button")].find(e=>e.textContent.trim().startsWith("新会话")).focus()');
      // CDP insertText may leave the native IME guard armed until keyup.
      await ui.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await ui.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await ui.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', modifiers: 3, windowsVirtualKeyCode: 78 });
      await ui.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', modifiers: 3, windowsVirtualKeyCode: 78 });
    } else await evaluate('[...document.querySelectorAll("button")].find(e=>e.textContent.trim().startsWith("新会话")).click()');
    const created = await until(() => readHeaders().find(row => !before.has(row.id)), 'fresh local blank');
    await until(() => evaluate(`Boolean(document.querySelector('[data-rufa-session-id="${created.id}"][aria-selected="true"]'))&&Boolean(document.querySelector('[contenteditable=true]'))`), 'selected independent composer');
    return created;
  };
  const sendText = async (text, sessionId) => {
    await until(() => evaluate(`JSON.parse(localStorage.getItem('dsh.sessions.current')||'{}').sessionId===${JSON.stringify(sessionId)}&&Boolean(document.querySelector('[data-conversation-session="${sessionId}"] [contenteditable=true]'))`), 'new conversation selected before typing');
    await evaluate('document.querySelector("[contenteditable=true]").focus()');
    await ui.call('Input.insertText', { text });
    await until(() => evaluate(`document.querySelector('[contenteditable=true]').textContent.includes(${JSON.stringify(text)})`), 'text is in selected conversation');
    await until(() => evaluate('Boolean(document.querySelector("button[aria-label=发送消息]:not(:disabled)"))'), 'send enabled');
    await evaluate('document.querySelector("button[aria-label=发送消息]").click()');
    await until(async () => (await fixture.api.json('GET', '/sessions')).sessions.some(session => session.id === sessionId), 'first submission creates cloud record');
    await until(async () => {
      const events = (await fixture.api.json('GET', `/sessions/${sessionId}/events`)).events.map(row=>row.event);
      return events.some(event=>event.type==='user/message'&&event.data.content?.some(block=>block.text?.includes(text)))
        && events.some(event=>event.type==='turn/end');
    }, 'submitted text and completed synthetic turn are durable');
    await until(() => evaluate('!document.querySelector("button[aria-label=停止]")&&!document.querySelector("button[aria-label=停止生成]")'), 'synthetic turn stopped');
  };
  try {
    await until(() => readHeaders().length > 0, 'new account initial blank');
    const first = latest();
    assert.match(first.header.cwd.replaceAll('\\', '/'), /\/workspaces\/sessions\//);
    assert.equal((await stat(first.header.cwd)).isDirectory(), true);
    assert.deepEqual(await projectIds(), [], 'Fresh account must not get an automatic default project');
    assert.equal((await fixture.api.json('GET', '/sessions')).sessions.length, 0);
    await evaluate('document.querySelector("[contenteditable=true]").focus()');
    await ui.call('Input.insertText', { text: '保留在本地的草稿' });
    let second = await newSession();
    assert.notEqual(first.header.cwd, second.header.cwd, 'Ordinary conversations need separate folders');
    assert.equal((await fixture.api.json('GET', '/sessions')).sessions.length, 0, 'Typing and navigating must stay local');
    await until(() => evaluate(`Boolean(document.querySelector('[data-rufa-session-id="${first.id}"]'))`), 'unsent draft remains accessible');
    await evaluate(`document.querySelector('[data-rufa-session-id="${first.id}"]').click()`);
    await until(() => evaluate('document.querySelector("[contenteditable=true]").textContent.trim()==="保留在本地的草稿"'), 'reopen previous draft');
    await until(() => !readHeaders().some(row => row.id === second.id), 'abandoned blank is discarded');
    second = await newSession();
    await sendText('独立会话验收', second.id);
    const cloudIndependent = (await fixture.api.json('GET', `/sessions/${second.id}`)).session;
    assert.equal(cloudIndependent.upstreamHeader.cwd, second.header.cwd);

    const customFolder = join(fixture.temporary, 'selected-project-folder');
    await mkdir(customFolder); await writeFile(join(customFolder, 'preserve.txt'), 'Existing project content');
    const extraFolder = join(fixture.temporary, 'project-reference-drawings');
    const referenceFolder = join(fixture.temporary, 'project-reference-contracts');
    const removedFolder = join(fixture.temporary, 'removed-reference-folder');
    for (const folder of [extraFolder, referenceFolder, removedFolder]) await mkdir(folder);
    const folderRows = () => evaluate('[...document.querySelectorAll("[data-rufa-project-folder]")].map(e=>({title:e.getAttribute("title"),text:e.innerText}))');
    const setAutomatic = async value => {
      if (await evaluate('document.querySelector("input[data-rufa-project-auto]").checked') !== value) {
        await evaluate('document.querySelector("input[data-rufa-project-auto]").click()');
      }
      await until(() => evaluate(`document.querySelector('input[data-rufa-project-auto]').checked===${value}`), 'automatic folder option applied');
    };
    const pickDirectory = async (selector, path) => {
      const before = (await fixture.directoryPicker.calls()).length;
      await fixture.directoryPicker.select(path);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await until(async () => (await fixture.directoryPicker.calls()).length === before + 1, 'native picker host path invoked');
      await until(() => evaluate('Boolean(document.querySelector("[data-rufa-project-dialog]"))&&!document.querySelector("[data-rufa-project-browse]")?.disabled'), 'project dialog restored after native picker');
    };
    async function openCreate() {
      await evaluate('document.querySelector("[data-rufa-create-project]").click()');
      await until(() => evaluate('Boolean(document.querySelector("[data-rufa-project-dialog]"))'), 'create project dialog');
    }
    async function setField(selector, value) {
      await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    }
    await openCreate();
    assert.equal(await evaluate('document.querySelector("[data-rufa-project-submit]").disabled'), true, 'Project name is required');
    assert.equal(await evaluate('document.querySelector("input[data-rufa-project-auto]").checked'), true);
    assert.equal(await evaluate('document.querySelector("input[name=projectPath]")===null'), true, 'No editable path field');
    assert.equal(await evaluate('document.querySelector("[data-rufa-project-folders]").getAttribute("aria-disabled")'), 'true');
    await evaluate('document.querySelector("[data-rufa-project-cancel]").click()');
    assert.deepEqual(await projectIds(), []);
    const createdProjects = [];
    const projectMetadata = async () => JSON.parse(await readFile(join(fixture.account.companyHome, 'company-project-folders.json'), 'utf8'));
    let originalProjectDraft;
    for (let index = 1; index <= 4; index++) {
      await openCreate();
      await setField('input[name=projectName]', `验收项目 ${index}`);
      if (index === 1) {
        await fixture.capture('project-auto-default');
        assert.equal(await evaluate('document.querySelector("[data-rufa-project-browse]").disabled'), true);
        await setAutomatic(false);
        assert.equal(await evaluate('document.querySelector("[data-rufa-project-submit]").disabled'), true, 'Manual mode requires a folder');
        await pickDirectory('[data-rufa-project-browse]', null);
        assert.equal((await folderRows()).length, 0, 'Cancel keeps the selection empty');
        await pickDirectory('[data-rufa-project-browse]', customFolder);
        await pickDirectory('[data-rufa-project-browse]', customFolder);
        assert.equal((await folderRows()).length, 1, 'Repeated selections are deduplicated');
        await pickDirectory('[data-rufa-project-browse]', extraFolder);
        await pickDirectory('[data-rufa-project-browse]', removedFolder);
        await evaluate(`(()=>{const row=[...document.querySelectorAll('[data-rufa-project-folder]')].find(e=>e.getAttribute('title')===${JSON.stringify(removedFolder)});row.querySelector('[data-rufa-project-remove]').click();})()`);
        await until(async () => (await folderRows()).length === 2, 'folder remove action');
        const selected = await folderRows();
        assert.deepEqual(selected.map(row => row.title), [customFolder, extraFolder]);
        assert.ok(selected.every(row => !row.text.includes(fixture.temporary)), 'Full paths are hover hints only');
        await setAutomatic(true);
        assert.deepEqual(await folderRows(), selected, 'Auto toggle preserves custom selections');
        assert.equal(await evaluate('[...document.querySelectorAll("[data-rufa-project-folders] button")].every(e=>e.disabled)'), true);
        await setAutomatic(false);
        assert.deepEqual(await folderRows(), selected, 'Returning to manual restores selections');
        await evaluate('document.querySelector("[data-rufa-project-references-toggle]").click()');
        await pickDirectory('[data-rufa-project-reference-browse]', referenceFolder);
        assert.equal(await evaluate('document.querySelectorAll("[data-rufa-project-reference-folder]").length'), 1);
        await fixture.capture('project-manual-multiple');
      } else if (index === 2) {
        await evaluate('document.querySelector("[data-rufa-project-references-toggle]").click()');
        // Optional references remain usable while custom working folders are disabled.
        const before = (await fixture.directoryPicker.calls()).length;
        await fixture.directoryPicker.select(referenceFolder);
        await evaluate('document.querySelector("[data-rufa-project-reference-browse]").click()');
        await until(async () => (await fixture.directoryPicker.calls()).length === before + 1, 'automatic project reference selected');
        await until(() => evaluate('document.querySelectorAll("[data-rufa-project-reference-folder]").length===1'), 'automatic project reference listed');
        await fixture.capture('project-auto-reference');
      }
      await evaluate('document.querySelector("[data-rufa-project-submit]").click()');
      await until(() => evaluate('!document.querySelector("[data-rufa-project-dialog]")'), 'project saved');
      const ids = await until(async () => { const ids = await projectIds(); return ids.some(id => !createdProjects.includes(id)) && ids; }, 'new project row');
      const id = ids.find(id => !createdProjects.includes(id)); createdProjects.push(id);
      if (index === 1) {
        originalProjectDraft = await until(() => readHeaders().find(row => normalize(row.header.cwd).toLowerCase() === normalize(customFolder).toLowerCase()), 'original project draft');
        await until(() => evaluate('document.querySelector("[data-rufa-project-picker]")?.textContent.includes("验收项目 1")'), 'new project composer');
        await evaluate('document.querySelector("[contenteditable=true]").focus()');
        await ui.call('Input.insertText', { text: '项目原有草稿' });
      }
      await pause(100);
    }
    const savedFolders = await projectMetadata();
    assert.equal(savedFolders.version, 1);
    const savedProjects = Object.values(savedFolders.projects);
    assert.equal(savedProjects.length, 4, 'Each created project has account-local directory metadata');
    const manualProject = savedProjects.find(row => row.workspaceId === createdProjects[0]);
    assert.equal(manualProject.path, await realpath(customFolder));
    assert.deepEqual(manualProject.referencePaths, await Promise.all([extraFolder, referenceFolder].map(path => realpath(path))));
    const autoProject = savedProjects.find(row => row.workspaceId === createdProjects[1]);
    assert.match(autoProject.path.replaceAll('\\', '/'), /\/workspaces\/projects\//);
    assert.deepEqual(autoProject.referencePaths, [await realpath(referenceFolder)]);
    assert.equal((await projectIds()).length, 3, 'Only three projects are initially visible');
    assert.deepEqual(await projectIds(), createdProjects.slice(1).reverse(), 'Projects sort by recent creation/activity');
    assert.ok(await evaluate('Boolean(document.querySelector("[data-rufa-more-projects]"))'));
    await evaluate('document.querySelector("[data-rufa-more-projects]").click()');
    assert.equal((await projectIds()).length, 4);
    assert.equal(await evaluate('Boolean(document.querySelector("[data-rufa-project-id] [data-row-key^=\\\"workspace:\\\"][aria-expanded=true]"))'), false, 'Projects default to collapsed');
    assert.equal((await fixture.api.json('GET', '/sessions')).sessions.length, 1, 'Creating projects or local drafts must not create server conversations');

    // Select a named project from the composer; its session uses exactly the assigned folder.
    const standalone = await newSession();
    await evaluate('document.querySelector("[contenteditable=true]").focus()');
    await ui.call('Input.insertText', { text: '选择项目不丢草稿' });
    await evaluate('document.querySelector("[data-rufa-project-picker]").click()');
    await until(() => evaluate('[...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.includes("验收项目 1"))'), 'project picker menu');
    await evaluate('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("验收项目 1")).click()');
    const assigned = await until(() => readHeaders().find(row => row.header.createdAt > standalone.header.createdAt && normalize(row.header.cwd).toLowerCase() === normalize(customFolder).toLowerCase()), 'explicit project session');
    assert.equal(await realpath(assigned.header.cwd), await realpath(customFolder));
    await until(() => evaluate('document.querySelector("[data-rufa-project-picker]")?.textContent.includes("验收项目 1")'), 'composer selected project');
    await until(() => evaluate('document.querySelector("[contenteditable=true]").textContent.trim()==="选择项目不丢草稿"'), 'project selection transfers draft');
    await evaluate(`document.querySelector('[data-rufa-project-id="${createdProjects[0]}"] [data-row-key^="workspace:"]').click()`);
    await until(() => evaluate(`Boolean(document.querySelector('[data-rufa-session-id="${originalProjectDraft.id}"]'))`), 'prior project draft accessible');
    await evaluate(`document.querySelector('[data-rufa-session-id="${originalProjectDraft.id}"]').click()`);
    await until(() => evaluate('document.querySelector("[contenteditable=true]").textContent.trim()==="项目原有草稿"'), 'prior project draft is not overwritten');
    await evaluate(`document.querySelector('[data-rufa-session-id="${assigned.id}"]').click()`);
    await until(() => evaluate('document.querySelector("[contenteditable=true]").textContent.trim()==="选择项目不丢草稿"'), 'return to transferred project draft');
    await evaluate(`document.querySelector('[data-rufa-project-id="${createdProjects[0]}"] [data-row-key^="workspace:"]').click()`);
    await sendText('项目内会话验收', assigned.id);
    const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    const promptTexts = fixture.gatewayRequests.flatMap(strings);
    for (const path of [extraFolder, referenceFolder]) {
      assert.ok(promptTexts.some(text => text.includes(path) || text.includes(JSON.stringify(path).slice(1, -1))), 'Project reference path reaches the real model request assembly');
    }
    assert.equal(await readFile(join(customFolder, 'preserve.txt'), 'utf8'), 'Existing project content');
    const beforeSibling = new Set(readHeaders().map(row => row.id));
    await evaluate(`document.querySelector('[data-rufa-project-id="${createdProjects[0]}"] button[aria-label*="新建会话"]').click()`);
    const sibling = await until(() => readHeaders().find(row => !beforeSibling.has(row.id)), 'second project conversation');
    assert.equal(sibling.header.cwd, assigned.header.cwd, 'Two explicit project conversations share their assigned directory');
    await sendText('同项目第二个会话', sibling.id);
    const next = await newSession(true);
    assert.match(next.header.cwd.replaceAll('\\', '/'), /\/workspaces\/sessions\//);
    assert.notEqual(next.header.cwd, assigned.header.cwd, 'Global shortcut must not inherit current project');
    assert.equal((await fixture.api.json('GET', '/sessions')).sessions.length, 3);
    // Remember the user's collapse choice; creating a project child can reveal
    // its parent during navigation, while initial project rows default closed.
    await evaluate('document.querySelectorAll("[data-rufa-project-id] [aria-expanded=true][data-row-key]").forEach(e=>e.click())');
    await evaluate('document.querySelector("[contenteditable=true]").focus()');
    await ui.call('Input.insertText', { text: '重启后保留当前草稿' });
    await until(() => evaluate('document.querySelector("[contenteditable=true]").textContent.trim()==="重启后保留当前草稿"'), 'draft entered before restart');
    await pause(600);
    const beforeRestart = readHeaders().map(row => ({ id: row.id, header: row.header }));
    ui = await fixture.restart();
    assert.deepEqual(await projectMetadata(), savedFolders, 'Project directory choices survive a desktop restart unchanged');
    assert.deepEqual(readHeaders().map(row => ({ id: row.id, header: row.header })), beforeRestart, 'Restart must reuse local session and keep immutable history headers');
    assert.equal((await projectIds()).length, 3, 'Restart applies the three-project fold');
    assert.equal((await fixture.api.json('GET', '/sessions')).sessions.length, 3);
    assert.equal(await evaluate('document.querySelector("[contenteditable=true]").textContent.trim()'), '重启后保留当前草稿');
    const hierarchy = await evaluate(`(()=>{const rows=[...document.querySelectorAll('[data-rufa-project-id],[data-rufa-session-id]')];return rows.map(e=>({project:e.dataset.rufaProjectId,session:e.dataset.rufaSessionId,x:e.getBoundingClientRect().x}));})()`);
    assert.ok(hierarchy.some(row => row.session === second.id), 'Unprojected submitted session remains visible below the projects');
    assert.equal(hierarchy.some(row => row.session === assigned.id), false, 'Collapsed project child stays hidden');
    assert.equal((await projectIds())[0], createdProjects[0], 'Activity in an older project brings it to the top');
    await evaluate(`document.querySelector('[data-rufa-project-id="${createdProjects[0]}"] [data-row-key^="workspace:"]').click()`);
    await until(() => evaluate(`Boolean(document.querySelector('[data-rufa-session-id="${sibling.id}"]'))`), 'expanded project children');
    const children = await evaluate(`(()=>{const group=document.querySelector('[data-rufa-project-id="${createdProjects[0]}"]');return [...group.querySelectorAll('[data-rufa-session-id]')].map(e=>({id:e.dataset.rufaSessionId,x:e.getBoundingClientRect().x+parseFloat(getComputedStyle(e).paddingLeft)}));})()`);
    assert.deepEqual(children.map(row => row.id).slice(0, 2), [sibling.id, assigned.id], 'Project conversations sort by recent activity');
    const level = await evaluate(`(()=>{const p=document.querySelector('[data-rufa-project-id="${createdProjects[0]}"] [data-row-key^="workspace:"]'),s=document.querySelector('[data-rufa-session-id="${second.id}"]');const x=e=>e.getBoundingClientRect().x+parseFloat(getComputedStyle(e).paddingLeft);return {project:x(p),independent:x(s)};})()`);
    assert.ok(Math.abs(level.project - level.independent) < 1, 'Projects and unprojected conversations are peers');
    assert.ok(children.every(row => row.x > level.project), 'Project conversations are indented');
    // A static hierarchy check misses the native exit overlay: removed rows are
    // cloned outside their project ancestor for a 100ms fade. Sample their title
    // position as well as their box; the box stays still even when padding jumps.
    const projectSelector = `[data-rufa-project-id="${createdProjects[0]}"] [data-row-key^="workspace:"]`;
    const pointerToggle = async () => {
      const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(projectSelector)});const r=e.getBoundingClientRect();return {x:r.left+40,y:r.top+r.height/2};})()`);
      await ui.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await ui.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    };
    const beginFrames = async () => {
      await evaluate(`(()=>{
        const ids=${JSON.stringify(children.map(row => row.id))};
        window.__rufaProjectFrames=[];window.__rufaProjectSampling=true;
        window.__rufaReadProjectRows=()=>[...document.querySelectorAll('[data-rufa-session-id]')]
          .filter(e=>ids.includes(e.dataset.rufaSessionId)).map(e=>({id:e.dataset.rufaSessionId,
            exit:!e.hasAttribute('data-row-key'),inert:e.inert,
            padding:getComputedStyle(e).paddingInlineStart,opacity:Number(getComputedStyle(e).opacity),
            titleX:e.querySelector('[class$="_title"]')?.getBoundingClientRect().left}));
        const sample=()=>window.__rufaProjectFrames.push(window.__rufaReadProjectRows());
        const observer=new MutationObserver(sample);observer.observe(document.body,{childList:true,subtree:true});
        const frame=()=>{sample();if(window.__rufaProjectSampling)requestAnimationFrame(frame);else observer.disconnect();};frame();
      })()`);
    };
    await ui.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await pause(300);
    await beginFrames();
    const expandedRows = await evaluate('window.__rufaReadProjectRows()');
    await pointerToggle();
    await pause(350);
    const collapseFrames = await evaluate('window.__rufaProjectSampling=false;window.__rufaProjectFrames');
    const exiting = collapseFrames.flat().filter(row => row.exit && row.opacity > 0);
    await writeFile(join(fixture.temporary, 'project-collapse-frames.json'), JSON.stringify({ expandedRows, collapseFrames }, null, 2));
    assert.ok(exiting.length > 0, 'Real pointer input must exercise native exit animation');
    assert.ok(exiting.some(row => row.opacity > 0 && row.opacity < 1), 'Compositor must actually advance the exit fade');
    assert.ok(exiting.every(row => row.inert), 'Exiting rows remain non-interactive');
    for (const row of exiting) {
      const before = expandedRows.find(item => item.id === row.id);
      assert.equal(row.padding, before.padding, 'Project row keeps its indentation in the exit overlay');
      assert.ok(Math.abs(row.titleX - before.titleX) < 1, 'Project title must not shift horizontally while collapsing');
    }
    assert.equal(await evaluate('window.__rufaReadProjectRows().length'), 0, 'Completed collapse removes all exit clones');
    await pointerToggle();
    await pause(250);
    await beginFrames();
    // Toggle back before the preceding fade/glide can finish.
    for (let index=0;index<4;index++) { await pointerToggle();await pause(25); }
    await pause(350);
    const rapidFrames = await evaluate('window.__rufaProjectSampling=false;window.__rufaProjectFrames');
    assert.ok(rapidFrames.flat().every(row => row.padding === '28px'), 'Rapid reversals preserve project indentation');
    assert.equal(await evaluate('window.__rufaReadProjectRows().filter(row=>row.exit).length'), 0, 'Rapid reversals leave no orphan exit clones');
    assert.equal(await evaluate('window.__rufaReadProjectRows().length'), children.length, 'Rapid reversals restore each row once');
    await ui.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await beginFrames();
    await pointerToggle();
    await pause(150);
    const reducedFrames = await evaluate('window.__rufaProjectSampling=false;window.__rufaProjectFrames');
    assert.equal(reducedFrames.flat().some(row => row.exit), false, 'Reduced motion collapses without exit animation');
    await pointerToggle();
    await until(() => evaluate(`document.querySelectorAll('[data-rufa-project-id="${createdProjects[0]}"] [data-rufa-session-id]').length===${children.length}`), 'reduced-motion expansion restores children');
    await ui.call('Emulation.setEmulatedMedia', { features: [] });
    await fixture.capture('projects');
    t.diagnostic(`Real Electron project dialog/default-auto/multiple folders/toggle preservation, native picker boundary, project context, lazy cloud creation, ordering/restart and collapse title position/fade/rapid reversals/reduced motion verified. OS picker selections and model responses are synthetic. Local mock gateway calls: ${fixture.gatewayCalls}. Artifacts: ${fixture.temporary}`);
  } catch (error) {
    t.diagnostic(`Fixture artifacts: ${fixture.temporary}`);
    t.diagnostic(await evaluate('document.body.innerText').catch(() => 'UI unavailable'));
    await fixture.capture('failure').catch(() => {}); throw error;
  }
});
