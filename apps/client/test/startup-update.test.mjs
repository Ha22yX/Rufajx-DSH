import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { StartupUpdateController, verifyUpdateArtifact, readUpdateArtifact, isNewerStableVersion, allowedUpdateRequest, COMPANY_UPDATE_FEED } from '../dist/startup-update.js';
import { createCompanyUpdater } from '../dist/electron-update.js';
import { launchStartupInstaller } from '../dist/startup-installer.js';
import { CompanyError } from '../dist/types.js';
import { updatePresentation } from '../src/renderer/update-view.mjs';

const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b; }); return { promise,resolve,reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(test, ms=1000) { const end=Date.now()+ms; while(!test()){if(Date.now()>end)throw new Error('Timed out');await new Promise(r=>setTimeout(r,5));} }
const content=Buffer.from('MZ synthetic installer bytes — never executable');
function metadata(version='0.3.0') { const name=`Rufa-DSH-${version}-x64-Setup.exe`, url=`releases/${version}/${name}`;
  const sha512=createHash('sha512').update(content).digest('base64');return {version,files:[{url,sha512,size:content.length}],path:url,sha512}; }
async function fixture(t, overrides={}) {
  const dir=await mkdtemp(join(tmpdir(),'rufa-update-test-'));t.after(async()=>{assert.equal(dirname(dir),tmpdir());await rm(dir,{recursive:true,force:true});});
  const path=join(dir,'Rufa-DSH-0.3.0-x64-Setup.exe');await writeFile(path,content);
  const calls={factory:0,download:0,install:0,dispose:0}, statuses=[];
  let safe=true;
  const port={async check(){return metadata();},async download(signal,progress){calls.download++;progress({transferred:content.length/2,total:content.length,bytesPerSecond:123});return [path];},
    install(){calls.install++;},dispose(){calls.dispose++;},...overrides.port};
  const controller=new StartupUpdateController({enabled:true,currentVersion:'0.2.0',createUpdater:()=>{calls.factory++;return port;},canInstall:()=>safe,...overrides.options});
  controller.on('change', state=>statuses.push(state));t.after(()=>controller.stop());
  return {controller,port,calls,statuses,path,setSafe:value=>{safe=value;}};
}
test('numeric stable versions ignore equal, older and prerelease channels',()=>{
  assert.equal(isNewerStableVersion('0.10.0','0.9.0'),true);
  for(const v of ['0.2.0','0.1.9','0.3.0-beta.1','0.3.0+test','01.3.0','next'])assert.equal(isNewerStableVersion(v,'0.2.0'),false,v);
  assert.equal(readUpdateArtifact(metadata('0.2.0'),'0.2.0'),null);
  assert.equal(readUpdateArtifact(metadata('0.3.0-beta.1'),'0.2.0'),null);
});
test('manifest pins version directory, one x64 offline installer and SHA512',()=>{
  assert.equal(readUpdateArtifact(metadata(),'0.2.0').filename,'Rufa-DSH-0.3.0-x64-Setup.exe');
  const good=metadata();good.files[0].url=COMPANY_UPDATE_FEED+good.files[0].url;assert.ok(readUpdateArtifact(good,'0.2.0'));
  const invalid=[m=>m.files[0].url='https://outside.invalid/a.exe',m=>m.files[0].url='../a.exe',m=>m.files[0].url=m.files[0].url.replace('x64','arm64'),
    m=>m.files[0].url=m.files[0].url.replace('releases/0.3.0','releases/0.2.0'),m=>m.files[0].sha512='bad',m=>m.files[0].size=0,
    m=>m.files.push({...m.files[0]}),m=>m.packages={},m=>m.path='other.exe',m=>m.sha512='other'];
  for(const mutate of invalid){const m=metadata();mutate(m);assert.throws(()=>readUpdateArtifact(m,'0.2.0'));}
});
test('network allowlist rejects redirects and encoded paths beyond fixed release files',()=>{
  assert.equal(allowedUpdateRequest(COMPANY_UPDATE_FEED+'latest.yml?noCache=1'),true);
  assert.equal(allowedUpdateRequest(COMPANY_UPDATE_FEED+metadata().path),true);
  for(const url of ['https://evil.invalid/latest.yml',COMPANY_UPDATE_FEED+'../../admin/users',COMPANY_UPDATE_FEED+'releases/0.2.0/Rufa-DSH-0.3.0-x64-Setup.exe',
    COMPANY_UPDATE_FEED+'releases/0.3.0/%2fsecret.exe',COMPANY_UPDATE_FEED+'latest.yml#x',COMPANY_UPDATE_FEED.replace('https:','http:'),'file:///C:/evil.exe']) assert.equal(allowedUpdateRequest(url),false,url);
});
test('development skips the updater factory and installation entirely',async t=>{
  const f=await fixture(t,{options:{enabled:false}});assert.equal(await f.controller.start(),true);
  assert.equal(f.controller.state.phase,'skipped');assert.equal(f.calls.factory,0);assert.equal(f.calls.install,0);
});
test('up-to-date and older releases open the gate without download',async t=>{
  for(const version of ['0.2.0','0.1.0','0.3.0-rc.1']){const f=await fixture(t,{port:{check:async()=>metadata(version)}});
    assert.equal(await f.controller.start(),true);assert.equal(f.controller.state.phase,'current');assert.equal(f.calls.download,0);assert.equal(f.calls.install,0);}
});
test('new release emits real bytes, verifies actual file then installs only in the startup gate',async t=>{
  const f=await fixture(t);let passed=false;f.controller.start().then(()=>passed=true);await until(()=>f.calls.install===1);
  assert.equal(passed,false);assert.equal(f.controller.blocking,true);
  assert.ok(f.statuses.some(s=>s.phase==='downloading'&&s.transferred===Math.floor(content.length/2)));
  assert.ok(f.statuses.some(s=>s.phase==='verifying'));assert.equal(f.controller.state.verified,content.length);
  f.controller.retry();f.controller.continueCurrent();await tick();assert.equal(f.calls.install,1);
  assert.equal(JSON.stringify(f.controller.state).includes(f.path),false);
});
test('checksum and truncation failures never install, and remain recoverable',async t=>{
  for(const bytes of [Buffer.alloc(content.length,1),content.subarray(0,5)]){const f=await fixture(t);await writeFile(f.path,bytes);
    const gate=f.controller.start();await until(()=>f.controller.state.phase==='error');assert.equal(f.calls.install,0);
    f.controller.continueCurrent();assert.equal(await gate,true);assert.equal(f.controller.blocking,false);}
});
test('verification detects a file changed while being hashed',async t=>{
  const f=await fixture(t), artifact=readUpdateArtifact(metadata(),'0.2.0');
  await assert.rejects(verifyUpdateArtifact(f.path,artifact,new AbortController().signal,()=>{writeFileSync(f.path,Buffer.alloc(content.length+1,4));}));
  assert.equal(f.calls.install,0);
});
test('offline failure redacts errors, retry uses a new attempt and ignores duplicate clicks',async t=>{
  const pending=defer();let checks=0;const f=await fixture(t,{port:{check:async()=>{if(++checks===1)throw new Error('https://user:secret@evil.invalid Bearer private');return pending.promise;}}});
  const gate=f.controller.start();await until(()=>f.controller.state.phase==='error');assert.doesNotMatch(JSON.stringify(f.controller.state),/secret|Bearer|evil/);
  f.controller.retry();f.controller.retry();assert.equal(f.calls.factory,2);pending.resolve(metadata('0.2.0'));assert.equal(await gate,true);assert.equal(f.calls.install,0);
});
test('check timeout permits continue; late check cannot download or install',async t=>{
  const pending=defer();const f=await fixture(t,{port:{check:()=>pending.promise},options:{checkTimeoutMs:20}});
  const gate=f.controller.start();await until(()=>f.controller.state.phase==='error');f.controller.continueCurrent();assert.equal(await gate,true);
  pending.resolve(metadata());await tick();f.controller.retry();assert.equal(f.calls.download,0);assert.equal(f.calls.install,0);
});
test('download idle timeout cancels and late completion cannot install after workbench admission',async t=>{
  const pending=defer();let signal;const f=await fixture(t,{port:{download:async s=>{signal=s;return pending.promise;}},options:{idleTimeoutMs:20}});
  const gate=f.controller.start();await until(()=>f.controller.state.phase==='error');assert.equal(signal.aborted,true);
  f.controller.continueCurrent();assert.equal(await gate,true);pending.resolve([f.path]);await tick();assert.equal(f.calls.install,0);
});
test('unsafe or cancelled startup after verification never starts the installer',async t=>{
  const verify=defer(), f=await fixture(t,{options:{verify:()=>verify.promise}});const gate=f.controller.start();await until(()=>f.controller.state.phase==='verifying');
  f.setSafe(false);verify.resolve();await until(()=>f.controller.state.phase==='error');assert.equal(f.calls.install,0);f.controller.continueCurrent();assert.equal(await gate,true);
  const second=await fixture(t,{options:{verify:()=>new Promise(()=>{})}});const stopped=second.controller.start();await until(()=>second.controller.state.phase==='verifying');second.controller.stop();assert.equal(await stopped,false);assert.equal(second.calls.install,0);
});
test('reentrant safety change when preparing installation is checked again',async t=>{
  const f=await fixture(t);f.controller.on('change',s=>{if(s.phase==='installing')f.setSafe(false);});f.controller.start();await until(()=>f.controller.state.phase==='error');assert.equal(f.calls.install,0);
});
test('synchronous installer launch error stays on startup recovery screen',async t=>{
  const f=await fixture(t,{port:{install:onError=>onError()}});f.controller.start();await until(()=>f.controller.state.phase==='error');assert.equal(f.controller.blocking,true);
});
test('adapter disables automatic exit install, pins transport and cancels the exact download token',async()=>{
  class FakeUpdater extends EventEmitter {
    requestHooks={};netSession={webRequest:{onBeforeRequest:fn=>this.requestHooks.request=fn,onBeforeSendHeaders:fn=>this.requestHooks.headers=fn}};
    cancelCount=0;token={cancel:()=>this.cancelCount++};setFeedURL(value){this.feed=value;}
    async checkForUpdates(){return {updateInfo:metadata(),cancellationToken:this.token};}
    async downloadUpdate(token){this.usedToken=token;return ['synthetic-path'];}
    quitAndInstall(...args){this.installArgs=args;}
  }
  const fake=new FakeUpdater(), adapter=createCompanyUpdater(fake), abort=new AbortController();
  assert.equal(fake.autoDownload,false);assert.equal(fake.autoInstallOnAppQuit,false);assert.equal(fake.allowDowngrade,false);assert.equal(fake.allowPrerelease,false);
  assert.equal(fake.disableWebInstaller,true);assert.equal(fake.disableDifferentialDownload,true);assert.equal(fake.requestHeaders,null);assert.equal(fake.feed.url,COMPANY_UPDATE_FEED);
  let result;fake.requestHooks.request({url:'https://evil.invalid/redirect.exe'},v=>result=v);assert.equal(result.cancel,true);
  fake.requestHooks.headers({requestHeaders:{Authorization:'secret',Cookie:'session',Accept:'*/*','X-Api-Key':'secret'}},v=>result=v);
  assert.deepEqual(result.requestHeaders,{Accept:'*/*'});
  await adapter.check(abort.signal);await adapter.download(abort.signal,()=>{});assert.equal(fake.usedToken,fake.token);
  adapter.install(()=>{});assert.deepEqual(fake.installArgs,[true,true]);adapter.dispose();assert.equal(fake.cancelCount,1);assert.throws(()=>adapter.install(()=>{}));
});
test('loading presentation uses download and verification bytes and exposes recovery only for errors',()=>{
  const value=updatePresentation({phase:'downloading',currentVersion:'0.2.0',targetVersion:'0.3.0',transferred:1024,total:4096,bytesPerSecond:512});
  assert.equal(value.percent,25);assert.match(value.detail,/1.0 KB \/ 4.0 KB/);assert.equal(value.continueCurrent,false);
  const verifying=updatePresentation({phase:'verifying',currentVersion:'0.2.0',transferred:4096,verified:2048,total:4096});assert.equal(verifying.percent,50);
  assert.equal(updatePresentation({phase:'current'}),null);assert.equal(updatePresentation({phase:'error',canRetry:true,canContinue:true}).continueCurrent,true);
});
test('installer quits only on actual spawn and keeps exact per-user NSIS flags',()=>{
  const child=new EventEmitter();let unref=0,started=0,failed=0,call;child.unref=()=>unref++;
  launchStartupInstaller({installerPath:join(tmpdir(),'Rufa-DSH-0.3.0-x64-Setup.exe'),isAdminRightsRequired:false,started:()=>started++,failed:()=>failed++},(...args)=>{call=args;return child;});
  assert.equal(started,0);assert.deepEqual(call[1],['--updated','/currentuser','--force-run']);assert.equal(call[2].shell,false);assert.equal(call[2].windowsHide,false);
  child.emit('spawn');assert.equal(started,1);assert.equal(unref,1);child.emit('error',new Error('late'));assert.equal(failed,0);
});
test('failed installer launch never quits later or falls back to elevation/shell',()=>{
  for(const synchronous of [false,true]){
    const child=new EventEmitter();child.unref=()=>{};let started=0,failed=0,launches=0;
    launchStartupInstaller({installerPath:join(tmpdir(),'Rufa-DSH-0.3.0-x64-Setup.exe'),isAdminRightsRequired:false,started:()=>started++,failed:()=>failed++},()=>{launches++;if(synchronous)throw new Error('spawn error');return child;});
    if(!synchronous){child.emit('error',Object.assign(new Error('denied'),{code:'EACCES'}));child.emit('spawn');}
    assert.equal(started,0);assert.equal(failed,1);assert.equal(launches,1);
  }
  let launches=0,failed=0;
  launchStartupInstaller({installerPath:join(tmpdir(),'Rufa-DSH-0.3.0-x64-Setup.exe'),isAdminRightsRequired:true,started:()=>assert.fail('unexpected quit'),failed:()=>failed++},()=>{launches++;});
  assert.equal(launches,0);assert.equal(failed,1);
});
test('actual IPC rejects workbench/subframes and startup commands cannot accept URLs or run after startup',async()=>{
  const source=await readFile(new URL('../dist/main.js',import.meta.url),'utf8');
  const mainFrame={url:pathToFileURL('C:/synthetic/renderer/index.html').href}, contents={mainFrame};let handler;
  const section=source.slice(source.indexOf("ipcMain.handle('rufa:command'"),source.indexOf("ipcMain.handle('rufa:account-change-password'"));
  const calls=[];vm.runInNewContext(section,{ipcMain:{handle:(_name,fn)=>handler=fn},win:{webContents:contents},pathToFileURL,uiFile:'C:/synthetic/renderer/index.html',CompanyError,command:async(...args)=>calls.push(args)});
  await assert.rejects(handler({sender:{},senderFrame:mainFrame},'update.retry'));
  await assert.rejects(handler({sender:contents,senderFrame:{url:mainFrame.url}},'update.retry'));assert.equal(calls.length,0);
  await handler({sender:contents,senderFrame:mainFrame},'update.retry');assert.equal(calls.length,1);
  const command=source.slice(source.indexOf('async function command('),source.indexOf('async function main('));let retried=0;
  const ctx=vm.createContext({booting:true,startupUpdate:{blocking:true,retry(){retried++;},continueCurrent(){}},api:{state:{user:null}},view:null,quitting:false,state:()=>({}),CompanyError});
  vm.runInContext(command,ctx);await assert.rejects(ctx.command('update.retry',{url:'https://evil.invalid'}),{code:'INVALID_INPUT'});
  await assert.rejects(ctx.command('login',{}),{code:'STARTUP_PENDING'});await ctx.command('update.retry');assert.equal(retried,1);
  ctx.booting=false;await assert.rejects(ctx.command('update.retry'),{code:'UPDATE_CLOSED'});assert.equal(retried,1);
});
test('actual renderer retry disables synchronously and coalesces rapid failures without blocking continue',async()=>{
  const source=await readFile(new URL('../src/renderer/app.js',import.meta.url),'utf8');
  const section=source.slice(source.indexOf('function updateRecoveryControls()'),source.indexOf('function show('));
  const buttons={'update-retry':{disabled:false},'update-continue':{disabled:false}},calls=[],timers=[];
  const context=vm.createContext({$:id=>buttons[id],call:async action=>{calls.push(action);},guarded:task=>task(),setTimeout:fn=>timers.push(fn)});
  vm.runInContext('let updateActionPending=false,updateRetryCooling=false;\n'+section,context);
  const first=context.updateAction('update.retry');assert.equal(buttons['update-retry'].disabled,true);await context.updateAction('update.retry');await first;
  await context.updateAction('update.retry');assert.deepEqual(calls,['update.retry']);
  assert.equal(buttons['update-continue'].disabled,false);await context.updateAction('update.continue');assert.deepEqual(calls,['update.retry','update.continue']);
  timers.shift()();await context.updateAction('update.retry');assert.deepEqual(calls,['update.retry','update.continue','update.retry']);
});
