import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, cp, stat, access, unlink, rename, symlink } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'rufa-native-update-'));
const keys = generateKeyPairSync('rsa', { modulusLength: 3072 }), jwk = keys.publicKey.export({ format: 'jwk' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const keyId = hash(keys.publicKey.export({ format: 'der', type: 'spki' }));
const entry = (path, bytes) => ({ path, size: bytes.length, sha256: hash(bytes), sha512: createHash('sha512').update(bytes).digest('base64') });
const source = fileURLToPath(new URL('../scripts/updater/Bootstrap.cs', import.meta.url));
await writeFile(join(root, 'Trust.cs'), `internal static class UpdateTrust { internal const string KeyId="${keyId}"; internal const string Modulus="${Buffer.from(jwk.n, 'base64url').toString('base64')}"; internal const string Exponent="${Buffer.from(jwk.e, 'base64url').toString('base64')}"; }`);
// A separate test entrypoint invokes the unchanged production transaction core.
// It never calls the UI or touches a real installed application.
await writeFile(join(root, 'Harness.cs'), `using System; using System.IO; using System.Reflection; class TestEntry {
 static int Main(string[] args) { try { Directory.CreateDirectory(Bootstrap.Area); if(args[0]=="CheckRoot") { typeof(Bootstrap).GetField("Root",BindingFlags.Static|BindingFlags.NonPublic).SetValue(null,args[1]);Bootstrap.NoLinks(args[1]);return 0; } var method=typeof(Bootstrap).GetMethod(args[0],BindingFlags.Static|BindingFlags.NonPublic); method.Invoke(null,null); return 0; } catch(Exception ex) { Console.Error.WriteLine(ex.ToString()); return 2; } }
}`);
function run(file, args, options = {}) {
  const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options }); let output = '';
  child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, output })); });
  return { child, done };
}
const compiled = await run(join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/main:TestEntry', `/out:${join(root, 'test.exe')}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', source, join(root, 'Trust.cs'), join(root, 'Harness.cs')]).done;
assert.equal(compiled.code, 0, compiled.output);
function release(version, files) {
  const manifest = { schema: 1, version, platform: 'win32', arch: 'x64', releaseDate: '2026-10-21T00:00:00.000Z', minUpdaterVersion: '0.3.0', files };
  const bytes = Buffer.from(JSON.stringify(manifest));
  return { bytes, envelope: Buffer.from(JSON.stringify({ schema: 1, version, releaseDate: manifest.releaseDate, minUpdaterVersion: '0.3.0',
    manifest: { url: `releases/${version}/incremental-manifest.json`, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64'), keyId, algorithm: 'rsa-sha256', signature: sign('RSA-SHA256', bytes, keys.privateKey).toString('base64') } })) };
}
async function fixture(count = 3) {
  const path = await mkdtemp(join(root, 'installation-')); await cp(join(root, 'test.exe'), join(path, 'test.exe'));
  const area = join(path, '.rufa-update'); await mkdir(join(area, 'download'), { recursive: true });
  const old = new Map([['Rufajx-DSH-App.exe', Buffer.from('fake-app')], ['resources/app.asar', Buffer.from('old asar')], ['unchanged.txt', Buffer.from('untouched')], ['removed.txt', Buffer.from('old managed')]]);
  for (let i = 0; i < count; i++) old.set(`resources/changes/${i}.txt`, Buffer.from('old ' + i));
  const next = new Map(old); next.set('resources/app.asar', Buffer.from('new asar')); next.delete('removed.txt'); next.set('new.txt', Buffer.from('created'));
  for (let i = 0; i < count; i++) next.set(`resources/changes/${i}.txt`, Buffer.from('new ' + i));
  for (const [name, bytes] of old) { await mkdir(dirname(join(path, name)), { recursive: true }); await writeFile(join(path, name), bytes); }
  await writeFile(join(path, 'unknown-user.txt'), 'preserve');
  const prior = release('0.3.0', [...old].map(([name, bytes]) => entry(name, bytes))), target = release('0.3.1', [...next].map(([name, bytes]) => entry(name, bytes)));
  for (const [prefix, value] of [['current', prior], ['pending', target]]) { await writeFile(join(area, prefix + '.json'), value.envelope); await writeFile(join(area, prefix + '-manifest.json'), value.bytes); }
  for (const bytes of next.values()) await writeFile(join(area, 'download', hash(bytes)), bytes);
  return { path, area, old, next, apply: () => run(join(path, 'test.exe'), ['Apply']), recover: () => run(join(path, 'test.exe'), ['Recover']) };
}
async function expectFiles(f, map) { for (const [name, bytes] of map) assert.deepEqual(await readFile(join(f.path, name)), bytes, name); assert.equal(await readFile(join(f.path, 'unknown-user.txt'), 'utf8'), 'preserve'); }

test('native RSA verifier installs only changed files, removes signed obsolete files and keeps untouched identities', async () => {
  const f = await fixture(), before = await stat(join(f.path, 'unchanged.txt')); const result = await f.apply().done; assert.equal(result.code, 0, result.output);
  await expectFiles(f, f.next); await assert.rejects(access(join(f.path, 'removed.txt')));
  const after = await stat(join(f.path, 'unchanged.txt')); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(JSON.parse(await readFile(join(f.area, 'current.json'), 'utf8')).version, '0.3.1'); await assert.rejects(access(join(f.area, 'transaction')));
});
test('native verifier rejects corrupted signed manifest and corrupted payload without changing installed files', async () => {
  for (const fault of ['signature', 'payload']) {
    const f = await fixture();
    if (fault === 'signature') { const envelope = JSON.parse(await readFile(join(f.area, 'pending.json'), 'utf8')); envelope.manifest.signature = Buffer.alloc(384).toString('base64'); await writeFile(join(f.area, 'pending.json'), JSON.stringify(envelope)); }
    else await writeFile(join(f.area, 'download', hash(Buffer.from('new asar'))), 'corrupted');
    const result = await f.apply().done; assert.equal(result.code, 2); await expectFiles(f, f.old);
    if (fault === 'payload') { const recovery = await f.recover().done; assert.equal(recovery.code, 0, recovery.output); }
  }
});
test('a forged committed journal cannot publish a version while actual signed target files are missing', async () => {
  const f=await fixture(); const tx=join(f.area,'transaction');await mkdir(tx);
  const bytes=await readFile(join(f.area,'pending-manifest.json'));await cp(join(f.area,'pending.json'),join(tx,'target.json'));await writeFile(join(tx,'target-manifest.json'),bytes);
  await writeFile(join(tx,'journal.json'),JSON.stringify({Schema:1,State:'committed',ManifestHash:hash(bytes),Items:[]}));
  const result=await f.recover().done;assert.equal(result.code,2);await expectFiles(f,f.old);
  assert.equal(JSON.parse(await readFile(join(f.area,'current.json'),'utf8')).version,'0.3.0');
});
test('without a baseline real PE versions normalize only a zero fourth part and never delete unknown old files', async () => {
  for (const version of ['0.3.0.0','0.3.2.0','0.3.0.1','0.3.0-beta']) {
    const f=await fixture(1); const appSource=join(f.path,'VersionedApp.cs');
    await writeFile(appSource,`using System.Reflection; [assembly:AssemblyFileVersion("0.3.0.0")] [assembly:AssemblyInformationalVersion("${version}")] class App { static void Main() {} }`);
    const built=await run(join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:winexe',`/out:${join(f.path,'Rufajx-DSH-App.exe')}`,appSource]).done;assert.equal(built.code,0,built.output);
    const app=await readFile(join(f.path,'Rufajx-DSH-App.exe'));f.old.set('Rufajx-DSH-App.exe',app);f.next.set('Rufajx-DSH-App.exe',app);
    const target=release('0.3.1',[...f.next].map(([name,bytes])=>entry(name,bytes)));await writeFile(join(f.area,'pending.json'),target.envelope);await writeFile(join(f.area,'pending-manifest.json'),target.bytes);
    await unlink(join(f.area,'current.json'));await unlink(join(f.area,'current-manifest.json'));
    const result=await f.apply().done;
    if(version==='0.3.0.0') {
      assert.equal(result.code,0,result.output);await expectFiles(f,f.next);
      assert.equal(JSON.parse(await readFile(join(f.area,'current.json'),'utf8')).version,'0.3.1');
    } else { assert.equal(result.code,2,version);await expectFiles(f,f.old);await assert.rejects(access(join(f.area,'current.json'))); }
    assert.deepEqual(await readFile(join(f.path,'removed.txt')),f.old.get('removed.txt'),'missing baseline cannot authorize deleting old files');
  }
});
test('native fresh ancestor queries reject junctions at the root and within the managed tree', async () => {
  const f=await fixture(1),outside=await mkdtemp(join(root,'outside-'));
  await writeFile(join(outside,'0.txt'),f.old.get('resources/changes/0.txt'));
  await rename(join(f.path,'resources/changes'),join(f.path,'resources/original-changes'));
  await symlink(outside,join(f.path,'resources/changes'),'junction');
  const blocked=await f.apply().done;assert.equal(blocked.code,2);await expectFiles(f,f.old);
  assert.deepEqual(await readFile(join(outside,'0.txt')),f.old.get('resources/changes/0.txt'));await assert.rejects(access(join(f.area,'transaction')));
  const direct=await run(join(f.path,'test.exe'),['CheckRoot',f.path]).done;assert.equal(direct.code,0,direct.output);
  const alias=join(root,'root-junction');await symlink(f.path,alias,'junction');
  assert.equal((await run(join(f.path,'test.exe'),['CheckRoot',alias]).done).code,2);
  assert.equal((await run(join(f.path,'test.exe'),['CheckRoot',join(alias,'resources')]).done).code,2);
});
test('hard-killed native install resumes through rollback and can apply the same signed release afterwards', async () => {
  const f = await fixture(240); let child, killed = false;
  const watcher = watch(f.area, async (_event, name) => {
    if (killed || name !== 'status.json' || !child) return;
    try { const state = JSON.parse(await readFile(join(f.area, 'status.json'), 'utf8')); if (state.phase === 'installing' && state.completed > 0 && state.completed < state.total) { killed = true; child.kill('SIGKILL'); } } catch { }
  });
  const running = f.apply(); child = running.child; const result = await running.done; watcher.close(); assert.equal(killed, true, result.output); assert.notEqual(result.code, 0);
  const journal = JSON.parse(await readFile(join(f.area, 'transaction/journal.json'), 'utf8')); assert.equal(journal.Items.some(item => item.Started), true);
  const recovered = await f.recover().done; assert.equal(recovered.code, 0, recovered.output); await expectFiles(f, f.old); await assert.rejects(access(join(f.path, 'new.txt')));
  assert.equal(JSON.parse(await readFile(join(f.area, 'current.json'), 'utf8')).version, '0.3.0');
  const retried = await f.apply().done; assert.equal(retried.code, 0, retried.output); await expectFiles(f, f.next);
});
test('real native launcher keeps a shared run lock and visible helper completes the ready/apply handoff', async () => {
  const f = await fixture(1);
  await writeFile(join(root, 'App.cs'), `using System; using System.IO; using System.Threading; using System.Diagnostics; class App { static void Main() { var root=AppDomain.CurrentDomain.BaseDirectory; File.WriteAllText(Path.Combine(root,"app-pid.txt"),Process.GetCurrentProcess().Id.ToString()); while(!File.Exists(Path.Combine(root,"exit-app"))) Thread.Sleep(10); } }`);
  const appBuilt = await run(join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo','/target:winexe', `/out:${join(f.path, 'Rufajx-DSH-App.exe')}`, join(root, 'App.cs')]).done; assert.equal(appBuilt.code, 0, appBuilt.output);
  const nativeBuilt = await run(join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo','/target:winexe','/platform:x64', `/out:${join(f.path,'Rufajx-DSH.exe')}`, '/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',source,join(root,'Trust.cs')]).done; assert.equal(nativeBuilt.code,0,nativeBuilt.output);
  const app = await readFile(join(f.path,'Rufajx-DSH-App.exe')); f.old.set('Rufajx-DSH-App.exe',app); f.next.set('Rufajx-DSH-App.exe',app);
  for (const [prefix,version,map] of [['current','0.3.0',f.old],['pending','0.3.1',f.next]]) {
    const value=release(version,[...map].map(([name,bytes])=>entry(name,bytes))); await writeFile(join(f.area,prefix+'.json'),value.envelope);await writeFile(join(f.area,prefix+'-manifest.json'),value.bytes);
  }
  const launcher=run(join(f.path,'Rufajx-DSH.exe'),[]);
  let pid;
  for(let i=0;i<500;i++){try{pid=Number(await readFile(join(f.path,'app-pid.txt'),'utf8'));if(pid)break;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(pid,'normal launcher must start app while holding run lock');
  const helper=spawn(join(f.path,'Rufajx-DSH.exe'),['--apply-update',String(pid)],{windowsHide:false,stdio:['pipe','pipe','pipe']});
  const done=new Promise((resolve,reject)=>{helper.once('error',reject);helper.once('exit',code=>resolve(code));});
  let stdout='';const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('visible helper did not become ready')),10000);helper.stdout.on('data',data=>{stdout+=data;if(stdout==='RUFA_UPDATE_READY\n'){clearTimeout(timer);resolve();}});helper.once('exit',()=>{clearTimeout(timer);reject(new Error('helper exited before ready'));});});
  await ready; helper.stdin.end('APPLY\n'); await writeFile(join(f.path,'exit-app'),'exit');
  assert.equal((await launcher.done).code,0);
  const timer=setTimeout(()=>helper.kill('SIGKILL'),20000); const code=await done; clearTimeout(timer);assert.equal(code,0,'visible helper must install, close progress and restart app');
  await expectFiles(f,f.next);assert.equal(JSON.parse(await readFile(join(f.area,'current.json'),'utf8')).version,'0.3.1');
});
test.after(() => { console.log('Native updater evidence: ' + root); });
