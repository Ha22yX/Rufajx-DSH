// Read-only full-inventory probe of the real native verifier. No install or
// recovery function is invoked and the scanned installation is never changed.
import { mkdtemp, writeFile, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
if(!args.has('--root'))throw new Error('--root is required');
const root=resolve(args.get('--root')),limit=Number(args.get('--limit')??'0');
if(!Number.isSafeInteger(limit)||limit<0)throw new Error('Invalid limit');
const source=args.has('--source')?resolve(args.get('--source')):fileURLToPath(new URL('../scripts/updater/Bootstrap.cs',import.meta.url));
const trust=fileURLToPath(new URL('../scripts/updater/UpdateTrust.cs',import.meta.url));
const evidence=await mkdtemp(join(tmpdir(),'rufa-native-perf-'));
const sourceHash=createHash('sha256').update(await readFile(source)).digest('hex');
const harness=`using System;using System.IO;using System.Linq;using System.Diagnostics;using System.Reflection;using System.Collections.Generic;
class PerfEntry {
 static int Main(string[] args) {
  try {
   var root=Path.GetFullPath(args[0]).TrimEnd(Path.DirectorySeparatorChar);
   var binding=BindingFlags.Static|BindingFlags.NonPublic;
   typeof(Bootstrap).GetField("Root",binding).SetValue(null,root);
   var load=(Func<string,string,SignedManifest>)Delegate.CreateDelegate(typeof(Func<string,string,SignedManifest>),typeof(Bootstrap).GetMethod("Load",binding));
   var resolver=typeof(Bootstrap).GetMethod("ResolveLocal",binding)??typeof(Bootstrap).GetMethod("Local",binding);
   var local=(Func<string,string>)Delegate.CreateDelegate(typeof(Func<string,string>),resolver);
   var matches=(Func<string,FileEntry,bool>)Delegate.CreateDelegate(typeof(Func<string,FileEntry,bool>),typeof(Bootstrap).GetMethod("Matches",binding));
   var clock=Stopwatch.StartNew();
   var manifest=load(Path.Combine(root,".rufa-update","current.json"),Path.Combine(root,".rufa-update","current-manifest.json"));
   long loadMs=clock.ElapsedMilliseconds;var files=manifest.Files.Values.ToArray();int limit=Int32.Parse(args[1]);if(limit==0||limit>files.Length)limit=files.Length;
   long localTicks=0,matchTicks=0,bytes=0;int mismatches=0;var gc=new[]{GC.CollectionCount(0),GC.CollectionCount(1),GC.CollectionCount(2)};
   var cpu=Process.GetCurrentProcess().TotalProcessorTime;clock.Restart();
   for(int i=0;i<limit;i++) {
    var file=files[(int)((long)i*files.Length/limit)];long before=Stopwatch.GetTimestamp();string path=local(file.path);long middle=Stopwatch.GetTimestamp();
    bool equal=matches(path,file);long end=Stopwatch.GetTimestamp();localTicks+=middle-before;matchTicks+=end-middle;bytes+=file.size;if(!equal)mismatches++;
    if((i+1)%4096==0)Console.WriteLine(Bootstrap.Json.Serialize(new{progress=i+1,total=limit,elapsedMs=clock.ElapsedMilliseconds,gc2=GC.CollectionCount(2)-gc[2]}));
   }
   var result=new {files=limit,inventoryFiles=files.Length,bytes,mismatches,loadMs,elapsedMs=clock.ElapsedMilliseconds,resolver=resolver.Name,localMs=localTicks*1000.0/Stopwatch.Frequency,matchMs=matchTicks*1000.0/Stopwatch.Frequency,cpuMs=(Process.GetCurrentProcess().TotalProcessorTime-cpu).TotalMilliseconds,gc0=GC.CollectionCount(0)-gc[0],gc1=GC.CollectionCount(1)-gc[1],gc2=GC.CollectionCount(2)-gc[2],privateBytes=Process.GetCurrentProcess().PrivateMemorySize64};
   Console.WriteLine(Bootstrap.Json.Serialize(result));File.WriteAllText(args[2],Bootstrap.Json.Serialize(result));return mismatches==0?0:2;
  }catch(Exception error){Console.Error.WriteLine(error);return 2;}
 }
}`;
await writeFile(join(evidence,'Perf.cs'),harness);
function run(file,args){return new Promise((resolve,reject)=>{const p=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});p.stdout.pipe(process.stdout);p.stderr.pipe(process.stderr);p.once('error',reject);p.once('exit',resolve);});}
const exe=join(evidence,'perf.exe');
const nativeManifest=fileURLToPath(new URL('../scripts/updater/app.manifest',import.meta.url));
const compiled=await run(join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/optimize+','/main:PerfEntry',`/out:${exe}`,`/win32manifest:${nativeManifest}`,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',source,trust,join(evidence,'Perf.cs')]);
if(compiled!==0)throw new Error('Native performance probe compilation failed');
await cp(fileURLToPath(new URL('../scripts/updater/Rufajx-DSH.exe.config',import.meta.url)),exe+'.config');
await writeFile(join(evidence,'scope.json'),JSON.stringify({root,source,sourceHash,limit,readOnly:true},null,2));
console.log(JSON.stringify({evidence,sourceHash,readOnly:true}));
process.exitCode=await run(exe,[root,String(limit),join(evidence,'result.json')]);
