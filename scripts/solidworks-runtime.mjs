import { readFile, writeFile, readdir, mkdir, cp, access, rename, rm, mkdtemp } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const project = fileURLToPath(new URL('../', import.meta.url));
const source = join(project, 'preinstalled/solidworks');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function move(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 8) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
}
async function command(exe, args, cwd) {
  await new Promise((ok, no) => { const child = spawn(exe, args, { cwd, windowsHide: true, shell: false, stdio: 'inherit' }); child.once('error', no); child.once('exit', code => code === 0 ? ok() : no(new Error(`SolidWorks preparation failed (${code})`))); });
}
async function files(root, folder = root) {
  const result = [];
  for (const row of await readdir(folder, { withFileTypes: true })) {
    if (row.name === '__pycache__') continue;
    const path = join(folder, row.name);
    if (row.isDirectory()) result.push(...await files(root, path));
    else if (row.isFile()) result.push(relative(root, path).replaceAll('\\', '/'));
    else throw new Error('Unexpected SolidWorks payload link');
  }
  return result.sort();
}
export async function checkSolidworksRuntime(runtimeInput, { checkSources = true } = {}) {
  const runtime = resolve(runtimeInput), target = join(runtime, 'company-tools/solidworks');
  const marker = await json(join(runtime, 'rufa-solidworks.json'));
  if (marker.schema !== 1 || marker.version !== '1.0.0' || marker.python !== '3.12.10') throw new Error('SolidWorks offline manifest is invalid');
  if (JSON.stringify(await files(target)) !== JSON.stringify(Object.keys(marker.files).sort())) throw new Error('SolidWorks payload file inventory differs');
  const sourceLock = await json(join(source, 'dependencies.lock.json'));
  if (checkSources && marker.lockSha256 !== digest(await readFile(join(source, 'dependencies.lock.json')))) throw new Error('SolidWorks dependency lock differs');
  for (const [file, hash] of Object.entries(marker.files)) {
    if (file.includes('..') || file.startsWith('/') || file.includes(':')) throw new Error('Unsafe SolidWorks manifest path');
    if (digest(await readFile(join(target, file))) !== hash) throw new Error(`SolidWorks payload mismatch: ${file}`);
  }
  for (const file of ['solidworks_runner.py', 'GUIDE.md', 'catalog/index.json', 'evidence/index.json', 'recipes/index.json', 'lib/pythoncom.py', 'lib/pywin32_system32/pythoncom312.dll', 'lib/pywin32_system32/pywintypes312.dll']) if (!marker.files[file]) throw new Error(`SolidWorks payload missing: ${file}`);
  if (checkSources) for (const folder of ['catalog', 'evidence', 'recipes']) for (const file of await files(join(source, folder))) {
    if (marker.files[`${folder}/${file}`] !== digest(await readFile(join(source, folder, file)))) throw new Error(`SolidWorks reference changed: ${folder}/${file}`);
  }
  if (checkSources && (marker.files['GUIDE.md'] !== digest(await readFile(join(source, 'GUIDE.md'))) || marker.files['solidworks_runner.py'] !== digest(await readFile(join(source, 'runtime/solidworks_runner.py'))))) throw new Error('SolidWorks runtime source changed; rebuild candidate payload');
  await access(join(runtime, 'company-python/python.exe'));
  return { version: marker.version, files: Object.keys(marker.files).length, bytes: marker.bytes, python: sourceLock.python };
}
export async function prepareSolidworksRuntime(runtimeInput) {
  const runtime = resolve(runtimeInput), lockBytes = await readFile(join(source, 'dependencies.lock.json')), lock = JSON.parse(lockBytes);
  if (lock.platform !== 'win32-x64' || lock.python !== '3.12.10' || lock.wheels.length !== 1 || lock.wheels[0].version !== '311') throw new Error('Unexpected SolidWorks lock');
  const destination = join(runtime, 'company-tools/solidworks'), markerPath = join(runtime, 'rufa-solidworks.json');
  let previous = false;
  try {
    await access(destination); previous = true;
    await checkSolidworksRuntime(runtime, { checkSources: false });
    try { return await checkSolidworksRuntime(runtime); } catch { /* Verified older payload; prepare the new source in isolation. */ }
  } catch (error) { if (previous || error.code !== 'ENOENT') throw error; }
  const stage = await mkdtemp(join(runtime, '.solidworks-prepare-')), target = join(stage, 'payload');
  let published = false, oldMarker, cleanupStage = true;
  try {
  await mkdir(target, { recursive: true });
  for (const folder of ['catalog', 'evidence', 'recipes']) await cp(join(source, folder), join(target, folder), { recursive: true });
  await cp(join(source, 'GUIDE.md'), join(target, 'GUIDE.md'));
  await cp(join(source, 'runtime/solidworks_runner.py'), join(target, 'solidworks_runner.py'));
  await writeFile(join(target, 'dependencies.lock.json'), lockBytes);
  for (const wheel of lock.wheels) {
    if (!/^[a-zA-Z0-9_.-]+\.whl$/u.test(wheel.file)) throw new Error('Invalid wheel path');
    const bytes = await readFile(join(source, 'wheels', wheel.file));
    if (digest(bytes) !== wheel.sha256) throw new Error('SolidWorks offline wheel integrity mismatch');
    const code = "import sys,zipfile,pathlib\nassert sys.version_info[:3]==(3,12,10)\nr=pathlib.Path(sys.argv[2]).resolve()\nwith zipfile.ZipFile(sys.argv[1]) as z:\n for i in z.infolist():\n  if not (r/i.filename).resolve().is_relative_to(r) or (i.external_attr>>16)&0o170000==0o120000: raise ValueError('Unsafe archive entry')\n z.extractall(r)\n";
    await command(join(runtime, 'company-python/python.exe'), ['-I', '-c', code, join(source, 'wheels', wheel.file), join(target, 'lib')], runtime);
  }
  const hashes = {}; let bytes = 0;
  for (const file of await files(target)) { const data = await readFile(join(target, file)); hashes[file] = digest(data); bytes += data.length; }
  const marker = JSON.stringify({ schema: 1, version: '1.0.0', python: lock.python, lockSha256: digest(lockBytes), files: hashes, bytes }, null, 2) + '\n';
  await mkdir(join(runtime, 'company-tools'), { recursive: true });
  if (previous) { oldMarker = await readFile(markerPath); await move(destination, join(stage, 'previous')); cleanupStage = false; }
  await move(target, destination); published = true;
  await writeFile(markerPath, marker);
  const result = await checkSolidworksRuntime(runtime); cleanupStage = true; return result;
  } catch (error) {
    if (published) await move(destination, join(stage, 'rejected'));
    if (previous && oldMarker) { await move(join(stage, 'previous'), destination); await writeFile(markerPath, oldMarker); }
    cleanupStage = true;
    throw error;
  } finally {
    // Only this invocation's newly allocated staging directory is removable.
    const rel = relative(runtime, resolve(stage));
    if (!rel.startsWith('.solidworks-prepare-') || rel.includes('..') || rel.includes('/') || rel.includes('\\')) throw new Error('Unsafe SolidWorks staging cleanup');
    if (cleanupStage) await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, runtime] = process.argv.slice(2);
  if (!runtime || !['prepare', 'check'].includes(mode)) throw new Error('Usage: solidworks-runtime.mjs prepare|check <candidate-runtime>');
  console.log(JSON.stringify(await (mode === 'prepare' ? prepareSolidworksRuntime(runtime) : checkSolidworksRuntime(runtime))));
}
