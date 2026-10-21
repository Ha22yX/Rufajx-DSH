import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,lstat,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareIncrementalRelease,validateInventoryPaths} from '../scripts/prepare-incremental-release.mjs';
import {updateKeyId,verifyUpdateSignature} from '../scripts/client-update-signing.mjs';
import {prepareClientRelease} from '../scripts/prepare-client-release.mjs';
import {seedIncrementalBaseline} from '../scripts/seed-incremental-baseline.mjs';
const keys=generateKeyPairSync('rsa',{modulusLength:3072});
const publicKey=keys.publicKey.export({type:'spki',format:'pem'});
const signer={publicKey,keyId:updateKeyId(publicKey),sign:b=>sign('sha256',b,keys.privateKey).toString('base64')};
async function fixture(){const root=await mkdtemp(join(tmpdir(),'rufa-incremental-release-'));const source=join(root,'app');await mkdir(source);return {root,source,output:join(root,'feed')};}
test('signed target inventory deduplicates identical bytes, supports empty files, and keeps stable launcher out of managed set',async()=>{
  const f=await fixture();await mkdir(join(f.source,'resources'));
  await writeFile(join(f.source,'Rufajx-DSH.exe'),'stable bootstrap');await writeFile(join(f.source,'Rufajx-DSH.exe.config'),'stable config');
  await writeFile(join(f.source,'Uninstall Rufajx-DSH.exe'),'NSIS owned');
  await writeFile(join(f.source,'Rufajx-DSH-App.exe'),'same bytes');await writeFile(join(f.source,'resources','app.asar'),'same bytes');await writeFile(join(f.source,'resources','empty'),'');
  const report=await prepareIncrementalRelease({...f,version:'0.3.0',signer});
  assert.equal(report.files,3);assert.equal(report.uniqueObjects,2);
  const bytes=await readFile(join(report.directory,'incremental-manifest.json'));
  assert.equal(verifyUpdateSignature(bytes,report.descriptor,publicKey),true);
  assert.equal(report.descriptor.sha512,createHash('sha512').update(bytes).digest('base64'));
  const inventory=JSON.parse(bytes);
  for(const item of inventory.files){
    const object=join(f.output,'objects','sha256',item.sha256.slice(0,2),item.sha256);
    assert.deepEqual(await readFile(object),await readFile(join(f.source,item.path)));
    assert.equal((await lstat(object)).nlink,1);
  }
  assert.equal(verifyUpdateSignature(Buffer.concat([bytes,Buffer.from(' ')]),report.descriptor,publicKey),false);
  assert.equal(verifyUpdateSignature(bytes,{...report.descriptor,keyId:'0'.repeat(64)},publicKey),false);
  assert.equal(verifyUpdateSignature(bytes,{...report.descriptor,algorithm:'ed25519'},publicKey),false);
  await assert.rejects(prepareIncrementalRelease({...f,version:'0.3.0',signer}),/already exists/);
  await writeFile(join(f.source,'resources','app.asar'),'changed');
  const later=await prepareIncrementalRelease({...f,version:'0.3.1',signer});
  assert.equal(later.files,3);assert.equal(later.uniqueObjects,3);
  const installer=join(f.root,'Rufa-DSH-0.3.0-x64-Setup.exe');await writeFile(installer,'MZ full bridge fixture');
  const prepared=await prepareClientRelease({installer,version:'0.3.0',output:join(f.root,'publication'),incremental:f.output,publicKey});
  const release=JSON.parse(await readFile(join(prepared.directory,'manifest.json'),'utf8'));
  assert.deepEqual(release.incremental,report.descriptor);
  assert.deepEqual(await readFile(join(prepared.directory,'incremental-manifest.json')),bytes);
  assert.equal(release.files.length,1);assert.equal(prepared.active,false);
  await assert.rejects(seedIncrementalBaseline({unpacked:f.source,release:report.directory,publicKey}));
  const baseline=await seedIncrementalBaseline({unpacked:f.source,release:later.directory,publicKey});
  assert.equal(baseline.verified,true);
  const current=JSON.parse(await readFile(join(f.source,'.rufa-update/current.json'),'utf8'));
  assert.equal(current.version,'0.3.1');assert.equal(current.installer,undefined);
  assert.ok(verifyUpdateSignature(await readFile(join(f.source,'.rufa-update/current-manifest.json')),current.manifest,publicKey));
  await assert.rejects(seedIncrementalBaseline({unpacked:f.source,release:later.directory,publicKey}),/exist/i);
});
test('Windows paths reject aliases, traversal, collisions and device names before publishing',()=>{
  for(const paths of [['../x'],['C:/x'],['/x'],['a\\x'],['a:x'],['a.'],['a '],['a//b'],['nul.txt'],['COM1/x'],['COM¹.txt'],['LPT²/x'],['a','A'],['a/b','a'],['x\u0000']])assert.throws(()=>validateInventoryPaths(paths));
  validateInventoryPaths(['resources/中文/文件.txt','lib/com10.txt']);
});
test('unsafe source links or update state cannot become a published inventory',async()=>{
  const f=await fixture();await writeFile(join(f.source,'file'),'data');
  await link(join(f.source,'file'),join(f.source,'linked'));
  await assert.rejects(prepareIncrementalRelease({...f,version:'0.3.0',signer}),/single-link/);
  const g=await fixture();await mkdir(join(g.source,'.rufa-update'));await writeFile(join(g.source,'.rufa-update','transaction.json'),'{}');
  await assert.rejects(prepareIncrementalRelease({...g,version:'0.3.0',signer}),/transaction state/);
  const h=await fixture();await mkdir(join(h.root,'outside'));await writeFile(join(h.root,'outside','file'),'outside');await symlink(join(h.root,'outside'),join(h.source,'link'),'junction');
  await assert.rejects(prepareIncrementalRelease({...h,version:'0.3.0',signer}),/links/);
});
test('damaged existing object and invalid signing result never publish a manifest',async()=>{
  const f=await fixture();await writeFile(join(f.source,'file'),'data');
  await mkdir(join(f.source,'resources'));await writeFile(join(f.source,'Rufajx-DSH-App.exe'),'data');await writeFile(join(f.source,'resources','app.asar'),'data');
  const hash=createHash('sha256').update('data').digest('hex');const folder=join(f.output,'objects','sha256',hash.slice(0,2));await mkdir(folder,{recursive:true});await writeFile(join(folder,hash),'evil');
  await assert.rejects(prepareIncrementalRelease({...f,version:'0.3.0',signer}),/damaged/);
  const g=await fixture();await writeFile(join(g.source,'file'),'data');await mkdir(join(g.source,'resources'));await writeFile(join(g.source,'Rufajx-DSH-App.exe'),'data');await writeFile(join(g.source,'resources','app.asar'),'data');
  await assert.rejects(prepareIncrementalRelease({...g,version:'0.3.0',signer:{...signer,sign:()=>Buffer.alloc(384).toString('base64')}}),/signature self-check/);
});
