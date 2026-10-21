// Prepare real installation acceptance from the final NSIS artifact, without
// rebuilding or recompressing its embedded application payload.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const args=new Map();
for(let i=2;i<process.argv.length;i+=2){
  assert.ok(['--installer','--seven-zip','--output'].includes(process.argv[i]));
  assert.ok(process.argv[i+1]);args.set(process.argv[i],process.argv[i+1]);
}
const installer=resolve(args.get('--installer')), output=resolve(args.get('--output'));
const {stdout}=await promisify(execFile)(resolve(args.get('--seven-zip')),['l','-slt',installer],{
  windowsHide:true,maxBuffer:96*1024*1024,encoding:'utf8',timeout:120000,
});
const header=stdout.split('----------')[0];
assert.match(header,/^Type = 7z$/m);
const field=name=>header.match(new RegExp(`^${name} = (.+)$`,'m'))?.[1]?.trim();
const offset=Number(field('Offset')),size=Number(field('Physical Size')),method=field('Method');
assert.ok(Number.isSafeInteger(offset)&&offset>0&&Number.isSafeInteger(size)&&size>0);
assert.ok(offset+size<=(await stat(installer)).size);
assert.ok(method&&!/\bARM64\b/i.test(method),'Final payload must use the bundled decoder-compatible filters');
const file=await open(installer,'r');
try{
  const bytes=Buffer.alloc(6);assert.equal((await file.read(bytes,0,6,offset)).bytesRead,6);
  assert.equal(bytes.toString('hex'),'377abcaf271c');
}finally{await file.close();}
await mkdir(output,{recursive:true});
const archive=join(output,'app-64.7z');
await pipeline(createReadStream(installer,{start:offset,end:offset+size-1}),createWriteStream(archive,{flags:'wx'}));
assert.equal((await stat(archive)).size,size);
async function hash(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
const report={installer,installerSha256:await hash(installer),offset,size,method,archive,archiveSha256:await hash(archive)};
await writeFile(join(output,'embedded-payload.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
