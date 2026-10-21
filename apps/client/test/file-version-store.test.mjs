import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, symlink, link, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFileVersionStore } from '../src/runtime/file-version-store.mjs';

const moduleUrl = new URL('../src/runtime/file-version-store.mjs', import.meta.url).href;
const meta = (phase = 'before', operationId = 'operation-1', sessionId = 'session-1') => ({ phase, operationId, sessionId, tool: 'write' });
const scope = { sessionId: 'session-1' };
async function fixture(t, extra = {}) {
  const base = await mkdtemp(join(tmpdir(), 'rufa-versions-'));
  const root = join(base, 'work'), directory = join(base, 'account', 'versions'); await mkdir(root);
  const config = { directory, allowedRoots: [root], ...extra };
  const store = await createFileVersionStore(config);
  t.after(async () => { await store.close(); await rm(base, { recursive: true, force: true }); });
  return { base, root, directory, config, store, path: join(root, '成果.txt') };
}
const code = expected => error => error.code === expected;

test('raw bytes, absent versus empty, CAS deduplication and operation attribution survive restart', async t => {
  const f = await fixture(t), absent = await f.store.capture(f.path, meta());
  assert.equal(absent.hash, null); assert.equal((await f.store.getVersion(absent.id, scope)).blobPath, null);
  await writeFile(f.path, Buffer.alloc(0)); const empty = await f.store.capture(f.path, meta('after'));
  assert.notEqual(empty.hash, null); assert.equal(empty.size, 0);
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x0d, 0x0a, 0, 255, 128, 13, 10]);
  await writeFile(f.path, bytes);
  const first = await f.store.capture(f.path, meta('before', 'two'));
  assert.equal((await f.store.capture(f.path, meta('before', 'two'))).id, first.id);
  const second = await f.store.capture(f.path, meta('after', 'three', 'child-session'));
  assert.notEqual(second.id, first.id); assert.equal(second.hash, first.hash);
  assert.deepEqual(await readFile((await f.store.getVersion(first.id, scope)).blobPath), bytes);
  assert.equal((await readdir(join(f.directory, 'blobs'))).length, 2);
  const list = await f.store.list(f.path, scope); assert.equal(list[0].id, second.id); assert.equal(list.length, 4);
  await f.store.close();
  const reopened = await createFileVersionStore(f.config); t.after(() => reopened.close());
  assert.deepEqual((await reopened.list(f.path, scope)).map(v => v.id), list.map(v => v.id));
  assert.deepEqual(await readFile((await reopened.getVersion(first.id, scope)).blobPath), bytes);
  await reopened.close();
});

test('restore saves current raw bytes, verifies restored bytes, and can reverse the restoration', async t => {
  const f = await fixture(t), original = Buffer.from([0, 255, 13, 10, 7]);
  await writeFile(f.path, original); const old = await f.store.capture(f.path, meta());
  const changed = Buffer.from('用户后来修改\r\n'); await writeFile(f.path, changed);
  const { fingerprint } = await f.store.current(f.path, scope);
  const result = await f.store.restore(old.id, { ...scope, expectedFingerprint: fingerprint });
  assert.deepEqual(await readFile(f.path), original); assert.equal(result.version.phase, 'restored');
  assert.equal(result.currentVersion.phase, 'before-restore');
  assert.deepEqual(await readFile((await f.store.getVersion(result.currentVersion.id, scope)).blobPath), changed);
  await f.store.restore(result.currentVersion.id, { ...scope, expectedFingerprint: (await f.store.current(f.path, scope)).fingerprint });
  assert.deepEqual(await readFile(f.path), changed);
});

