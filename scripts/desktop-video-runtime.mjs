// Build-time, pinned, offline assets. Never fetch dependencies at user login.
import { readFile, writeFile, rename, unlink, access, mkdir, mkdtemp, cp, rm, readdir } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { patchComputerProgressRuntime } from './computer-progress-runtime.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const lockRoot = join(project, 'preinstalled/desktop-video');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function atomic(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.pending`;
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function command(exe, args, cwd) {
  await new Promise((ok, no) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: 'inherit', shell: false });
    child.once('error', no); child.once('exit', code => code === 0 ? ok() : no(new Error(`Preparation command failed (${code})`)));
  });
}
async function locks() {
  const npmBytes = await readFile(join(lockRoot, 'package-lock.json'));
  const sourceBytes = await readFile(join(lockRoot, 'sources.lock.json'));
  const npm = JSON.parse(npmBytes), source = JSON.parse(sourceBytes);
  if (source.schema !== 1 || source.platform !== 'win32-x64' || source.computerUse.version !== '0.4.3' ||
      npm.packages['node_modules/dsh-computer-use-win']?.version !== '0.4.3' ||
      npm.packages['node_modules/remotion']?.version !== '4.0.537') throw new Error('Unexpected desktop/video lock');
  for (const [name, entry] of Object.entries(npm.packages)) {
    if (!name) continue;
    if (!entry.resolved?.startsWith('https://registry.npmjs.org/') || !entry.integrity?.startsWith('sha512-')) throw new Error(`Unpinned dependency: ${name}`);
  }
  return { npmBytes, sourceBytes, source, lockSha256: hash(Buffer.concat([npmBytes, sourceBytes])) };
}
async function checkedArchive(item, destination, cacheDir, cacheName) {
  let bytes;
  if (cacheDir) bytes = await readFile(join(cacheDir, cacheName)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!bytes) {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Asset download failed (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (hash(bytes) !== item.sha256) throw new Error(`Asset integrity mismatch: ${cacheName}`);
  await writeFile(destination, bytes);
}
async function extract(runtime, zip, target) {
  // Reject traversal and symlinks before extracting the fixed upstream archive.
  const code = "import pathlib,sys,zipfile\nr=pathlib.Path(sys.argv[2]).resolve()\nwith zipfile.ZipFile(sys.argv[1]) as z:\n for i in z.infolist():\n  p=(r/i.filename).resolve()\n  if not p.is_relative_to(r) or (i.external_attr>>16)&0o170000==0o120000: raise ValueError('Unsafe archive entry')\n z.extractall(r)\n";
  await command(join(runtime, 'company-python/python.exe'), ['-I', '-c', code, zip, target], runtime);
}
async function copyTreeAtomic(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTreeAtomic(join(source, entry.name), join(target, entry.name));
    else if (entry.isFile()) await atomic(join(target, entry.name), await readFile(join(source, entry.name)));
    else throw new Error(`Unexpected bundle asset: ${entry.name}`);
  }
}
async function validateRuntime(runtime) {
  const expected = JSON.parse(await readFile(join(project, 'upstream.lock.json')));
  const actual = JSON.parse(await readFile(join(runtime, 'rufa-runtime.json')));
  if (actual.upstreamCommit !== (expected.commit ?? expected.upstreamCommit)) throw new Error('Desktop/video requires the pinned Harness runtime');
}
export async function prepareDesktopVideoRuntime(runtimeInput, { npmCli, cacheDir } = {}) {
  const runtime = resolve(runtimeInput), lock = await locks();
  await validateRuntime(runtime);
  const markerPath = join(runtime, 'rufa-desktop-video.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error; }));
  if (marker) return checkDesktopVideoRuntime(runtime);
  if (!npmCli) throw new Error('Build preparation requires --npm-cli');
  const targets = [join(runtime, 'node_modules/dsh-computer-use-win'), join(runtime, 'company-tools/remotion')];
  for (const target of targets) {
    try { await access(target); throw new Error(`Refusing unverified existing runtime assets: ${target}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const stage = await mkdtemp(join(runtime, '.desktop-video-stage-'));
  try {
    await writeFile(join(stage, 'package-lock.json'), lock.npmBytes);
    await writeFile(join(stage, 'package.json'), await readFile(join(lockRoot, 'package.json')));
    await command(process.execPath, [resolve(npmCli), 'ci', '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund'], stage);
    await checkedArchive(lock.source.skill, join(stage, 'skill.zip'), cacheDir, 'claude-remotion-skill.zip');
    await checkedArchive(lock.source.browser, join(stage, 'browser.zip'), cacheDir, 'chrome-headless-shell-win64.zip');
    const payload = join(stage, 'payload');
    await mkdir(payload);
    await extract(runtime, join(stage, 'skill.zip'), join(stage, 'skill-source'));
    await extract(runtime, join(stage, 'browser.zip'), join(payload, 'browser'));
    const source = join(stage, 'skill-source', `claude-remotion-skill-${lock.source.skill.commit}`);
    await cp(join(source, 'remotion-motion-graphics'), join(payload, 'remotion-motion-graphics'), { recursive: true });
    // Include supporting source examples/SFX scripts referenced by the skill,
    // without the repository's large, unrelated demonstration movie/GIF copies.
    await mkdir(join(payload, 'remotion-motion-graphics/examples'));
    for (const folder of ['src', 'scripts']) await cp(join(source, 'examples', folder), join(payload, 'remotion-motion-graphics/examples', folder), { recursive: true });
    for (const name of ['README.md', 'package.json']) await cp(join(source, 'examples', name), join(payload, 'remotion-motion-graphics/examples', name));
    await cp(join(source, 'LICENSE'), join(payload, 'REMOTION-SKILL-LICENSE'));
    const computer = join(stage, 'computer-use');
    await rename(join(stage, 'node_modules/dsh-computer-use-win'), computer);
    await rename(join(stage, 'node_modules'), join(payload, 'node_modules'));
    await mkdir(dirname(targets[1]), { recursive: true });
    await mkdir(dirname(targets[0]), { recursive: true });
    await rename(payload, targets[1]);
    await rename(computer, targets[0]);
    await atomic(markerPath, JSON.stringify({ schema: 1, lockSha256: lock.lockSha256, computerUse: '0.4.3', remotion: '4.0.537' }, null, 2));
  } finally {
    const inside = relative(runtime, resolve(stage));
    if (!inside.startsWith('.desktop-video-stage-') || inside.includes('..') || isAbsolute(inside)) throw new Error('Unsafe preparation cleanup path');
    await rm(stage, { recursive: true, force: true });
  }
  return checkDesktopVideoRuntime(runtime);
}
export async function checkDesktopVideoRuntime(runtimeInput) {
  const runtime = resolve(runtimeInput), lock = await locks();
  await validateRuntime(runtime);
  const marker = JSON.parse(await readFile(join(runtime, 'rufa-desktop-video.json'), 'utf8'));
  if (marker.schema !== 1 || marker.lockSha256 !== lock.lockSha256) throw new Error('Desktop/video runtime does not match its dependency lock');
  const computer = join(runtime, 'node_modules/dsh-computer-use-win');
  const media = join(runtime, 'company-tools/remotion');
  for (const [path, name, version] of [[computer, 'dsh-computer-use-win', '0.4.3'], [join(media, 'node_modules/remotion'), 'remotion', '4.0.537']]) {
    const manifest = JSON.parse(await readFile(join(path, 'package.json')));
    if (manifest.name !== name || manifest.version !== version) throw new Error(`Runtime version mismatch: ${name}`);
  }
  for (const name of ['mcp/server.mjs', 'mcp/dsh-plugin.mjs', 'mcp/client.js', 'scripts/windows-uia.ps1', 'scripts/windows-takeover.cs', 'LICENSE', 'THIRD_PARTY.md']) await access(join(computer, name));
  await patchComputerProgressRuntime(runtime);
  for (const name of [lock.source.browser.executable, 'remotion-motion-graphics/SKILL.md', 'node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe', 'node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe']) await access(join(media, name));
  await atomic(join(media, 'runner.mjs'), await readFile(join(project, 'scripts/remotion-runner.mjs')));
  await atomic(join(media, 'package-lock.json'), lock.npmBytes);
  await atomic(join(media, 'SOURCES-LOCK.json'), lock.sourceBytes);
  await atomic(join(media, 'THIRD_PARTY_NOTICES.md'), await readFile(join(lockRoot, 'THIRD_PARTY_NOTICES.md')));
  await copyTreeAtomic(join(project, 'apps/client/preinstalled/bundles/remotion'), join(runtime, 'node_modules/@rufa/dsh-remotion-bundle'));
  const manifestPath = join(runtime, 'package.json'), manifest = JSON.parse(await readFile(manifestPath));
  const bundle = JSON.parse(await readFile(join(runtime, 'node_modules/@rufa/dsh-remotion-bundle/package.json')));
  manifest.dependencies = { ...manifest.dependencies, 'dsh-computer-use-win': '0.4.3', '@rufa/dsh-remotion-bundle': bundle.version };
  await atomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { computerUse: '0.4.3', remotion: '4.0.537', skill: lock.source.skill.commit, browser: lock.source.browser.version };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const runtime = process.argv[2];
  if (!runtime) throw new Error('Usage: node scripts/desktop-video-runtime.mjs <runtime> [--prepare --npm-cli <path> --cache-dir <path>]');
  const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
  console.log(JSON.stringify(process.argv.includes('--prepare') ? await prepareDesktopVideoRuntime(runtime, { npmCli: option('--npm-cli'), cacheDir: option('--cache-dir') }) : await checkDesktopVideoRuntime(runtime)));
}
