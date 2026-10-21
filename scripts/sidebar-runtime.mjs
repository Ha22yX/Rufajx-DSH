// Build-time preparation of the exact Better Sidebar distribution. The client
// uses the resulting offline directory and never installs packages at startup.
import { readFile, writeFile, rename, unlink, access, mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { applySidebarCompatibility } from './sidebar-compat.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const version = '0.28.0';
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.pending`;
  try { await writeFile(temporary, value); await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function sourceLock() {
  const bytes = await readFile(join(project, 'preinstalled/sidebar/package-lock.json'));
  const lock = JSON.parse(bytes);
  const entry = lock.packages?.['node_modules/dsh-better-sidebar'];
  if (entry?.version !== version || !entry.integrity?.startsWith('sha512-') ||
      entry.resolved !== `https://registry.npmjs.org/dsh-better-sidebar/-/dsh-better-sidebar-${version}.tgz`)
    throw new Error('Unexpected Better Sidebar distribution lock');
  return { bytes, hash: sha256(bytes) };
}
export async function prepareSidebarRuntime(runtimeInput, npmCli) {
  const runtime = resolve(runtimeInput), target = join(runtime, 'node_modules/dsh-better-sidebar');
  await access(join(runtime, 'rufa-runtime.json'));
  const lock = await sourceLock();
  const markerPath = join(runtime, 'rufa-sidebar.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error; }));
  if (marker) {
    if (marker.lockSha256 !== lock.hash) throw new Error('Prepare a fresh runtime for changed sidebar dependencies');
    return checkSidebarRuntime(runtime);
  }
  try { await access(target); throw new Error('Refusing to overwrite an unverified sidebar package'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!npmCli) throw new Error('Preparation requires --npm-cli <npm/bin/npm-cli.js> on the build machine');
  await access(npmCli);
  const stage = await mkdtemp(join(runtime, '.sidebar-stage-'));
  try {
    await copyFile(join(project, 'preinstalled/sidebar/package.json'), join(stage, 'package.json'));
    await writeFile(join(stage, 'package-lock.json'), lock.bytes);
    await new Promise((fulfilled, rejected) => {
      const child = spawn(process.execPath, [resolve(npmCli), 'ci', '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund'],
        { cwd: stage, windowsHide: true, stdio: 'inherit' });
      child.once('error', rejected);
      child.once('exit', code => code === 0 ? fulfilled() : rejected(new Error(`Sidebar dependency preparation failed (${code})`)));
    });
    const payload = join(stage, 'payload');
    await rename(join(stage, 'node_modules/dsh-better-sidebar'), payload);
    // Keep all non-Harness dependencies private, without replacing the pinned
    // installation's React, Cordis, or native DSH packages.
    await rename(join(stage, 'node_modules'), join(payload, 'node_modules'));
    const manifest = JSON.parse(await readFile(join(payload, 'package.json'), 'utf8'));
    if (manifest.name !== 'dsh-better-sidebar' || manifest.version !== version) throw new Error('Sidebar package identity mismatch');
    await mkdir(join(runtime, 'node_modules'), { recursive: true });
    await rename(payload, target);
    await atomic(markerPath, `${JSON.stringify({ schema: 1, version, lockSha256: lock.hash }, null, 2)}\n`);
  } finally {
    const inside = relative(runtime, resolve(stage));
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || !inside.startsWith('.sidebar-stage-')) throw new Error('Unsafe staging cleanup path');
    await rm(stage, { recursive: true, force: true });
  }
  return checkSidebarRuntime(runtime);
}
export async function checkSidebarRuntime(runtimeInput) {
  const runtime = resolve(runtimeInput), lock = await sourceLock();
  const marker = JSON.parse(await readFile(join(runtime, 'rufa-sidebar.json'), 'utf8'));
  if (marker.version !== version || marker.lockSha256 !== lock.hash) throw new Error('Prepared sidebar lock differs from source');
  const expected = JSON.parse(await readFile(join(project, 'upstream.lock.json'), 'utf8'));
  const upstream = JSON.parse(await readFile(join(runtime, 'rufa-runtime.json'), 'utf8'));
  if (upstream.upstreamCommit !== (expected.commit ?? expected.upstreamCommit)) throw new Error('Sidebar requires the pinned Harness revision');
  const target = join(runtime, 'node_modules/dsh-better-sidebar');
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  if (manifest.name !== 'dsh-better-sidebar' || manifest.version !== version) throw new Error('Sidebar version mismatch');
  for (const file of ['lib/index.js', 'lib/client.js', 'lib/client-editor.js', 'lib/client-mermaid.js', 'lib/client-terminal.js', 'cordis.patch.yml', 'LICENSE']) await access(join(target, file));
  await applySidebarCompatibility(runtime);
  const installationPath = join(runtime, 'package.json');
  const installation = JSON.parse(await readFile(installationPath, 'utf8'));
  if (installation.dependencies?.['dsh-better-sidebar'] !== version) {
    installation.dependencies = { ...installation.dependencies, 'dsh-better-sidebar': version };
    await atomic(installationPath, `${JSON.stringify(installation, null, 2)}\n`);
  }
  await writeFile(join(runtime, 'SIDEBAR-PACKAGE-LOCK.json'), lock.bytes);
  return { sidebar: version };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const runtime = process.argv[2];
  if (!runtime) throw new Error('Usage: node scripts/sidebar-runtime.mjs <runtime> [--prepare --npm-cli <path>]');
  console.log(JSON.stringify(process.argv.includes('--prepare')
    ? await prepareSidebarRuntime(runtime, process.argv.includes('--npm-cli') ? process.argv[process.argv.indexOf('--npm-cli') + 1] : undefined)
    : await checkSidebarRuntime(runtime)));
}