test('completed restore ancestry uses exact source and backup ids, survives restart, and preserves the prior route', async t => {
  const f = await fixture(t);
  await writeFile(f.path, 'A'); const original = await f.store.capture(f.path, meta('after', 'a'));
  await writeFile(f.path, 'B'); const middle = await f.store.capture(f.path, meta('after', 'b'));
  await writeFile(f.path, 'A'); const equalContent = await f.store.capture(f.path, meta('after', 'a-again'));
  assert.equal(equalContent.hash, original.hash); assert.notEqual(equalContent.id, original.id);
  await writeFile(f.path, 'C'); const priorTip = await f.store.capture(f.path, meta('after', 'c'));
  const result = await f.store.restore(original.id, { ...scope, expectedFingerprint: (await f.store.current(f.path, scope)).fingerprint });
  assert.equal(result.version.restoredFromId, original.id);
  assert.equal(result.version.restoredFromCurrentId, result.currentVersion.id);
  assert.equal(result.currentVersion.hash, priorTip.hash); assert.notEqual(result.currentVersion.id, priorTip.id);
  const check = async store => {
    const rows = await store.list(f.path, scope), restored = rows.find(row => row.id === result.version.id);
    assert.equal(restored.restoredFromId, original.id); assert.equal(restored.restoredFromCurrentId, result.currentVersion.id);
    for (const id of [original.id, middle.id, equalContent.id, priorTip.id, result.currentVersion.id]) {
      const row = rows.find(value => value.id === id); assert.ok(row, 'existing history is retained');
      assert.equal(Object.hasOwn(row, 'restoredFromId'), false); assert.equal(Object.hasOwn(row, 'restoredFromCurrentId'), false);
    }
    const read = await store.getVersion(result.version.id, scope);
    assert.equal(read.restoredFromId, original.id); assert.equal(read.restoredFromCurrentId, result.currentVersion.id);
  };
  await check(f.store); await f.store.close();
  const reopened = await createFileVersionStore(f.config); t.after(() => reopened.close());
  await check(reopened); await reopened.close();
});

test('a completed operation only assigns ancestry to its exact restored result row', async t => {
  const f = await fixture(t); await writeFile(f.path, 'old'); const source = await f.store.capture(f.path, meta());
  await writeFile(f.path, 'current');
  const result = await f.store.restore(source.id, { ...scope, expectedFingerprint: (await f.store.current(f.path, scope)).fingerprint });
  // Extra metadata with the same operation and content is not the committed
  // result_id. This also exercises a restored phase without any restore row.
  const adjacent = await f.store.capture(f.path, meta('restored', result.version.operationId));
  const uncommitted = await f.store.capture(f.path, meta('restored', 'uncommitted'));
  for (const id of [adjacent.id, uncommitted.id, result.currentVersion.id]) {
    const read = await f.store.getVersion(id, scope), listed = (await f.store.list(f.path, scope)).find(row => row.id === id);
    for (const row of [read, listed]) {
      assert.equal(Object.hasOwn(row, 'restoredFromId'), false); assert.equal(Object.hasOwn(row, 'restoredFromCurrentId'), false);
    }
  }
  assert.equal((await f.store.getVersion(result.version.id, scope)).restoredFromId, source.id);
});

test('failed and unknown restorations never report a successful branch, even when verified result bytes were saved', async t => {
  const f = await fixture(t); await writeFile(f.path, 'old'); const source = await f.store.capture(f.path, meta()); await writeFile(f.path, 'current');
  const expectedFingerprint = (await f.store.current(f.path, scope)).fingerprint;
  await assert.rejects(f.store.restore(source.id, { ...scope, expectedFingerprint, beforePublish: async () => { throw new Error('guard refused'); } }), /guard refused/);
  assert.equal((await f.store.list(f.path, scope))[0].operationStatus, 'failed');
  // Simulate an index failure after the verified restored row was persisted,
  // but before the restore operation could commit its successful result_id.
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => {
    if (sql.startsWith("UPDATE restores SET state='completed'")) throw new Error('simulated completion index failure');
    return prepare(sql);
  };
  try { await assert.rejects(f.store.restore(source.id, { ...scope, expectedFingerprint }), code('RESTORE_UNKNOWN')); }
  finally { f.store.db.prepare = prepare; }
  const check = async store => {
    const rows = await store.list(f.path, scope);
    assert.ok(rows.some(row => row.phase === 'restored' && row.operationStatus === 'unknown'));
    assert.ok(rows.some(row => row.operationStatus === 'failed'));
    for (const listed of rows) for (const row of [listed, await store.getVersion(listed.id, scope)]) {
      assert.equal(Object.hasOwn(row, 'restoredFromId'), false); assert.equal(Object.hasOwn(row, 'restoredFromCurrentId'), false);
    }
  };
  await check(f.store); await f.store.close();
  const reopened = await createFileVersionStore(f.config); t.after(() => reopened.close());
  await check(reopened); await reopened.close();
});

