// Release regression gate. Uses only isolated synthetic accounts and loopback services.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const suites = [
  'apps/client/test/runtime/persistence.test.mjs',
  'apps/client/test/runtime/session-cache.test.mjs',
  'apps/client/test/runtime/durable-batches.test.mjs',
  'apps/client/test/runtime/sync-faults.test.mjs',
  'apps/client/test/history-integration.test.mjs',
  'tests/history-sync.test.mjs',
  'tests/history-sync-faults.test.mjs',
  'apps/server/test/sqlite.test.ts',
  'apps/server/test/session-consistency.test.ts',
  'apps/server/test/postgres-session-consistency.test.ts',
];
const modules = ['remote-persistence.mjs', 'session-cache.mjs', 'company-history.mjs', 'import-upstream.mjs', 'empty-session-policy.mjs', 'unused-sessions.mjs'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function filesBelow(path) {
  const files = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const relative = `${path}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesBelow(relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}
async function inputs(runtime) {
  if (!runtime) throw new Error('History safety requires RUFA_RUNTIME_ROOT; skipped tests cannot authorize packaging.');
  const manifestBytes = await readFile(join(runtime, 'rufa-runtime.json'));
  const manifest = JSON.parse(manifestBytes), pinned = JSON.parse(await readFile(join(root, 'upstream.lock.json')));
  if (manifest.upstreamCommit !== pinned.commit) throw new Error('History safety runtime does not match the pinned Harness.');
  const files = new Set(['scripts/history-safety-gate.mjs', 'scripts/history-runtime.mjs', 'upstream.lock.json', 'package.json', 'package-lock.json',
    'apps/server/package.json', 'apps/server/tsconfig.json', 'apps/client/package.json', 'apps/client/tsconfig.json', ...suites,
    'tests/fixtures/history-fault-worker.mjs', ...await filesBelow('apps/server/test'), ...await filesBelow('apps/server/src'), ...await filesBelow('apps/server/dist'),
    'apps/client/src/company-api.ts', 'apps/client/src/runtime-bridge.ts', 'apps/client/dist/company-api.js', 'apps/client/dist/runtime-bridge.js']);
  for (const name of modules) {
    const source = `apps/client/src/runtime/${name}`, compiled = `apps/client/dist/runtime/${name}`;
    if (!(await readFile(join(root, source))).equals(await readFile(join(root, compiled)))) throw new Error(`Rebuild client before history safety: ${name}`);
    files.add(source); files.add(compiled);
  }
  const hashes = { node: process.version, runtimeManifest: sha(manifestBytes) };
  for (const file of [...files].sort()) hashes[file] = sha(await readFile(join(root, file)));
  return hashes;
}
function receiptPath(clientRoot = join(root, 'apps/client')) { return join(clientRoot, 'build/history-safety.json'); }
export async function checkHistorySafetyReceipt(clientRoot = join(root, 'apps/client'), runtime = join(clientRoot, 'runtime')) {
  let receipt;
  try { receipt = JSON.parse(await readFile(receiptPath(clientRoot), 'utf8')); }
  catch { throw new Error('缺少会话同步故障验收回执；请先运行 npm run test:history-safety。'); }
  if (receipt.version !== 1 || receipt.passed !== true || !isDeepStrictEqual(receipt.inputs, await inputs(runtime))) {
    throw new Error('会话同步实现、编译结果或测试已变化，请重新运行 npm run test:history-safety 后再打包。');
  }
  return receipt;
}
async function run() {
  const runtime = process.env.RUFA_RUNTIME_ROOT;
  const before = await inputs(runtime);
  const destination = receiptPath(), output = join(dirname(destination), 'history-safety.tap');
  await mkdir(dirname(destination), { recursive: true });
  // A new failed/interrupted run must not leave an older green receipt usable.
  await writeFile(destination + '.pending', JSON.stringify({ version: 1, passed: false, startedAt: new Date().toISOString() }), { flush: true });
  await rename(destination + '.pending', destination);
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-timeout=120000', ...suites], {
    cwd: root, env: { ...process.env, RUFA_RUNTIME_ROOT: resolve(runtime) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('exit', resolveCode); });
  await writeFile(output, stdout + stderr);
  const summary = stdout.match(/^# (tests|pass|fail|cancelled|skipped|todo|duration_ms) .+$/gm) ?? [];
  console.log(summary.join('\n'));
  if (code !== 0 || !/^# skipped 0$/m.test(stdout) || !/^# todo 0$/m.test(stdout)
    || !/^# tests [1-9]\d*$/m.test(stdout)) throw new Error(`History safety failed or skipped; inspect ${output}`);
  const after = await inputs(runtime);
  if (!isDeepStrictEqual(before, after)) throw new Error('History safety inputs changed while tests were running; rerun on the frozen candidate.');
  const receipt = { version: 1, passed: true, createdAt: new Date().toISOString(), suites, inputs: after };
  await writeFile(destination + '.pending', JSON.stringify(receipt, null, 2), { flush: true });
  await rename(destination + '.pending', destination);
  console.log(`History safety passed without skipped tests: ${destination}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--check')) await checkHistorySafetyReceipt(undefined, process.env.RUFA_RUNTIME_ROOT);
    else await run();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
