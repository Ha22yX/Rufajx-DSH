// Full offline payload acceptance using the production native bootstrap/trust.
// A tiny test ASAR records startup and exits, so no business profile or model
// call can be started. The real Electron executable also changes version,
// representing the large binary that a typical app release replaces.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {cp,mkdir,readFile,writeFile,stat,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {readUpdateSigningKey} from './client-update-signing.mjs';
import {IncrementalUpdateController} from '../apps/client/dist/incremental-update.js';
const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
assert.ok(args.get('--unpacked'));assert.ok(args.get('--private-key'));
// Short unique fixture paths keep legacy MAX_PATH coverage while all test
// material stays under the same managed parent, never at the volume root.
const testParent='D:/ProgramData/RufaDSH/Tests/i';await mkdir(testParent,{recursive:true});
const source=resolve(args.get('--unpacked')),evidence=join(testParent,randomUUID().slice(0,8)),root=join(evidence,'installed');await mkdir(evidence);
console.log(`Full incremental evidence: ${evidence}`);
const copied=await run('robocopy.exe',[source,root,'/E','/COPY:DAT','/DCOPY:DAT','/XJ','/R:1','/W:1','/MT:16','/NFL','/NDL','/NJH','/NJS','/NP']).done;
assert.ok(copied.code!==null&&copied.code<8,'Full isolated fixture copy failed: '+copied.out);
const area=join(root,'.rufa-update'),baseline=JSON.parse(await readFile(join(area,'current-manifest.json'),'utf8'));
const signer=await readUpdateSigningKey(args.get('--private-key'));
function run(exe,argv,options={}){const child=spawn(exe,argv,{windowsHide:true,stdio:['ignore','pipe','pipe'],...options});let out='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>out+=x);const done=new Promise((a,r)=>{child.once('error',r);child.once('exit',code=>a({code,out}));});return {child,done};}
const require=createRequire(new URL('../package.json',import.meta.url)),asar=require('@electron/asar');
const {editWindowsResources}=require('app-builder-lib/out/util/resEdit.js');
async function appArchive(version,destination){const folder=join(evidence,'app-'+version);await mkdir(folder);await writeFile(join(folder,'package.json'),JSON.stringify({name:'rufa-incremental-fixture',version,main:'main.cjs'}));await writeFile(join(folder,'main.cjs'),`const{app}=require('electron');const{join}=require('node:path');const{mkdirSync,writeFileSync}=require('node:fs');const root=join(process.resourcesPath,'..');const profile=join(root,'.fixture-user-data');mkdirSync(profile,{recursive:true});app.setPath('userData',profile);app.setPath('sessionData',profile);app.setAppLogsPath(join(profile,'logs'));app.whenReady().then(()=>{writeFileSync(join(root,'fixture-opened.txt'),app.getVersion());app.exit(0);});`);await asar.createPackage(folder,destination);}
await appArchive('0.3.0',join(root,'resources/app.asar'));await appArchive('0.3.1',join(evidence,'next.asar'));
await cp(join(root,'Rufajx-DSH-App.exe'),join(evidence,'next-app.exe'));
await editWindowsResources({file:join(evidence,'next-app.exe'),fileVersion:'0.3.1',productVersion:'0.3.1.0',versionStrings:{ProductName:'Rufajx-DSH',FileDescription:'Rufajx-DSH'}});
const entry=(path,bytes)=>({path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),sha512:createHash('sha512').update(bytes).digest('base64')});
const archive=entry('resources/app.asar',await readFile(join(root,'resources/app.asar')));baseline.files=baseline.files.map(f=>f.path===archive.path?archive:f);
const changes=new Map([['Rufajx-DSH-App.exe',await readFile(join(evidence,'next-app.exe'))],['resources/app.asar',await readFile(join(evidence,'next.asar'))]]);
const next={...baseline,version:'0.3.1',files:baseline.files.filter(f=>!changes.has(f.path)).concat([...changes].map(([p,b])=>entry(p,b))).sort((a,b)=>a.path.localeCompare(b.path))};
async function signed(prefix,value){const bytes=Buffer.from(JSON.stringify(value)+'\n'),descriptor={url:`releases/${value.version}/incremental-manifest.json`,size:bytes.length,sha512:createHash('sha512').update(bytes).digest('base64'),algorithm:'rsa-sha256',keyId:signer.keyId,signature:signer.sign(bytes)};const envelope={schema:1,version:value.version,releaseDate:value.releaseDate,minUpdaterVersion:value.minUpdaterVersion,manifest:descriptor};await writeFile(join(area,prefix+'-manifest.json'),bytes);await writeFile(join(area,prefix+'.json'),JSON.stringify(envelope));return {bytes,envelope};}
await signed('current',baseline);const target=await signed('pending',next);
const blobs=new Map([...changes].map(([p,b])=>[entry(p,b).sha256,b]));let staged=false,downloadedBytes=0,downloadedFiles=0;
const preparationStart=performance.now();
const controller=new IncrementalUpdateController({root,currentVersion:'0.3.0',trust:{keyId:signer.keyId,publicKey:signer.publicKey},canInstall:()=>true,createFallback:()=>{throw Error('Unexpected fallback');},launch:async()=>{},onHandoff:()=>{staged=true;},fetch:async(url)=>{
  if(url.endsWith('/incremental/latest.json'))return Response.json({...target.envelope,installer:{url:'releases/0.3.1/Rufa-DSH-0.3.1-x64-Setup.exe',size:1,sha512:entry('x',Buffer.from('x')).sha512}});
  if(url.endsWith('/incremental-manifest.json'))return new Response(target.bytes);
  const key=url.split('/').at(-1);assert.ok(blobs.has(key),'Only changed payloads may be requested');const bytes=blobs.get(key);downloadedBytes+=bytes.length;downloadedFiles++;return new Response(bytes);
}});
controller.start();for(let i=0;!staged;i++){assert.notEqual(controller.state.phase,'error','Full file comparison/download failed');assert.ok(i<30000,'Comparison timed out');await new Promise(r=>setTimeout(r,20));}
const preparationSeconds=(performance.now()-preparationStart)/1000;controller.stop();assert.equal(downloadedFiles,changes.size);
const samples=baseline.files.filter(f=>f.size>10000000&&!changes.has(f.path)).map(f=>f.path);
const before=new Map(await Promise.all(samples.map(async p=>[p,await stat(join(root,p))])));
const helper=run(join(root,'Rufajx-DSH.exe'),['--apply-update','2147483646'],{windowsHide:false,stdio:['pipe','pipe','pipe']});
const start=performance.now();let seen='';await new Promise((a,r)=>{const timer=setTimeout(()=>r(Error('Native update did not become ready')),15000);helper.child.stdout.on('data',b=>{seen+=b;if(seen==='RUFA_UPDATE_READY\n'){clearTimeout(timer);a();}});helper.child.once('exit',()=>{clearTimeout(timer);r(Error('Native update exited before ready'));});});
const monitor=run(join(root,'Rufajx-DSH.exe'),[],{windowsHide:false});
const observer=await run('powershell.exe',['-NoProfile','-Command',`for($i=0;$i -lt 50;$i++){$p=Get-Process -Id ${monitor.child.pid} -ErrorAction Stop;$p.Refresh();if($p.MainWindowHandle -ne 0){Write-Output visible;exit 0};Start-Sleep -Milliseconds 100};exit 1`]).done;
assert.equal(observer.code,0,'Repeated shortcut must show a progress window');assert.match(observer.out,/visible/);
helper.child.stdin.end('APPLY\n');
const timer=setTimeout(()=>helper.child.kill(),300000),result=await helper.done;clearTimeout(timer);assert.equal(result.code,0,result.out);const seconds=(performance.now()-start)/1000;
await run('powershell.exe',['-NoProfile','-Command',`$p=Get-Process -Id ${monitor.child.pid} -ErrorAction Stop;[void]$p.CloseMainWindow()`]).done;assert.equal((await monitor.done).code,0);
assert.equal(await readFile(join(root,'fixture-opened.txt'),'utf8'),'0.3.1');assert.equal(JSON.parse(await readFile(join(area,'current.json'),'utf8')).version,'0.3.1');
for(const [p,b]of changes)assert.deepEqual(await readFile(join(root,p)),b);
for(const [p,old]of before){const now=await stat(join(root,p));assert.equal(now.ino,old.ino,p);assert.equal(now.mtimeMs,old.mtimeMs,p);assert.equal(now.size,old.size,p);}
await assert.rejects(access(join(area,'transaction')));
const report={passed:true,nativeInstallationSeconds:seconds,preparationSeconds,totalFiles:baseline.files.length,totalBytes:baseline.files.reduce((n,f)=>n+f.size,0),changedFiles:changes.size,payloadBytes:[...changes.values()].reduce((n,b)=>n+b.length,0),downloadedFiles,downloadedBytes,unchangedLargeFileIdentitiesPreserved:samples.length,repeatedShortcutShowsProgress:true,automaticRelaunch:true,sourceUnchanged:true,evidence,scope:'Full real offline payload, real client comparison and production signed updater; real Electron version change with test ASAR exit recorder; in-memory transport excludes Internet download time; no company profile'};
await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