test('stale preview and same-content external replacement are conflicts; simultaneous restores have one winner', async t => {
  const f = await fixture(t); await writeFile(f.path, 'before'); const old = await f.store.capture(f.path, meta());
  await writeFile(f.path, 'now'); const current = await f.store.current(f.path, scope);
  const temporary = join(f.root, 'replacement'); await writeFile(temporary, 'now'); await rename(temporary, f.path);
  await assert.rejects(f.store.restore(old.id, { ...scope, expectedFingerprint: current.fingerprint }), code('VERSION_CONFLICT'));
  assert.equal(await readFile(f.path, 'utf8'), 'now');
  const expectedFingerprint = (await f.store.current(f.path, scope)).fingerprint;
  const results = await Promise.allSettled([f.store.restore(old.id, { ...scope, expectedFingerprint }), f.store.restore(old.id, { ...scope, expectedFingerprint })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'VERSION_CONFLICT');
});

test('restoring an absent version never deletes a file; existing bytes can restore a missing file without creating directories', async t => {
  const f = await fixture(t); const absent = await f.store.capture(f.path, meta());
  await writeFile(f.path, 'keep');
  await assert.rejects(f.store.restore(absent.id, { ...scope, expectedFingerprint: (await f.store.current(f.path, scope)).fingerprint }), code('ABSENT_VERSION'));
  const present = await f.store.capture(f.path, meta('after')); await unlink(f.path);
  const result = await f.store.restore(present.id, { ...scope, expectedFingerprint: (await f.store.current(f.path, scope)).fingerprint });
  assert.equal(result.currentVersion.hash, null); assert.equal(await readFile(f.path, 'utf8'), 'keep');
  const nested = join(f.root, 'missing', 'more', 'report.docx');
  assert.equal((await f.store.capture(nested, meta('before', 'nested'))).hash, null);
});

test('scope is reread, exact-file grants do not grant siblings, and sessions may share an authorized project', async t => {
  let roots = [], calls = 0;
  const f = await fixture(t, { allowedRoots: async sessionId => { calls++; assert.ok(['session-1', 'session-2'].includes(sessionId)); return roots; } });
  roots = [{ path: f.path, kind: 'file' }];
  await f.store.capture(f.path, meta()); await writeFile(f.path, 'mine'); const version = await f.store.capture(f.path, meta('after'));
  await assert.rejects(f.store.current(join(f.root, 'other.txt'), scope), code('PATH_NOT_ALLOWED'));
  assert.equal((await f.store.getVersion(version.id, { sessionId: 'session-2' })).id, version.id);
  assert.equal((await f.store.list(f.path, { sessionId: 'session-2' })).length, 2);
  roots = []; await assert.rejects(f.store.getVersion(version.id, scope), code('PATH_NOT_ALLOWED'));
  await assert.rejects(f.store.list(f.path, scope), code('PATH_NOT_ALLOWED')); assert.ok(calls >= 6);
});

test('private directories and another account remain inaccessible even under broad allowed roots', async t => {
  const f = await fixture(t), privatePath = join(f.root, 'private'); await mkdir(privatePath);
  await f.store.close();
  const store = await createFileVersionStore({ ...f.config, allowedRoots: [f.base], privateRoots: [privatePath] }); t.after(() => store.close());
  await writeFile(join(privatePath, 'secret'), 'secret');
  await assert.rejects(store.capture(join(privatePath, 'secret'), meta()), code('PATH_NOT_ALLOWED'));
  await assert.rejects(store.capture(join(f.directory, 'versions.sqlite'), meta()), code('PATH_NOT_ALLOWED'));
  await writeFile(f.path, 'a'); const version = await store.capture(f.path, meta());
  const other = await createFileVersionStore({ ...f.config, directory: join(f.base, 'other-account', 'versions') }); t.after(() => other.close());
  await assert.rejects(other.getVersion(version.id, scope), code('VERSION_NOT_FOUND'));
  await other.close(); await store.close();
});

test('directories, hardlinks, junctions, private-store redirection and Windows special paths are rejected', async t => {
  const f = await fixture(t); await writeFile(f.path, 'safe');
  await assert.rejects(f.store.capture(f.root, meta()), code('UNSAFE_PATH'));
  const hard = join(f.root, 'hard'); await link(f.path, hard);
  await assert.rejects(f.store.current(f.path, scope), code('UNSAFE_PATH')); await unlink(hard);
  const target = join(f.root, 'real'), alias = join(f.root, 'alias'); await mkdir(target); await writeFile(join(target, 'file'), 'safe');
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.capture(join(alias, 'file'), meta()), code('UNSAFE_PATH'));
  for (const name of ['NUL.txt', 'report.txt:secret', 'COM1']) await assert.rejects(f.store.capture(join(f.root, name), meta()), code('UNSAFE_PATH'));
  const moved = join(f.base, 'moved-blobs'); await rename(join(f.directory, 'blobs'), moved);
  await symlink(moved, join(f.directory, 'blobs'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.current(f.path, scope), code('UNSAFE_PATH'));
});

test('changed parent identity invalidates preview even when target bytes and path agree', async t => {
  const f = await fixture(t), folder = join(f.root, 'folder'), path = join(folder, 'file'); await mkdir(folder);
  await writeFile(path, 'old'); const old = await f.store.capture(path, meta()); await writeFile(path, 'new');
  const expectedFingerprint = (await f.store.current(path, scope)).fingerprint;
  await rename(folder, join(f.root, 'retired')); await mkdir(folder); await writeFile(path, 'new');
  await assert.rejects(f.store.restore(old.id, { ...scope, expectedFingerprint }), code('VERSION_CONFLICT'));
  assert.equal(await readFile(path, 'utf8'), 'new');
});

test('oversize and corrupt blobs fail closed; concurrent equal content uses one blob', async t => {
  const f = await fixture(t, { maxFileBytes: 16 }); await writeFile(f.path, 'x'.repeat(17));
  await assert.rejects(f.store.capture(f.path, meta()), code('FILE_TOO_LARGE')); assert.equal((await f.store.list(f.path, scope)).length, 0);
  const other = join(f.root, 'other'); await writeFile(f.path, 'equal'); await writeFile(other, 'equal');
  const versions = await Promise.all([f.store.capture(f.path, meta()), f.store.capture(other, meta())]);
  assert.equal(versions[0].hash, versions[1].hash); assert.equal((await readdir(join(f.directory, 'blobs'))).length, 1);
  const blob = (await f.store.getVersion(versions[0].id, scope)).blobPath; await writeFile(blob, 'equal'.toUpperCase());
  await assert.rejects(f.store.getVersion(versions[0].id, scope), code('BLOB_CORRUPT'));
  await assert.rejects(f.store.restore(versions[0].id, { ...scope, expectedFingerprint: (await f.store.current(f.path, scope)).fingerprint }), code('BLOB_CORRUPT'));
  assert.equal(await readFile(f.path, 'utf8'), 'equal');
});

test('authority lost after publication is unknown rather than a false failure with no side effect', async t => {
  let armed = false, root, path;
  const f = await fixture(t, { allowedRoots: async () => armed && await readFile(path, 'utf8') === 'before' ? [] : [root] });
  root = f.root; path = f.path; await writeFile(path, 'before'); const version = await f.store.capture(path, meta());
  await writeFile(path, 'current'); const expectedFingerprint = (await f.store.current(path, scope)).fingerprint; armed = true;
  await assert.rejects(f.store.restore(version.id, { ...scope, expectedFingerprint }), error => error.code === 'RESTORE_UNKNOWN' && !!error.currentVersion);
  armed = false; assert.equal(await readFile(path, 'utf8'), 'before');
  const saved = (await f.store.list(path, scope)).find(v => v.phase === 'before-restore');
  assert.equal(saved.operationStatus, 'unknown'); assert.equal(await readFile((await f.store.getVersion(saved.id, scope)).blobPath, 'utf8'), 'current');
});

test('external edit while a restoration is staged aborts publication and preserves both newer content and backup', async t => {
  let armed = false, root, path;
  const f = await fixture(t, { allowedRoots: async () => {
    if (armed && (await readdir(root)).some(name => name.startsWith('.rufa-restore-'))) { armed = false; await writeFile(path, 'external latest'); }
    return [root];
  } });
  root = f.root; path = f.path; await writeFile(path, 'before'); const version = await f.store.capture(path, meta());
  await writeFile(path, 'current'); const expectedFingerprint = (await f.store.current(path, scope)).fingerprint; armed = true;
  await assert.rejects(f.store.restore(version.id, { ...scope, expectedFingerprint }), code('VERSION_CONFLICT'));
  assert.equal(await readFile(path, 'utf8'), 'external latest');
  const saved = (await f.store.list(path, scope)).find(v => v.phase === 'before-restore');
  assert.equal(saved.operationStatus, 'failed'); assert.equal(await readFile((await f.store.getVersion(saved.id, scope)).blobPath, 'utf8'), 'current');
  assert.equal((await readdir(root)).some(name => name.startsWith('.rufa-restore-')), false);
});

test('Windows atomic restoration retains a protected DACL', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await writeFile(f.path, 'old'); const version = await f.store.capture(f.path, meta()); await writeFile(f.path, 'new');
  // The path is passed via an environment variable, never interpolated into shell code.
  const run = script => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, RUFA_ACL_TEST_PATH: f.path } });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const before = run("$ErrorActionPreference='Stop'; $a=[System.IO.File]::GetAccessControl($env:RUFA_ACL_TEST_PATH); $a.SetAccessRuleProtection($true,$true); [System.IO.File]::SetAccessControl($env:RUFA_ACL_TEST_PATH,$a); [System.IO.File]::GetAccessControl($env:RUFA_ACL_TEST_PATH).Sddl");
  const expectedFingerprint = (await f.store.current(f.path, scope)).fingerprint;
  await f.store.restore(version.id, { ...scope, expectedFingerprint });
  assert.equal(run("$ErrorActionPreference='Stop'; [System.IO.File]::GetAccessControl($env:RUFA_ACL_TEST_PATH).Sddl"), before);
  assert.equal(await readFile(f.path, 'utf8'), 'old');
});

