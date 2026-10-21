// Fixed Win32-x64 payload optimization. No package graph pruning or globs.
import { readFile, readdir, lstat, realpath, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const lockBytes = await readFile(new URL('../runtime-slim.lock.json', import.meta.url));
const policy = JSON.parse(lockBytes);
const policySha256 = createHash('sha256').update(lockBytes).digest('hex');
const markerName = 'rufa-runtime-slim.json';
const removedNames = new Set(policy.removed.map(row => row.path));
const comparable = path => process.platform === 'win32' ? path.toLowerCase() : path;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

for (const row of [...policy.removed, ...policy.retained]) {
  if (!row.path.startsWith('node_modules/node-pty/') || row.path.includes('\\') || row.path.split('/').some(part => !part || part === '.' || part === '..')
    || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Invalid runtime slim policy');
}
if (policy.removed.length !== 6 || policy.removed.some(row => !row.path.startsWith('node_modules/node-pty/prebuilds/win32-arm64/')))
  throw new Error('Only the six pinned ARM64 prebuild files may be removed');

async function rootPath(input) {
  const root = resolve(input), stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || comparable(await realpath(root)) !== comparable(root)) throw new Error('Slim runtime must be a real canonical directory');
  return root;
}
async function safeFile(root, name, allowMissing = false) {
  const path = resolve(root, name), suffix = relative(root, path);
  if (!suffix || suffix.startsWith(`..${sep}`) || suffix === '..' || isAbsolute(suffix)) throw new Error('Slim path escapes runtime');
  let current = root;
  for (const [index, part] of name.split('/').entries()) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return undefined; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Slim refuses redirected path: ${name}`);
    if (index === name.split('/').length - 1 ? !stat.isFile() : !stat.isDirectory()) throw new Error(`Invalid slim file: ${name}`);
  }
  return path;
}
async function verifyFile(root, row, allowMissing) {
  const path = await safeFile(root, row.path, allowMissing);
  if (!path) return false;
  const bytes = await readFile(path);
  if (bytes.length !== row.bytes || sha(bytes) !== row.sha256) throw new Error(`Pinned slim file changed: ${row.path}`);
  return true;
}
async function inspect(input) {
  const root = await rootPath(input);
  const manifest = JSON.parse(await readFile(await safeFile(root, 'rufa-runtime.json'), 'utf8'));
  if (manifest.upstreamCommit !== policy.upstreamCommit || manifest.platform !== policy.platform) throw new Error('Unsupported slim runtime revision or platform');
  const markerPath = await safeFile(root, markerName, true);
  const marker = markerPath ? JSON.parse(await readFile(markerPath, 'utf8')) : undefined;
  if (marker && (marker.schemaVersion !== 1 || marker.policySha256 !== policySha256 || marker.policyId !== policy.id
    || !['prepared', 'complete'].includes(marker.state) || !/^[a-f0-9]{64}$/.test(marker.retainedSha256)
    || !Number.isSafeInteger(marker.beforeBytes) || !Number.isSafeInteger(marker.beforeFiles))) throw new Error('Invalid runtime slim marker');
  for (const row of policy.retained) await verifyFile(root, row, false);
  const present = [];
  for (const row of policy.removed) if (await verifyFile(root, row, Boolean(marker))) present.push(row);
  return { root, marker, present };
}

// A sorted content inventory proves the optimization changes no retained byte.
// It is a per-application proof, not a prohibition on subsequent normal updates.
async function inventory(root) {
  const rows = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), name = relative(root, path).replaceAll('\\', '/');
      if (name === markerName || name.startsWith(`${markerName}.`) && name.endsWith('.pending')) continue;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Slim inventory refuses redirected path: ${name}`);
      if (stat.isDirectory()) await walk(path);
      else {
        if (!stat.isFile()) throw new Error(`Unsupported runtime entry: ${name}`);
        const bytes = await readFile(path); rows.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  await walk(root); rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files: rows.length, bytes: rows.reduce((n, row) => n + row.bytes, 0),
    retainedSha256: sha(JSON.stringify(rows.filter(row => !removedNames.has(row.path)))) };
}
async function writeMarker(root, marker) {
  const path = join(root, markerName), temporary = `${path}.${randomUUID()}.pending`;
  try {
    await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function report(state, before) {
  const removableBytes = state.present.reduce((n, row) => n + row.bytes, 0);
  return { policyId: policy.id, policySha256, state: state.present.length ? 'needs-apply' : state.marker?.state ?? 'unprepared',
    beforeFiles: before.files, beforeBytes: before.bytes, afterFiles: before.files - state.present.length,
    afterBytes: before.bytes - removableBytes, removableFiles: state.present.length, removableBytes,
    retainedSha256: before.retainedSha256, paths: state.present.map(row => row.path) };
}

/** Read-only full audit. Running it never applies missing patches or prunes files. */
export async function auditRuntimeSlim(input) {
  const state = await inspect(input), before = await inventory(state.root);
  return report(state, before);
}

/** Only call on an explicitly selected candidate or during a controlled update. */
export async function applyRuntimeSlim(input) {
  const state = await inspect(input);
  if (!state.present.length && state.marker?.state === 'complete') return {
    policyId: policy.id, policySha256, state: 'complete', changed: false,
    validation: 'pinned-native-files', removableFiles: 0, removableBytes: 0,
  };
  const before = await inventory(state.root), plan = report(state, before);
  if (state.marker?.state === 'prepared' && before.retainedSha256 !== state.marker.retainedSha256) throw new Error('Retained runtime changed during interrupted slim operation');
  const marker = { schemaVersion: 1, policyId: policy.id, policySha256, state: 'prepared',
    upstreamCommit: policy.upstreamCommit, platform: policy.platform,
    beforeFiles: before.files, beforeBytes: before.bytes, retainedSha256: before.retainedSha256,
    removed: policy.removed };
  await writeMarker(state.root, marker);
  // Validate the entire allowlist before this first deletion. Revalidate each
  // precise file immediately before unlink; hardlink peers remain untouched.
  for (const row of state.present) {
    await verifyFile(state.root, row, false);
    await unlink(await safeFile(state.root, row.path));
  }
  const after = await inventory(state.root);
  if (after.retainedSha256 !== before.retainedSha256 || after.files !== plan.afterFiles || after.bytes !== plan.afterBytes)
    throw new Error('Runtime changed outside the exact slimming allowlist');
  await writeMarker(state.root, { ...marker, state: 'complete', afterFiles: after.files, afterBytes: after.bytes,
    removedBytesThisApplication: plan.removableBytes, policyRemovalBytes: policy.removed.reduce((n, row) => n + row.bytes, 0), retainedFilesUnchanged: true });
  return { ...plan, state: 'complete', validation: 'full-content-inventory', retainedFilesUnchanged: true, changed: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [root, action = '--audit', ...extra] = process.argv.slice(2);
  if (!root || extra.length || !['--audit', '--apply'].includes(action)) throw new Error('Usage: node runtime-slim.mjs <runtime> [--audit|--apply]');
  console.log(JSON.stringify(await (action === '--apply' ? applyRuntimeSlim(root) : auditRuntimeSlim(root)), null, 2));
}
