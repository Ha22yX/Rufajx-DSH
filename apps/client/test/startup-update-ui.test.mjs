import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

test('real Electron startup update screen shows bytes, recovers and never installs after continue',
  {skip:process.env.RUFA_DESKTOP_E2E!=='1',timeout:30000},async t=>{
    const root=await mkdtemp(join(tmpdir(),'rufa-startup-update-ui-')),client=fileURLToPath(new URL('../',import.meta.url));
    t.diagnostic(`Isolated Electron evidence: ${root}`);
    const electron=createRequire(import.meta.url)('electron');
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(electron,[join(client,'test/fixtures/startup-update-ui.cjs'),root,client],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+String(chunk)).slice(-4000);});
    t.after(()=>{if(child.exitCode===null)child.kill();});
    const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    const report=JSON.parse(await readFile(join(root,'report.json'),'utf8'));
    assert.equal(exit,0,JSON.stringify(report)+'\n'+output);assert.equal(report.passed,true);assert.equal(report.installs,0);
    t.diagnostic(`Real Electron screenshots: ${root}; synthetic updater, 0 network and 0 installer execution.`);
  });
