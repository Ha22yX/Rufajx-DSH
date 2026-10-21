import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { verifyUpdateSignature } from './client-update-signing.mjs';
import { validateInventoryPaths } from './prepare-incremental-release.mjs';

const stableVersion = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
export async function digestFile(file) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1) throw new Error('Release artifact must be a nonempty regular file.');
  const sha256 = createHash('sha256'), sha512 = createHash('sha512');
  for await (const chunk of createReadStream(file)) { sha256.update(chunk); sha512.update(chunk); }
  const after = await stat(file);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new Error('Release artifact changed during verification.');
  return { size: before.size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

// A release directory is immutable. Activation is a separate, atomic publish
// operation after the server has received and verified every declared byte.
export async function prepareClientRelease({ installer, version, output, incremental, publicKey, releaseDate = new Date().toISOString() }) {
  if (!stableVersion.test(version)) throw new Error('A stable three-part version is required.');
  if (!Number.isFinite(Date.parse(releaseDate))) throw new Error('Invalid release date.');
  const source = resolve(installer), name = basename(source);
  if (name !== `Rufa-DSH-${version}-x64-Setup.exe`) throw new Error('Installer filename must match the fixed Windows x64 release channel.');
  await mkdir(resolve(output), { recursive: true });
  // MSIX may redirect LocalAppData. Rename within the actual filesystem path,
  // rather than trying to rename through a virtualized directory alias.
  const root = await realpath(resolve(output));
  const releases = join(root, 'releases'), target = join(releases, version);
  await mkdir(releases, { recursive: true });
  try { await lstat(target); throw new Error('Release version already exists; never replace a published version.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staged = join(releases, `.pending-${version}-${randomUUID()}`);
  await mkdir(staged);
  let incrementalDescriptor;
  if (incremental) {
    const folder = join(resolve(incremental), 'releases', version);
    const bytes = await readFile(join(folder, 'incremental-manifest.json'));
    incrementalDescriptor = JSON.parse(await readFile(join(folder, 'incremental-descriptor.json'), 'utf8'));
    const pem = publicKey ?? await readFile(new URL('../infra/client-update-public.pem', import.meta.url), 'utf8');
    if (bytes.length > 64 * 1024 * 1024 || incrementalDescriptor.url !== `releases/${version}/incremental-manifest.json`
      || incrementalDescriptor.size !== bytes.length || incrementalDescriptor.sha512 !== createHash('sha512').update(bytes).digest('base64')
      || !verifyUpdateSignature(bytes, incrementalDescriptor, pem)) throw new Error('Invalid signed incremental inventory.');
    const inventory = JSON.parse(bytes);
    if (inventory.schema !== 1 || inventory.version !== version || inventory.platform !== 'win32' || inventory.arch !== 'x64'
      || inventory.minUpdaterVersion !== '0.3.0' || !Array.isArray(inventory.files)) throw new Error('Invalid incremental target.');
    validateInventoryPaths(inventory.files.map(file => file.path));
    releaseDate = inventory.releaseDate;
    await writeFile(join(staged, 'incremental-manifest.json'), bytes, { flag: 'wx', flush: true });
  }
  const installerDigest = await digestFile(source);
  await copyFile(source, join(staged, name), constants.COPYFILE_EXCL);
  if ((await digestFile(join(staged, name))).sha512 !== installerDigest.sha512) throw new Error('Copied installer checksum mismatch.');
  let blockmap;
  try {
    blockmap = await digestFile(source + '.blockmap');
    await copyFile(source + '.blockmap', join(staged, name + '.blockmap'), constants.COPYFILE_EXCL);
    if ((await digestFile(join(staged, name + '.blockmap'))).sha512 !== blockmap.sha512) throw new Error('Copied blockmap checksum mismatch.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const url = `releases/${version}/${name}`;
  const manifest = { version, releaseDate, files: [{ url, sha512: installerDigest.sha512, size: installerDigest.size }],
    path: url, sha512: installerDigest.sha512,
    ...(blockmap ? { blockmap: { size: blockmap.size, sha512: blockmap.sha512 } } : {}),
    ...(incrementalDescriptor ? { incremental: incrementalDescriptor } : {}) };
  await writeFile(join(staged, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  for (let attempt = 0; ; attempt++) {
    try { await rename(staged, target); break; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
      try { await lstat(target); throw new Error('Release version already exists; never replace a published version.'); }
      catch (exists) { if (exists.code !== 'ENOENT') throw exists; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const report = { version, directory: target, installer: { file: name, ...installerDigest },
    ...(blockmap ? { blockmap: { file: name + '.blockmap', ...blockmap } } : {}),
    ...(incrementalDescriptor ? { incremental: incrementalDescriptor, objectsDirectory: join(resolve(incremental), 'objects', 'sha256') } : {}), active: false };
  await writeFile(join(root, `release-${version}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2), values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--installer', '--version', '--output', '--incremental'].includes(args[index]) || !args[index + 1]) throw new Error('Usage: --installer PATH --version X.Y.Z --output DIRECTORY [--incremental DIRECTORY]');
    values[args[index].slice(2)] = args[index + 1];
  }
  console.log(JSON.stringify(await prepareClientRelease(values), null, 2));
}
