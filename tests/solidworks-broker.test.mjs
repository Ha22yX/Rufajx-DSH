import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSolidworksProcessManager } from '../apps/client/src/runtime/solidworks-process.mjs';

// Actual JS manager + actual Python JSONL broker/STA loop. Only COM and the
// application are synthetic; no real SolidWorks, account or model calls.
test('real Python broker protocol retains state through error, stop, status and explicit close',
  { skip: !process.env.RUFA_SW_TEST_PYTHON, timeout: 30000 }, async t => {
    const base = join(process.env.LOCALAPPDATA, 'RufaDSH', 'Tests', 'solidworks-broker');
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, 'case-'));
    const work = join(root, 'work'); await mkdir(work);
    const helper = join(root, 'synthetic.py');
    await writeFile(helper, `import os,runpy,sys
from pathlib import Path
from types import SimpleNamespace
sdk=runpy.run_path(${JSON.stringify(resolve('preinstalled/solidworks/runtime/solidworks_runner.py'))})
g=sdk['main'].__globals__
class Doc:
 def __init__(self):
  self.value=0; self.path=''; self.dirty=True
  self.Extension=SimpleNamespace(SaveAs=self.save)
 def save(self,path,*args): Path(path).write_text(str(self.value)); return True
 def GetTitle(self): return 'Synthetic'
 def GetPathName(self): return self.path
 def GetSaveFlag(self): return self.dirty
 def GetType(self): return 1
class FakeCad(sdk['PersistentCad']):
 def start(self):
  self.before=set(); self.created='test-owned'
  self.process=SimpleNamespace(pid=os.getpid(),exited=False)
  self.process.poll=lambda: 0 if self.process.exited else None
  self.process.wait=lambda **kw: 0
  self.app=SimpleNamespace(docs=[Doc()],GetProcessID=lambda:os.getpid())
  self.app.GetDocuments=lambda:self.app.docs
  self.app.ExitApp=lambda:setattr(self.process,'exited',True)
  self.ready=True
  self.scope={'cad':self,'sw':self.app}
  self.report['ownedPid']=os.getpid()
 def restore_recovery(self): pass
g.update(PersistentCad=FakeCad,load_com=lambda:None,
 pythoncom=SimpleNamespace(CoInitialize=lambda:None,CoUninitialize=lambda:None,PumpWaitingMessages=lambda:None,VT_BYREF=1,VT_I4=2),
 VARIANT=lambda _,value:SimpleNamespace(value=value),NULL=None,
 active_marker=lambda:Path(${JSON.stringify(root)})/'active.json',process_creation=lambda pid:'test-owned')
os.environ['LOCALAPPDATA']=${JSON.stringify(root)}
sdk['main']()
`);
    const manager = createSolidworksProcessManager({ pythonPath: process.env.RUFA_SW_TEST_PYTHON,
      helperPath: helper, stateRoot: join(root, 'state') });
    t.after(() => manager.close());
    const options = { sessionKey: 'synthetic-session', cwd: work, timeoutSeconds: 30 };
    const invalid = await manager.run({ ...options, code: 'if bad syntax' });
    assert.equal(invalid.launched, false); assert.equal(invalid.status, 'failed');
    assert.equal((await manager.status(options)).status, 'not-started');
    const first = await manager.run({ ...options, code: 'doc=sw.docs[0]; doc.value=7' });
    const failed = await manager.run({ ...options, code: 'doc.value+=1; cad.check("intentional",False)' });
    assert.equal(failed.status, 'failed'); assert.equal(failed.retained, true);
    const stopped = await manager.run({ ...options, code: 'cad.cancel.write_text("stop"); cad.check_cancel()' });
    assert.equal(stopped.status, 'stopped');
    const resumed = await manager.run({ ...options, code: 'cad.check("retained",doc.value==8)' });
    assert.equal(resumed.instanceId, first.instanceId);
    assert.equal(resumed.ownedPid, first.ownedPid);
    assert.equal((await manager.status(options)).documents.length, 1);
    assert.equal((await manager.closeSession(options)).status, 'failed');
    await manager.run({ ...options, code: 'doc.path=str(cad.path("saved.SLDPRT")); doc.dirty=False' });
    const closed = await manager.closeSession(options);
    assert.equal(closed.status, 'closed'); assert.equal(closed.instanceAlive, false);
    t.diagnostic(`Synthetic protocol evidence: ${root}`);
  });
