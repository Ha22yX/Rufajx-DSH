// Offline, version-locked viewers for the pinned Better Sidebar runtime.
import { readFile, writeFile, rename, unlink, access, mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { prepareMediaPlayerRuntime, retireLegacyMediaConverter } from './media-player-runtime.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const packages = [
  { name: 'dsh-video-preview', version: '0.1.4', files: ['index.js', 'client.js'],
    integrity: 'sha512-AdmqL2cca8ygAOsM56PHvycPHvzyY4Gv7DTSH/5prkPs4R3mKIIEiwQAAtpeDS9cy0s4+VQfLb7a1uA6UHQ31Q==' },
  { name: '@huanlin/dsh-plugin-better-sidebar-plugin-audio', version: '0.1.0', files: ['lib/index.js', 'lib/client.js'],
    integrity: 'sha512-c7i3QlWljT+tb0I5VcU0DlmsL5WC6mo+6MSnnLudZF3h4MWe7jclcWXbSh09ZmqVXacaTqF396gfUtu9RLhIkg==' },
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.pending`;
  try { await writeFile(temporary, value, { flag: 'wx' }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function sourceLock() {
  const bytes = await readFile(join(project, 'preinstalled/media-preview/package-lock.json'));
  const lock = JSON.parse(bytes);
  // Both viewers are self-contained. Do not accidentally pull another copy of
  // the host, React or Cordis into the installation via optional peer dependencies.
  if (Object.keys(lock.packages).length !== packages.length + 1) throw new Error('Unexpected media preview dependency graph');
  for (const item of packages) {
    const entry = lock.packages[`node_modules/${item.name}`];
    const base = item.name.split('/').at(-1);
    if (entry?.version !== item.version || entry.integrity !== item.integrity ||
      entry.resolved !== `https://registry.npmjs.org/${item.name}/-/${base}-${item.version}.tgz`)
      throw new Error(`Unexpected media preview lock: ${item.name}`);
  }
  return { bytes, hash: sha256(bytes) };
}
export async function prepareMediaPreviewRuntime(runtimeInput, npmCli) {
  const runtime = resolve(runtimeInput), lock = await sourceLock();
  await access(join(runtime, 'rufa-runtime.json'));
  await prepareMediaPlayerRuntime(runtime, { download: true });
  const markerPath = join(runtime, 'rufa-media-preview.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error; }));
  if (marker) {
    if (marker.lockSha256 !== lock.hash) throw new Error('Prepare a fresh runtime for changed media preview dependencies');
    return checkMediaPreviewRuntime(runtime);
  }
  for (const item of packages) {
    try { await access(join(runtime, 'node_modules', item.name)); throw new Error(`Refusing to overwrite unverified media viewer: ${item.name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!npmCli) throw new Error('Preparation requires --npm-cli <npm/bin/npm-cli.js> on the build machine');
  await access(npmCli);
  const stage = await mkdtemp(join(runtime, '.media-preview-stage-'));
  try {
    await copyFile(join(project, 'preinstalled/media-preview/package.json'), join(stage, 'package.json'));
    await writeFile(join(stage, 'package-lock.json'), lock.bytes);
    await new Promise((fulfilled, rejected) => {
      const child = spawn(process.execPath, [resolve(npmCli), 'ci', '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund'],
        { cwd: stage, windowsHide: true, stdio: 'inherit' });
      child.once('error', rejected);
      child.once('exit', code => code === 0 ? fulfilled() : rejected(new Error(`Media preview preparation failed (${code})`)));
    });
    for (const item of packages) {
      const manifest = JSON.parse(await readFile(join(stage, 'node_modules', item.name, 'package.json'), 'utf8'));
      if (manifest.name !== item.name || manifest.version !== item.version) throw new Error('Media viewer identity mismatch');
    }
    for (const item of packages) {
      const target = join(runtime, 'node_modules', item.name);
      await mkdir(dirname(target), { recursive: true });
      await rename(join(stage, 'node_modules', item.name), target);
    }
    await atomic(markerPath, `${JSON.stringify({ schema: 1, lockSha256: lock.hash }, null, 2)}\n`);
  } finally {
    const inside = relative(runtime, resolve(stage));
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || !inside.startsWith('.media-preview-stage-')) throw new Error('Unsafe staging cleanup path');
    await rm(stage, { recursive: true, force: true });
  }
  return checkMediaPreviewRuntime(runtime);
}
export async function checkMediaPreviewRuntime(runtimeInput) {
  const runtime = resolve(runtimeInput), lock = await sourceLock();
  const marker = JSON.parse(await readFile(join(runtime, 'rufa-media-preview.json'), 'utf8'));
  if (marker.schema !== 1 || marker.lockSha256 !== lock.hash) throw new Error('Prepared media preview lock differs from source');
  const upstream = JSON.parse(await readFile(join(runtime, 'rufa-runtime.json'), 'utf8'));
  const expected = JSON.parse(await readFile(join(project, 'upstream.lock.json'), 'utf8'));
  if (upstream.upstreamCommit !== (expected.commit ?? expected.upstreamCommit)) throw new Error('Media previews require the pinned Harness revision');
  const sidebar = JSON.parse(await readFile(join(runtime, 'node_modules/dsh-better-sidebar/package.json'), 'utf8'));
  if (sidebar.version !== '0.28.0') throw new Error('Media previews require Better Sidebar 0.28.0');
  for (const item of packages) {
    const target = join(runtime, 'node_modules', item.name);
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    if (manifest.name !== item.name || manifest.version !== item.version) throw new Error('Media viewer version mismatch');
    for (const file of [...item.files, 'cordis.patch.yml', 'LICENSE']) await access(join(target, file));
  }
  const { applyMediaPreviewCompatibility } = await import('./media-preview-compat.mjs');
  await prepareMediaPlayerRuntime(runtime);
  await applyMediaPreviewCompatibility(runtime);
  await retireLegacyMediaConverter(runtime);
  const installationPath = join(runtime, 'package.json');
  const installation = JSON.parse(await readFile(installationPath, 'utf8'));
  if (packages.some(item => installation.dependencies?.[item.name] !== item.version)) {
    installation.dependencies = { ...installation.dependencies, ...Object.fromEntries(packages.map(item => [item.name, item.version])) };
    await atomic(installationPath, `${JSON.stringify(installation, null, 2)}\n`);
  }
  await writeFile(join(runtime, 'MEDIA-PREVIEW-PACKAGE-LOCK.json'), lock.bytes);
  return { mediaPreviews: Object.fromEntries(packages.map(item => [item.name, item.version])) };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const runtime = process.argv[2];
  if (!runtime) throw new Error('Usage: node scripts/media-preview-runtime.mjs <runtime> [--prepare --npm-cli <path>]');
  console.log(JSON.stringify(process.argv.includes('--prepare')
    ? await prepareMediaPreviewRuntime(runtime, process.argv.includes('--npm-cli') ? process.argv[process.argv.indexOf('--npm-cli') + 1] : undefined)
    : await checkMediaPreviewRuntime(runtime)));
}