test('publication guard rejection retains the current backup and never replaces the target', async t => {
  const f = await fixture(t); await writeFile(f.path, 'old'); const version = await f.store.capture(f.path, meta()); await writeFile(f.path, 'current');
  const expectedFingerprint = (await f.store.current(f.path, scope)).fingerprint;
  const denied = Object.assign(new Error('账号已变化。'), { code: 'LOGIN_CHANGED' }); let calls = 0;
  await assert.rejects(f.store.restore(version.id, { ...scope, expectedFingerprint, beforePublish: async () => {
    calls++;
    assert.ok((await readdir(f.root)).some(name => name.startsWith('.rufa-restore-')));
    const saved = (await f.store.list(f.path, scope)).find(v => v.phase === 'before-restore');
    assert.equal(await readFile((await f.store.getVersion(saved.id, scope)).blobPath, 'utf8'), 'current');
    throw denied;
  } }), error => error === denied && !!error.currentVersion);
  assert.equal(calls, 1); assert.equal(await readFile(f.path, 'utf8'), 'current');
  const rows = await f.store.list(f.path, scope);
  assert.equal(rows[0].operationStatus, 'failed'); assert.equal(rows.some(row => row.phase === 'restored'), false);
  assert.equal((await readdir(f.root)).some(name => name.startsWith('.rufa-restore-')), false);
});

