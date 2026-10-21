// Real old-to-new NSIS update under a unique product identity, using the final
// embedded payloads. A tiny test executable records StartApp, avoiding launch
// of a company profile. Production includes and old caller flags are preserved.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,writeFile,copyFile,readdir,stat} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {createRequire} from 'node:module';
const options=new Map();for(let i=2;i<process.argv.length;i+=2)options.set(process.argv[i],process.argv[i+1]);
for(const key of ['--workspace','--unpacked','--archive','--old-workspace','--old-unpacked','--old-archive'])assert.ok(options.get(key),key);
const testParent='D:/ProgramData/RufaDSH/Tests/b';await mkdir(testParent,{recursive:true});
const id=randomUUID().replaceAll('-',''),name=`Rufa-Bridge-${id}`,evidence=join(testParent,id.slice(0,8)),target=join(evidence,'installed');
await mkdir(evidence);
function run(exe,args,{cwd=evidence,log,hide=true,timeout=900000}={}){
  const child=spawn(exe,args,{cwd,windowsHide:hide,stdio:['ignore','pipe','pipe']});let output='';const started=performance.now();
  child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const done=new Promise((accept,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Bridge timeout'));},timeout);
    child.once('error',reject);child.once('exit',async code=>{clearTimeout(timer);if(log)await writeFile(log,output);if(code!==0)reject(Error(`Bridge child ${code}: ${output.slice(-2000)}`));else accept({seconds:(performance.now()-started)/1000});});});return {child,done};
}
const compiler=join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const source=join(evidence,'Start.cs'),dummy=join(evidence,name+'.exe');
await writeFile(source,'using System; using System.IO; class Start { static void Main(){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"bridge-relaunched.txt"),"reopened");} }');
await run(compiler,['/nologo','/target:winexe',`/out:${dummy}`,source]).done;
const trace=join(evidence,'progress.txt'),quote=x=>x.replaceAll('$','$$').replaceAll('"','$\\"');
async function build(label,workspace,unpacked,archive){
  const folder=join(evidence,label),fixture=join(folder,'fixture'),output=join(folder,'output');await mkdir(fixture,{recursive:true});await mkdir(output);
  const version=JSON.parse(await readFile(join(workspace,'apps/client/package.json'),'utf8')).version;
  const include=join(fixture,'observe.nsh');let text=await readFile(join(workspace,'apps/client/scripts/installer-per-user.nsh'),'utf8');
  assert.equal(text.split('!macro customFiles_x64').length,2);text=text.replace('!macro customFiles_x64','!macro rufaAcceptanceFiles');
  await writeFile(include,'\ufeff'+`!macro rufaExtractionProgressObserved\n  FileOpen $R8 "${quote(trace)}" a\n  FileSeek $R8 0 END\n  FileWrite $R8 "${label},$rufaExtractDone,$rufaExtractTotal,$rufaExtractPercent$\\r$\\n"\n  FileClose $R8\n!macroend\n`+text+`\n!macro customFiles_x64\n !insertmacro rufaAcceptanceFiles\n SetOutPath "$INSTDIR"\n File /oname=${name}.exe "${quote(dummy)}"\n!macroend\n`);
  await writeFile(join(fixture,'package.json'),JSON.stringify({name:name.toLowerCase(),version,private:true,description:'Legacy bridge acceptance',main:'index.js'}));await writeFile(join(fixture,'index.js'),'process.exit(0);');
  const config={appId:`cn.rufa.bridge.${id}`,productName:name,electronVersion:'44.9.0',directories:{app:fixture,output},artifactName:'Bridge.exe',win:{target:'nsis',executableName:name,signAndEditExecutable:false},nsis:{oneClick:false,perMachine:false,allowElevation:false,packElevateHelper:false,include,allowToChangeInstallationDirectory:true,createDesktopShortcut:false,createStartMenuShortcut:false,runAfterFinish:false},publish:null};
  const configPath=join(folder,'builder.json');await writeFile(configPath,JSON.stringify(config));
  const cached=join(output,`${name.toLowerCase()}-${version}-x64.nsis.7z`);await copyFile(archive,cached);assert.ok((await stat(cached)).mtimeMs>(await stat(unpacked)).mtimeMs);
  const builder=createRequire(join(workspace,'package.json')).resolve('electron-builder/cli.js');
  await run(process.execPath,[builder,'--prepackaged',unpacked,'--config',configPath,'--win','nsis','--x64','--publish','never'],{cwd:join(workspace,'apps/client'),log:join(folder,'build.log')}).done;
  return {installer:join(output,'Bridge.exe'),version};
}
console.log(`Bridge evidence: ${evidence}`);
const old=await build('old',resolve(options.get('--old-workspace')),resolve(options.get('--old-unpacked')),resolve(options.get('--old-archive')));
assert.equal(old.version,'0.2.3');const installed=await run(old.installer,['/S','/currentuser',`/D=${target}`]).done;
const latest=await build('new',resolve(options.get('--workspace')),resolve(options.get('--unpacked')),resolve(options.get('--archive')));
const observe=join(evidence,'Observe.ps1'),windowReport=join(evidence,'window.json');
await writeFile(observe,`param([int]$TargetPid,[string]$OutputFile)\n$seen=$false\n$maxHandle=0\nwhile($p=Get-Process -Id $TargetPid -ErrorAction SilentlyContinue){$p.Refresh();if($p.MainWindowHandle -ne 0){$seen=$true;$maxHandle=$p.MainWindowHandle.ToInt64()};Start-Sleep -Milliseconds 100}\n@{visible=$seen;handle=$maxHandle}|ConvertTo-Json|Set-Content -LiteralPath $OutputFile -Encoding UTF8\n`);
// Exact old startup-installer flags and hidden startup request. The bridge
// must override /S and explicitly show the real progress window itself.
const updating=run(latest.installer,['--updated','/S','/currentuser','--force-run',`/D=${target}`],{hide:true});
const observer=run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',observe,'-TargetPid',String(updating.child.pid),'-OutputFile',windowReport]);
const updated=await updating.done;await observer.done;
const visible=JSON.parse((await readFile(windowReport,'utf8')).replace(/^\uFEFF/,''));assert.equal(visible.visible,true,'Old hidden caller must still show installation progress');
for(let n=0;n<100;n++){try{if(await readFile(join(target,'bridge-relaunched.txt'),'utf8')==='reopened')break;}catch{}await new Promise(r=>setTimeout(r,100));}
assert.equal(await readFile(join(target,'bridge-relaunched.txt'),'utf8'),'reopened','Update must reopen via StartApp');
async function hash(file){const h=createHash('sha256');for await(const c of createReadStream(file))h.update(c);return h.digest('hex');}
const hashes={};for(const file of ['Rufajx-DSH.exe','Rufajx-DSH.exe.config','Rufajx-DSH-App.exe','resources/app.asar','.rufa-update/current.json','.rufa-update/current-manifest.json']){hashes[file]=await hash(join(target,file));assert.equal(hashes[file],await hash(join(resolve(options.get('--unpacked')),file)));}
const progress=(await readFile(trace,'utf8')).split(/\r?\n/).filter(l=>l.startsWith('new,'));assert.ok(progress.length>2);assert.ok(progress.some(l=>{const p=l.split(',');return Number(p[1])>0&&Number(p[1])<Number(p[2]);}));
const uninstaller=(await readdir(target)).filter(n=>/^Uninstall .+\.exe$/i.test(n));assert.equal(uninstaller.length,1);assert.ok(target.startsWith(evidence+'\\')||target.startsWith(evidence+'/'));
await run(join(target,uninstaller[0]),['/S','/currentuser']).done;
const report={oldVersion:old.version,newVersion:latest.version,installed,updated,visibleProgress:true,actualIntermediateSamples:progress.length,automaticRelaunch:true,hashes,realUserProductTouched:false,scope:'Exact old/new embedded payload with isolated NSIS identity and a test-only launch recorder'};
await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
