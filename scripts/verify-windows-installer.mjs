/** Full-payload Windows installation acceptance under a unique product identity.
 * Never installs, stops, upgrades, or uninstalls the real Rufajx-DSH product.
 * Uses the exact production payload and NSIS include, with an isolated registry
 * identity and executable name so CHECK_APP_RUNNING cannot target the user app.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';

const args = new Map();
for (let i=2; i<process.argv.length; i+=2) {
  assert.ok(['--workspace','--unpacked','--drive','--archive'].includes(process.argv[i]));
  assert.ok(process.argv[i+1]); args.set(process.argv[i], process.argv[i+1]);
}
assert.equal(process.platform,'win32');
// Keep the supported short LocalAppData alias. MSIX realpath adds a long
// package prefix which exceeds the native NSIS compiler's input path limit.
const workspace=resolve(args.get('--workspace'));
const unpacked=resolve(args.get('--unpacked'));
await access(workspace);await access(unpacked);
const drive=(args.get('--drive')??'D:').toUpperCase();
assert.match(drive,/^[A-Z]:$/);
const id=randomUUID().replaceAll('-','');
const name=`Rufa-Installer-Acceptance-${id}`;
const evidence=join(`${drive}/`,'ProgramData','RufaDSH','Tests','evidence',id);
const fixture=join(evidence,'fixture'), output=join(evidence,'output');
const targetRoot=join(`${drive}/`,'ProgramData','RufaDSH','Tests','apps');
await mkdir(targetRoot,{recursive:true});
const target=join(await realpath(targetRoot),id.slice(0,8));
try { await access(target); throw new Error('Fresh acceptance target required'); }
catch (error) { if (error.code!=='ENOENT') throw error; }
await mkdir(fixture,{recursive:true});
const sentinel=join(evidence,'employee-data-sentinel.txt');
await writeFile(sentinel,`private-fixture-${id}`,{flag:'wx'});
const productionInclude=join(workspace,'apps/client/scripts/installer-per-user.nsh');
await access(productionInclude); await access(join(unpacked,'resources/app.asar'));
const include=join(fixture,'observe-installer.nsh'),trace=join(evidence,'progress.txt');
const nsisQuote=value=>value.replaceAll('$','$$').replaceAll('"','$\\"');
await writeFile(include,'\ufeff'+`!macro rufaExtractionProgressObserved
  FileOpen $R8 "${nsisQuote(trace)}" a
  FileSeek $R8 0 END
  FileWrite $R8 "$rufaExtractDone,$rufaExtractTotal,$rufaExtractPercent,$OUTDIR$\\r$\\n"
  FileClose $R8
!macroend
!include "${nsisQuote(productionInclude)}"
`);
const manifest=JSON.parse(await readFile(join(workspace,'apps/client/package.json'),'utf8'));
await writeFile(join(fixture,'package.json'),JSON.stringify({name:name.toLowerCase(),version:manifest.version,
  private:true,description:'Isolated installer validation',author:'Rufa',main:'index.js'}));
await writeFile(join(fixture,'index.js'),'process.exit(0);\n');
const require=createRequire(join(workspace,'package.json'));
const builder=require.resolve('electron-builder/cli.js');
const config={appId:`cn.rufa.dsh.installer-acceptance.${id}`,productName:name,electronVersion:'44.9.0',
  directories:{app:fixture,output},artifactName:'Installer-Validation.exe',
  win:{target:'nsis',executableName:name,signAndEditExecutable:false},
  nsis:{oneClick:false,perMachine:false,allowElevation:false,packElevateHelper:false,include,
    allowToChangeInstallationDirectory:true,createDesktopShortcut:false,createStartMenuShortcut:false,runAfterFinish:false},
  publish:null};
const configuration=join(evidence,'builder.json');
await writeFile(configuration,JSON.stringify(config,null,2));
function run(command,argv,{timeout=1800000,log,cwd=fixture}={}) {
  return new Promise((accept,reject)=>{
    const started=performance.now();
    const child=spawn(command,argv,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let text=''; const collect=data=>{text+=data;};
    child.stdout.on('data',collect); child.stderr.on('data',collect);
    const timer=setTimeout(()=>{child.kill();reject(new Error(`Acceptance process timed out: ${basename(command)}`));},timeout);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',async code=>{clearTimeout(timer);if(log)await writeFile(log,text);
      if(code!==0)reject(new Error(`Acceptance process exited ${code}; ${text.slice(-3000)}`));
      else accept({code,seconds:(performance.now()-started)/1000});});
  });
}
async function inventory(base) {
  const files=[];
  async function walk(dir) {
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      assert.equal(entry.isSymbolicLink(),false,'No linked acceptance payload');
      const file=join(dir,entry.name);
      if(entry.isDirectory())await walk(file);
      else if(entry.isFile())files.push({path:relative(base,file),size:(await stat(file)).size});
    }
  }
  await walk(base);return files;
}
async function hash(file){const h=createHash('sha256');for await(const data of createReadStream(file))h.update(data);return h.digest('hex');}
console.log(`Evidence: ${evidence}`);
console.log('Building isolated installer with complete production payload.');
let reusedArchive;
if(args.has('--archive')){
  // Reuse the actual archive embedded in the final installer. Builder's native
  // up-to-date archive path avoids recompression; installation is still real.
  const source=await realpath(resolve(args.get('--archive')));
  await mkdir(output,{recursive:true});
  const cached=join(output,`${name.toLowerCase()}-${manifest.version}-x64.nsis.7z`);
  await copyFile(source,cached);
  assert.ok((await stat(cached)).mtimeMs>(await stat(unpacked)).mtimeMs);
  assert.equal(await hash(source),await hash(cached));
  reusedArchive={sha256:await hash(cached),source};
}
await run(process.execPath,[builder,'--prepackaged',unpacked,'--config',configuration,'--win','nsis','--x64','--publish','never'],{log:join(evidence,'build.log'),cwd:join(workspace,'apps/client')});
const installer=join(output,'Installer-Validation.exe');
console.log(`Installing full payload to isolated ${drive} directory.`);
const installation=await run(installer,['/S','/currentuser',`/D=${target}`],{log:join(evidence,'installation.log')});
await writeFile(join(evidence,'installation-timing.json'),JSON.stringify(installation,null,2));
const progressLines=(await readFile(trace,'utf8')).trim().split(/\r?\n/).filter(Boolean);
const progress=progressLines.map(line=>{const [done,total,percent,...directory]=line.split(',');return {done:Number(done),total:Number(total),percent:Number(percent),directory:directory.join(',')};});
assert.ok(progress.length>2,'Real extraction must report intermediate progress');
assert.ok(progress.some(row=>row.done>0&&row.done<row.total));
for(const row of progress){
  assert.ok(row.percent>=0&&row.percent<100,'No completion before decoder returns');
  assert.equal(resolve(row.directory).toLowerCase(),resolve(target).toLowerCase(),'Extract directly into the actual installation directory');
}
const files=await inventory(unpacked), missing=[],different=[];
for(const file of files){try{if((await stat(join(target,file.path))).size!==file.size)different.push(file.path);}catch(error){if(error.code==='ENOENT')missing.push(file.path);else throw error;}}
assert.deepEqual(missing,[],'Every production file must be installed');
assert.deepEqual(different,[],'Every installed file must have expected size');
const coreHashes={};
for(const name of ['Rufajx-DSH.exe','resources/app.asar','resources/node/node.exe',
  'resources/company-plugins/remote-persistence.mjs','resources/company-plugins/company-project-migration.mjs',
  'resources/harness/company-python/python.exe','resources/harness/company-tools/remotion/browser/chrome-headless-shell-win64/chrome-headless-shell.exe']) {
  coreHashes[name]=await hash(join(target,name)); assert.equal(coreHashes[name],await hash(join(unpacked,name)));
}
assert.equal(await readFile(sentinel,'utf8'),`private-fixture-${id}`);
const installerSources={};
for(const name of ['7z1900-src.7z','Nsis7z_19.00.7z','License.txt','copying.txt','unRarLicense.txt','README.md','installer.lock.json','patch-nsis7z.mjs','build-nsis7z.ps1','installer-upgrade-temp.cpp','build-upgrade-temp.ps1']){
  const source=join(workspace,'apps/client',/\.(mjs|ps1|cpp)$/.test(name)?'scripts':'preinstalled/installer',name);
  installerSources[name]=await hash(source);
  assert.equal(await hash(join(target,'resources/installer-source',name)),installerSources[name]);
}
console.log('Reinstalling only the same isolated identity to verify the existing-installation path.');
const reinstallation=await run(installer,['/S','/currentuser',`/D=${target}`],{log:join(evidence,'reinstallation.log')});
await writeFile(join(evidence,'reinstallation-timing.json'),JSON.stringify(reinstallation,null,2));
for(const file of files)assert.equal((await stat(join(target,file.path))).size,file.size,`Reinstalled file: ${file.path}`);
for(const [name,expected] of Object.entries(coreHashes))assert.equal(await hash(join(target,name)),expected);
assert.equal(await readFile(sentinel,'utf8'),`private-fixture-${id}`);
const uninstaller=(await readdir(target)).filter(n=>/^Uninstall .+\.exe$/i.test(n));
assert.equal(uninstaller.length,1);
const sub=relative(await realpath(targetRoot),await realpath(target));
assert.ok(sub&&!sub.startsWith('..')&&!isAbsolute(sub));
assert.equal(sub,id,'Only this unique test installation may be uninstalled');
console.log(`Full installation verified in ${installation.seconds.toFixed(1)} s; uninstalling only the isolated test product.`);
const uninstallation=await run(join(target,uninstaller[0]),['/S','/currentuser'],{log:join(evidence,'uninstall.log')});
// NSIS can hand off to a temporary uninstaller and return before file cleanup.
const uninstallDeadline=Date.now()+120000;
while(true){
  const present=await access(join(target,'resources/app.asar')).then(()=>true,()=>false);
  if(!present)break;
  assert.ok(Date.now()<uninstallDeadline,'Isolated uninstall must remove the installed payload');
  await new Promise(resolve=>setTimeout(resolve,500));
}
assert.equal(await readFile(sentinel,'utf8'),`private-fixture-${id}`);
const report={version:manifest.version,fixtureIdentity:name,sourcePayload:unpacked,installationTarget:target,
  fileCount:files.length,logicalBytes:files.reduce((n,f)=>n+f.size,0),installation,reinstallation,uninstallation,coreHashes,installerSources,
  missing,different,reusedArchive,progress:{samples:progress.length,first:progress[0],last:progress.at(-1),directToTarget:true},employeeSentinelPreserved:true,realProductModified:false,paidModelCalls:0};
await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