test('an external edit during a delayed publication guard is caught by the subsequent complete fingerprint check', async t => {
  const f = await fixture(t); await writeFile(f.path, 'old'); const version = await f.store.capture(f.path, meta()); await writeFile(f.path, 'current');
  const expectedFingerprint = (await f.store.current(f.path, scope)).fingerprint;
  let enter, release; const entered = new Promise(done => { enter = done; }), gate = new Promise(done => { release = done; });
  const restoration = f.store.restore(version.id, { ...scope, expectedFingerprint, beforePublish: async () => { enter(); await gate; } });
  const refused = assert.rejects(restoration, code('VERSION_CONFLICT'));
  await entered; await writeFile(f.path, 'external edit while confirming'); release(); await refused;
  assert.equal(await readFile(f.path, 'utf8'), 'external edit while confirming');
  const saved = (await f.store.list(f.path, scope)).find(v => v.phase === 'before-restore');
  assert.equal(saved.operationStatus, 'failed'); assert.equal(await readFile((await f.store.getVersion(saved.id, scope)).blobPath, 'utf8'), 'current');
});

test('abort cancels a stalled publication guard without overwriting or leaving a prepared operation', { timeout: 10000 }, async t => {
  const f = await fixture(t); await writeFile(f.path, 'old'); const version = await f.store.capture(f.path, meta()); await writeFile(f.path, 'current');
  const expectedFingerprint = (await f.store.current(f.path, scope)).fingerprint, control = new AbortController();
  let enter; const entered = new Promise(done => { enter = done; });
  const restoration = f.store.restore(version.id, { ...scope, expectedFingerprint, signal: control.signal, beforePublish: () => { enter(); return new Promise(() => {}); } });
  const refused = assert.rejects(restoration, error => error.name === 'AbortError' && !!error.currentVersion);
  await entered; control.abort(); await refused;
  assert.equal(await readFile(f.path, 'utf8'), 'current');
  assert.equal((await f.store.list(f.path, scope))[0].operationStatus, 'failed');
  assert.equal((await readdir(f.root)).some(name => name.startsWith('.rufa-restore-')), false);
});

