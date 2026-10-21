// Build an immutable complete target inventory plus deduplicated raw objects.
// This is release-time work, never a login-time dependency installation.
import {createHash,randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {lstat,mkdir,open,readFile,readdir,realpath,link,unlink,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {readUpdateSigningKey,verifyUpdateSignature} from './client-update-signing.mjs';

const stable=/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const fingerprint=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.nlink].join(':');
export function validateInventoryPaths(paths){
  if(!paths.length || paths.length>200000) throw new Error('Invalid inventory file count.');
  const names=new Set();
  for(const path of paths){
    if(typeof path!=='string'||!path.isWellFormed()||path.length>2048||path.startsWith('/')||/[\\<>:"|?*\x00-\x1f\x7f]/u.test(path)) throw new Error('Invalid Windows inventory path.');
    const parts=path.split('/');
    if(parts.some(p=>!p||p.length>255||p==='.'||p==='..'||/[. ]$/u.test(p)||/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(p))) throw new Error('Invalid Windows inventory component.');
    const lower=path.toUpperCase();
    if(names.has(lower)) throw new Error('Case-colliding inventory paths.');
    names.add(lower);
  }
  for(const path of names){
    let index=path.indexOf('/');
    while(index>=0){if(names.has(path.slice(0,index))) throw new Error('Inventory file/directory collision.'); index=path.indexOf('/',index+1);}
  }
}
async function collect(root,prefix=''){
  const result=[];
  for(const item of await readdir(join(root,prefix),{withFileTypes:true})){
    const path=prefix?`${prefix}/${item.name}`:item.name;
    const info=await lstat(join(root,path),{bigint:true});
    if(info.isSymbolicLink()) throw new Error('Packaged inventory must not contain links.');
    if(info.isDirectory()) result.push(...await collect(root,path));
    else if(info.isFile()&&info.nlink===1n) result.push(path);
    else throw new Error('Packaged inventory must contain regular single-link files.');
  }
  return result;
}
async function hashes(file){
  const handle=await open(file,'r');
  try {
    const before=await handle.stat({bigint:true});
    if(!before.isFile()||before.nlink!==1n||fingerprint(before)!==fingerprint(await lstat(file,{bigint:true}))) throw new Error('Unstable object file.');
    const a=createHash('sha256'),b=createHash('sha512');let size=0;
    for await(const chunk of handle.createReadStream({autoClose:false})){a.update(chunk);b.update(chunk);size+=chunk.length;}
    if(BigInt(size)!==before.size||fingerprint(before)!==fingerprint(await handle.stat({bigint:true}))||fingerprint(before)!==fingerprint(await lstat(file,{bigint:true}))) throw new Error('Object changed during validation.');
    return {size,sha256:a.digest('hex'),sha512:b.digest('base64')};
  }finally{await handle.close();}
}
async function storeObject(source,objects,objectWrites){
  const before=await lstat(source,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n) throw new Error('Invalid source file.');
  const input=await open(source,'r'),temp=join(objects,`.pending-${randomUUID()}`);
  try{
    if(fingerprint(before)!==fingerprint(await input.stat({bigint:true}))) throw new Error('Source replaced before read.');
    const a=createHash('sha256'),b=createHash('sha512');let size=0;
    const counting=new Transform({transform(chunk,_,callback){a.update(chunk);b.update(chunk);size+=chunk.length;callback(null,chunk);}});
    await pipeline(input.createReadStream({autoClose:false}),counting,createWriteStream(temp,{flags:'wx',mode:0o644,flush:true}));
    if(BigInt(size)!==before.size||fingerprint(before)!==fingerprint(await input.stat({bigint:true}))||fingerprint(before)!==fingerprint(await lstat(source,{bigint:true}))) throw new Error('Packaged file changed while preparing release.');
    const result={size,sha256:a.digest('hex'),sha512:b.digest('base64')};
    let publishing=objectWrites.get(result.sha256);
    if(!publishing){
      publishing=(async()=>{
        const folder=join(objects,result.sha256.slice(0,2)),target=join(folder,result.sha256);
        await mkdir(folder,{recursive:true});
        try{await link(temp,target);}catch(error){
          if(error.code!=='EEXIST') throw error;
          if(JSON.stringify(await hashes(target))!==JSON.stringify(result)) throw new Error('Existing content-addressed object is damaged.');
        }
        // Expose completion only after the object has exactly one link. Other
        // equal files await this publication instead of observing a temp link.
        await unlink(temp);return result;
      })();
      objectWrites.set(result.sha256,publishing);
    }
    if(JSON.stringify(await publishing)!==JSON.stringify(result))throw new Error('Conflicting object declaration.');
    return result;
  }finally{await input.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export async function prepareIncrementalRelease({source,output,version,releaseDate=new Date().toISOString(),signer,onProgress=()=>{}}){
  if(!stable.test(version)||!Number.isFinite(Date.parse(releaseDate))||new Date(releaseDate).toISOString()!==releaseDate) throw new Error('Invalid version or release date.');
  const root=await realpath(resolve(source));
  if((await lstat(source)).isSymbolicLink()) throw new Error('Packaged root must not be a link.');
  const paths=(await collect(root)).filter(p=>!['rufajx-dsh.exe','rufajx-dsh.exe.config'].includes(p.toLowerCase())&&!/^Uninstall[^/]*\.exe$/iu.test(p)).sort();validateInventoryPaths(paths);
  if(paths.some(p=>/^\.rufa-updates?(\/|$)/iu.test(p))) throw new Error('Update transaction state must not enter the payload.');
  if(!paths.includes('Rufajx-DSH-App.exe')||!paths.includes('resources/app.asar')) throw new Error('Complete application entry points are required.');
  const out=resolve(output),objects=join(out,'objects','sha256');
  await mkdir(objects,{recursive:true});
  const target=join(out,'releases',version);await mkdir(target,{recursive:true});
  try{await lstat(join(target,'incremental-manifest.json'));throw new Error('Incremental version already exists.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const files=new Array(paths.length),objectWrites=new Map();let cursor=0,completed=0,totalBytes=0;
  await Promise.all(Array.from({length:8},async()=>{
    while(cursor<paths.length){const index=cursor++,path=paths[index];files[index]={path,...await storeObject(join(root,path),objects,objectWrites)};completed++;totalBytes+=files[index].size;onProgress({completed,total:paths.length,bytes:totalBytes});}
  }));
  const manifest={schema:1,version,platform:'win32',arch:'x64',releaseDate,minUpdaterVersion:'0.3.0',files};
  const bytes=Buffer.from(JSON.stringify(manifest)+'\n');if(bytes.length>64*1024*1024)throw new Error('Inventory exceeds protocol limit.');
  const descriptor={url:`releases/${version}/incremental-manifest.json`,size:bytes.length,sha512:createHash('sha512').update(bytes).digest('base64'),algorithm:'rsa-sha256',keyId:signer.keyId,signature:signer.sign(bytes)};
  if(!verifyUpdateSignature(bytes,descriptor,signer.publicKey)) throw new Error('Release signature self-check failed.');
  await writeFile(join(target,'incremental-manifest.json'),bytes,{flag:'wx',flush:true});
  await writeFile(join(target,'incremental-descriptor.json'),JSON.stringify(descriptor,null,2)+'\n',{flag:'wx',flush:true});
  const unique=new Map(files.map(f=>[f.sha256,f]));
  const report={version,files:files.length,bytes:totalBytes,uniqueObjects:unique.size,uniqueBytes:[...unique.values()].reduce((n,f)=>n+f.size,0),descriptor,directory:target};
  await writeFile(join(out,`incremental-${version}.json`),JSON.stringify(report,null,2)+'\n',{flag:'wx',flush:true});
  return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const values={};const args=process.argv.slice(2);
  for(let i=0;i<args.length;i+=2){if(!['--source','--output','--version','--private-key','--release-date'].includes(args[i])||!args[i+1])throw new Error('Invalid incremental build arguments.');values[args[i].slice(2)]=args[i+1];}
  let last=0;
  const report=await prepareIncrementalRelease({source:values.source,output:values.output,version:values.version,releaseDate:values['release-date'],signer:await readUpdateSigningKey(values['private-key']),onProgress(value){if(Date.now()-last>5000){last=Date.now();console.log(JSON.stringify({preparing:value}));}}});
  console.log(JSON.stringify(report,null,2));
}
