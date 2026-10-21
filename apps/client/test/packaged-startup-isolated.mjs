/**
 * Standalone acceptance harness; never bundled into the company application.
 *
 * node test/packaged-startup-isolated.mjs --unpacked <final win-unpacked>
 *   [--scenario equal|unavailable|public|all] [--electron <fixed electron.exe>]
 *
 * Default "all" runs only two simulated transports. "public" makes read-only
 * requests to the real fixed incremental/latest.json; all other HTTPS requests are denied.
 * The executable/runtime are copied into a unique TEMP directory. Its bootstrap
 * loads the untouched final app.asar after isolating Electron paths. This is
 * NOT an NSIS installation or the unmodified installed entry-point test.
 * If final executable ASAR-integrity fuses reject the bootstrap, stop. A
 * separately requested --electron fallback does not modify any security fuse.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--unpacked', '--scenario', '--electron'].includes(process.argv[i]), 'Unknown argument');
  assert.ok(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), 'Missing argument value');
  assert.ok(!args.has(process.argv[i]), 'Duplicate argument');
  args.set(process.argv[i], process.argv[i + 1]);
}
assert.equal(process.platform, 'win32', 'Windows-only packaged acceptance');
assert.ok(args.has('--unpacked'), '--unpacked is required');
const unpacked = await realpath(resolve(args.get('--unpacked')));
const resources = join(unpacked, 'resources'), archive = join(resources, 'app.asar');
const asar = createRequire(join(unpacked, 'package.json'))('@electron/asar');
const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
assert.equal(manifest.name, '@rufa/client', 'Expected the company client archive');
assert.match(manifest.version, /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/);
assert.equal(manifest.main, 'dist/main.js');
assert.equal(manifest.dependencies?.['electron-updater'], '6.8.9');
// Refuse an incomplete --dir product before launching anything.
for (const name of ['app-update.yml', 'company-config.json', 'harness', 'company-plugins', 'node/node.exe']) {
  await stat(join(resources, name));
}
const appUpdate = await readFile(join(resources, 'app-update.yml'), 'utf8');
assert.ok(appUpdate.includes('https://dsh.example.com/api/v1/client-updates/windows/x64/'));
const requested = args.get('--scenario') ?? 'all';
assert.ok(['all', 'equal', 'unavailable', 'public'].includes(requested));
const scenarios = requested === 'all' ? ['equal', 'unavailable'] : [requested];
const finalExe = join(unpacked, 'Rufajx-DSH-App.exe');
await stat(join(unpacked, 'Rufajx-DSH.exe'));
await stat(join(unpacked, 'Rufajx-DSH.exe.config'));
await stat(finalExe);
const sourceExe = args.has('--electron') ? await realpath(resolve(args.get('--electron'))) : finalExe;
const sourceDir = dirname(sourceExe);
const runtimeKind = args.has('--electron') ? 'fixed-electron-fallback' : 'final-executable-byte-copy';
const evidence = await mkdtemp(join(tmpdir(), 'rufa-packaged-startup-'));
const inside = (parent, child) => {
  const sub = relative(parent, child);
  return !!sub && !sub.startsWith('..') && !isAbsolute(sub);
};
assert.ok(inside(await realpath(tmpdir()), await realpath(evidence)));
async function hash(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
const archiveHash = await hash(archive), finalExeHash = await hash(finalExe), sourceExeHash = await hash(sourceExe);
const shellDir = join(evidence, 'runtime');
await mkdir(shellDir);
for (const item of await readdir(sourceDir, { withFileTypes: true })) {
  if (['resources','.rufa-update','rufajx-dsh.exe','rufajx-dsh.exe.config'].includes(item.name.toLowerCase()) || /^uninstall.*\.exe$/i.test(item.name)) continue;
  assert.equal(item.isSymbolicLink(), false, 'Runtime entries must not be symlinks');
  await cp(join(sourceDir, item.name), join(shellDir, item.name), { recursive: true, force: false, errorOnExist: true });
}
let runnerExe = join(shellDir, basename(sourceExe));
if (basename(sourceExe).toLowerCase() === 'electron.exe') {
  // Native Electron IsPackaged uses the executable name; never patch the getter.
  runnerExe = join(shellDir, 'Rufa-Packaged-Acceptance.exe');
  await cp(sourceExe, runnerExe, { force: false, errorOnExist: true });
}
assert.equal(await hash(runnerExe), sourceExeHash);
const bootSource = join(evidence, 'bootstrap');
await mkdir(bootSource);
await mkdir(join(shellDir, 'resources'));
await cp(fileURLToPath(new URL('./fixtures/packaged-startup-bootstrap.cjs', import.meta.url)), join(bootSource, 'main.cjs'));
await writeFile(join(bootSource, 'package.json'), JSON.stringify({
  name: `rufa-isolated-acceptance-${basename(evidence)}`, version: manifest.version, main: 'main.cjs',
}));
await asar.createPackage(bootSource, join(shellDir, 'resources/app.asar'));

const summary = {
  scope: 'Unmodified final company main/preload/renderer under isolated bootstrap; not installed entry-point acceptance',
  runtimeKind, versionFromFinalArchive: manifest.version, archiveHash, finalExeHash, sourceExeHash,
  finalResources: resources, evidence, scenarios: [],
};
console.log(`Isolated packaged-startup evidence: ${evidence}`);
let failed = false;
for (const scenario of scenarios) {
  const output = join(evidence, scenario);
  await mkdir(output);
  const paths = Object.fromEntries(['appData', 'localAppData', 'initialUserData', 'sessionData', 'crashDumps', 'logs', 'temp', 'ignoredTestProfile']
    .map(name => [name, join(output, name)]));
  for (const [name, path] of Object.entries(paths)) if (name !== 'ignoredTestProfile') await mkdir(path);
  const config = { resources, archive, archiveHash, versionFromFinalArchive: manifest.version,
    runtimeKind, scenario, output, paths, root: evidence };
  const configFile = join(output, 'config.json');
  await writeFile(configFile, JSON.stringify(config, null, 2));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(RUFA_|ELECTRON_|NODE_OPTIONS$|APPDATA$|LOCALAPPDATA$|TEMP$|TMP$)/i.test(key)) delete env[key];
  Object.assign(env, { APPDATA: paths.appData, LOCALAPPDATA: paths.localAppData, TEMP: paths.temp, TMP: paths.temp,
    RUFA_TEST_USER_DATA: paths.ignoredTestProfile, RUFA_TEST_SERVER_URL: 'http://127.0.0.1:1' });
  const child = spawn(runnerExe, [`--rufa-acceptance-config=${configFile}`, `--user-data-dir=${paths.initialUserData}`], {
    cwd: output, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + String(bytes)).slice(-20_000); });
  const timer = setTimeout(() => child.kill(), 65_000);
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ exitCode: null, launchError: error.code ?? 'LAUNCH_FAILED' }));
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(timer);
  await writeFile(join(output, 'process.log'), log);
  let report;
  try { report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8')); }
  catch { report = { passed: false, error: 'Bootstrap produced no report. Do not weaken fuses or production isolation.' }; }
  summary.scenarios.push({ scenario, ...result, report });
  if (result.exitCode !== 0 || report.passed !== true) { failed = true; break; }
}
summary.finalArchiveUnchanged = await hash(archive) === archiveHash;
summary.finalExecutableUnchanged = await hash(finalExe) === finalExeHash;
summary.passed = !failed && summary.finalArchiveUnchanged && summary.finalExecutableUnchanged;
await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ passed: summary.passed, evidence, runtimeKind, version: manifest.version,
  scenarios: summary.scenarios.map(value => ({ scenario: value.scenario, passed: value.report.passed, exitCode: value.exitCode })) }));
process.exitCode = summary.passed ? 0 : 1;
