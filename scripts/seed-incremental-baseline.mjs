// Seed the first complete installer with the same signed managed-file baseline
// used by later incremental updates. The installer hash cannot enter this
// receipt: it would create a circular hash dependency on its own contents.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyUpdateSignature} from './client-update-signing.mjs';
import {validateInventoryPaths} from './prepare-incremental-release.mjs';

export async function seedIncrementalBaseline({unpacked,release,publicKey}) {
  const root=resolve(unpacked), raw=await readFile(join(release,'incremental-manifest.json'));
  const descriptor=JSON.parse(await readFile(join(release,'incremental-descriptor.json'),'utf8'));
  assert.ok(verifyUpdateSignature(raw,descriptor,publicKey),'Invalid baseline signature');
  assert.equal(raw.length,descriptor.size);
  assert.equal(createHash('sha512').update(raw).digest('base64'),descriptor.sha512);
  const inventory=JSON.parse(raw);validateInventoryPaths(inventory.files.map(f=>f.path));
  assert.equal(descriptor.url,`releases/${inventory.version}/incremental-manifest.json`);
  let cursor=0;
  await Promise.all(Array.from({length:8},async()=>{
    while(cursor<inventory.files.length){
      const item=inventory.files[cursor++];
      let target=root;
      for(const segment of item.path.split('/')){target=join(target,segment);assert.equal((await lstat(target)).isSymbolicLink(),false);}
      const before=await lstat(target);assert.ok(before.isFile()&&before.nlink===1);assert.equal(before.size,item.size);
      const a=createHash('sha256'),b=createHash('sha512');
      for await(const chunk of createReadStream(target)){a.update(chunk);b.update(chunk);}
      const after=await lstat(target);
      assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(after.size,before.size);
      assert.equal(a.digest('hex'),item.sha256,`Baseline mismatch: ${item.path}`);assert.equal(b.digest('base64'),item.sha512);
    }
  }));
  const area=join(root,'.rufa-update');await mkdir(area);
  const envelope={schema:1,version:inventory.version,releaseDate:inventory.releaseDate,minUpdaterVersion:inventory.minUpdaterVersion,manifest:descriptor};
  await writeFile(join(area,'current-manifest.json'),raw,{flag:'wx',flush:true});
  await writeFile(join(area,'current.json'),JSON.stringify(envelope)+'\n',{flag:'wx',flush:true});
  return {version:inventory.version,files:inventory.files.length,verified:true};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  assert.equal(process.argv.length,4,'Usage: seed-incremental-baseline.mjs UNPACKED RELEASE');
  console.log(JSON.stringify(await seedIncrementalBaseline({unpacked:process.argv[2],release:process.argv[3],publicKey:await readFile(new URL('../infra/client-update-public.pem',import.meta.url),'utf8')})));
}