test('cancellation during post-guard filesystem checks is still checked immediately before publication', async t => {
  let armed = false, root; const control = new AbortController();
  const f = await fixture(t, { allowedRoots: async () => { if (armed) control.abort(); return [root]; } }); root = f.root;
  await writeFile(f.path, 'old'); const version = await f.store.capture(f.path, meta()); await writeFile(f.path, 'current');
  const expectedFingerprint = (await f.store.current(f.path, scope)).fingerprint;
  await assert.rejects(f.store.restore(version.id, { ...scope, expectedFingerprint, signal: control.signal, beforePublish: async () => { armed = true; } }), error => error.name === 'AbortError');
  armed = false; assert.equal(await readFile(f.path, 'utf8'), 'current');
  assert.equal((await f.store.list(f.path, scope))[0].operationStatus, 'failed');
});

test('already cancelled restore never runs the guard or creates a restore operation', async t => {
  const f = await fixture(t); await writeFile(f.path, 'old'); const version = await f.store.capture(f.path, meta()); await writeFile(f.path, 'current');
  const expectedFingerprint = (await f.store.current(f.path, scope)).fingerprint;
  await assert.rejects(f.store.restore(version.id, { ...scope, expectedFingerprint, signal: AbortSignal.abort(), beforePublish: () => assert.fail('obsolete request') }), error => error.name === 'AbortError');
  assert.equal(await readFile(f.path, 'utf8'), 'current'); assert.equal((await f.store.list(f.path, scope)).length, 1);
});

test('one account database has one process owner; close rejects later work', async t => {
  const f = await fixture(t);
  await assert.rejects(createFileVersionStore(f.config), code('STORE_BUSY'));
  await f.store.close(); await assert.rejects(f.store.list(f.path, scope), code('STORE_CLOSED'));
  const reopened = await createFileVersionStore(f.config); await reopened.close();
});

test('process exit after publication keeps the before-restore backup and reopens as unknown without replay', async t => {
  const f = await fixture(t); await writeFile(f.path, 'old'); const version = await f.store.capture(f.path, meta());
  await writeFile(f.path, 'latest'); await f.store.close();
  const script = `import {readFile} from 'node:fs/promises'; import {createFileVersionStore} from ${JSON.stringify(moduleUrl)};
    const config=${JSON.stringify(f.config)}, path=${JSON.stringify(f.path)}; let armed=false;
    config.allowedRoots=async()=>{if(armed && await readFile(path,'utf8')==='old')process.exit(23); return ${JSON.stringify([f.root])};};
    const store=await createFileVersionStore(config); const current=await store.current(path,{sessionId:'session-1'}); armed=true;
    await store.restore(${JSON.stringify(version.id)},{sessionId:'session-1',expectedFingerprint:current.fingerprint}); process.exit(99);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(child.status, 23, child.stderr);
  const reopened = await createFileVersionStore(f.config); t.after(() => reopened.close());
  const saved = (await reopened.list(f.path, scope)).find(v => v.phase === 'before-restore');
  assert.equal(saved.operationStatus, 'unknown'); assert.equal(await readFile(f.path, 'utf8'), 'old');
  assert.equal(await readFile((await reopened.getVersion(saved.id, scope)).blobPath, 'utf8'), 'latest');
  assert.equal((await reopened.list(f.path, scope)).some(v => v.phase === 'restored'), false); await reopened.close();
});
