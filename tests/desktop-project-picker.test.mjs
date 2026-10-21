import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { startWorkbenchFixture, until, pause } from './fixtures/desktop-workbench.mjs';

test('project modal stays mounted and visible while directory selection is pending',
  { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 180000 }, async t => {
    const fixture = await startWorkbenchFixture(t, { prefix: 'rufa-project-picker-', nativeDirectoryPicker: true, visibleWindow: true });
    const ui = fixture.harness;
    const evaluate = expression => ui.evaluate(expression);
    const selected = join(fixture.temporary, '项目文件夹');
    const reference = join(fixture.temporary, '参考资料');
    await mkdir(selected); await mkdir(reference);
    await evaluate('document.querySelector("[data-rufa-create-project]").click()');
    await until(() => evaluate('Boolean(document.querySelector("[data-rufa-project-dialog]"))'), 'project modal opened');
    await evaluate(`(()=>{
      const input=document.querySelector('input[name=projectName]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'保持项目草稿');
      input.dispatchEvent(new Event('input',{bubbles:true}));
      window.__projectForm=document.querySelector('[data-rufa-project-dialog]');
    })()`);
    await evaluate('document.querySelector("[data-rufa-project-auto]").click()');
    const visibleForm = () => evaluate(`(()=>{
      const form=document.querySelector('[data-rufa-project-dialog]');
      if(!form||form!==window.__projectForm||!form.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;
      for(let e=form;e;e=e.parentElement){if(getComputedStyle(e).opacity==='0')return false;}
      const r=form.getBoundingClientRect();return r.width>0&&r.height>0;
    })()`);
    const rows = () => evaluate(`({work:[...document.querySelectorAll('[data-rufa-project-folder]')].map(e=>e.title),references:[...document.querySelectorAll('[data-rufa-project-reference-folder]')].map(e=>e.title)})`);
    await until(visibleForm,'initial project modal finished opening');
    let captures = 0;
    const pick = async (selector, path, error) => {
      const before=(await fixture.directoryPicker.calls()).length;
      const release=await fixture.directoryPicker.hold(path,error);
      const previous=await rows();
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await until(async ()=>(await fixture.directoryPicker.calls()).length===before+1,'native host picker opened');
      try {
        if (!await visibleForm()) {
          await fixture.capture('pending-failure');
          t.diagnostic(`Pending modal artifacts: ${fixture.temporary}`);
          t.diagnostic(JSON.stringify(await evaluate(`(()=>{const form=document.querySelector('[data-rufa-project-dialog]');const ancestors=[];for(let e=form;e;e=e.parentElement){const s=getComputedStyle(e);ancestors.push({tag:e.tagName,cls:e.className,display:s.display,visibility:s.visibility,opacity:s.opacity,hidden:e.hidden});}return {present:!!form,same:form===window.__projectForm,ancestors};})()`)));
        }
        assert.equal(await visibleForm(),true,'the same project modal must remain visible behind the OS picker');
        assert.equal(await evaluate('document.querySelector("input[name=projectName]").value'),'保持项目草稿');
        assert.equal(await evaluate('document.querySelector("[data-rufa-project-dialog]").getAttribute("aria-busy")'),'true');
        assert.equal(await evaluate('document.querySelector("[data-rufa-project-submit]").disabled&&document.querySelector("[data-rufa-project-cancel]").disabled'),true);
        await ui.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await ui.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).click();document.querySelector('[data-rufa-project-dialog]').requestSubmit()`);
        await pause(150);
        assert.equal(await visibleForm(),true,'parent Escape/submit cannot dismiss the project while picker owns the action');
        assert.deepEqual(await rows(),previous);
        assert.equal((await fixture.directoryPicker.calls()).length,before+1,'no duplicate picker');
        await fixture.capture(`picker-pending-${++captures}`);
      } finally { await release(); }
      await until(()=>evaluate('document.querySelector("[data-rufa-project-dialog]")?.getAttribute("aria-busy")==="false"'),'picker released parent');
      assert.equal(await visibleForm(),true,'picker result must not remount the form');
      assert.equal(await evaluate('document.querySelector("input[name=projectName]").value'),'保持项目草稿');
    };
    await pick('[data-rufa-project-browse]',null);
    assert.deepEqual(await rows(),{work:[],references:[]});
    await pick('[data-rufa-project-browse]',selected);
    await evaluate('document.querySelector("[data-rufa-project-references-toggle]").click()');
    await pick('[data-rufa-project-reference-browse]',null);
    await pick('[data-rufa-project-reference-browse]',reference);
    assert.deepEqual(await rows(),{work:[selected],references:[reference]});
    await pick('[data-rufa-project-reference-browse]',null,'Synthetic directory picker failure');
    assert.deepEqual(await rows(),{work:[selected],references:[reference]});
    assert.equal(await evaluate('Boolean(document.querySelector("[data-rufa-project-dialog] [role=alert]")?.textContent)'),true);
    await evaluate('document.querySelector("[data-rufa-project-auto]").click()');
    await pick('[data-rufa-project-reference-browse]',null);
    await evaluate('document.querySelector("[data-rufa-project-auto]").click()');
    assert.deepEqual(await rows(),{work:[selected],references:[reference]},'auto/manual toggle preserves selections');
    await fixture.capture('project-draft-after-pickers');
    await evaluate('document.querySelector("[data-rufa-project-submit]").click()');
    await until(()=>evaluate('!document.querySelector("[data-rufa-project-dialog]")'),'successful creation closes modal');
    const metadata=JSON.parse(await readFile(join(fixture.account.companyHome,'company-project-folders.json'),'utf8'));
    const canonicalSelected=await realpath(selected);
    const record=Object.values(metadata.projects).find(row=>row.path===canonicalSelected);
    assert.ok(record,'selected project is persisted');
    assert.deepEqual(record.referencePaths,[await realpath(reference)]);
    await evaluate('document.querySelector("[data-rufa-create-project]").click()');
    await until(()=>evaluate('Boolean(document.querySelector("[data-rufa-project-dialog]"))'),'reopen modal');
    await evaluate('document.querySelector("[data-rufa-project-cancel]").click()');
    await until(()=>evaluate('!document.querySelector("[data-rufa-project-dialog]")'),'explicit cancel still closes modal');
    assert.equal((await fixture.api.json('GET','/sessions')).sessions.length,0);
    assert.equal(fixture.gatewayCalls,0);
    t.diagnostic(`Real Electron + native host path; OS picker result held/synthesized. Cancel/select/error, main/reference folders, same DOM and visible backdrop, no duplicate creation, and local persistence passed. ${fixture.temporary}`);
  });
