// One-off, offline companion to the server's reviewed permission-only cleanup.
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, rename, stat, lstat, realpath } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { initializationOnly, emptyConversationState } from '../apps/client/src/runtime/empty-session-policy.mjs';
import { planLocalBlankSessions } from './local-blank-session-backup.mjs';

export const TARGET = 'session-11111111-1111-4111-8111-111111111111';
const RETURN_TO = 'session-22222222-2222-4222-8222-222222222222';
async function validateRegular(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  assert.equal((await realpath(path)).toLowerCase(), resolve(path).toLowerCase());
}
async function regular(path) { await validateRegular(path); return readFile(path, 'utf8'); }
const absent = path => stat(path).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
async function replace(path, contents) {
  const temporary = `${path}.maintenance-${randomUUID()}`;
  await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

export async function cleanupLegacyLocalSession(backupDirectory, receiptFile) {
  backupDirectory = await realpath(backupDirectory);
  receiptFile = join(await realpath(dirname(receiptFile)), basename(receiptFile));
  const plan = JSON.parse(await regular(join(backupDirectory, 'plan.json')));
  const receipt = JSON.parse(await regular(receiptFile));
  assert.equal(receipt.targetId, TARGET); assert.equal(receipt.status, 'complete'); assert.equal(receipt.targetAbsent, true);
  assert.equal(receipt.applied.deletedSessions, 1); assert.equal(receipt.applied.deletedEvents, 19);
  assert.deepEqual(receipt.applied.skipped, {});
  const home = await realpath(plan.accountHome);
  const current = await planLocalBlankSessions(home);
  assert.deepEqual(current.fingerprints, plan.fingerprints, 'Account changed since the closed-client backup');
  await validateRegular(join(backupDirectory, 'company-history.sqlite'));
  const saved = new DatabaseSync(join(backupDirectory, 'company-history.sqlite'), { readOnly: true });
  try {
    assert.equal(saved.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const fingerprints = {};
    for (const row of saved.prepare('SELECT * FROM sessions ORDER BY id').all()) {
      const events = saved.prepare('SELECT seq,event FROM events WHERE session_id=? ORDER BY seq').all(row.id);
      fingerprints[row.id] = createHash('sha256').update(JSON.stringify({ row, events })).digest('hex');
    }
    assert.deepEqual(fingerprints, plan.fingerprints, 'Recoverable SQLite backup must match the reviewed plan');
  } finally { saved.close(); }
  const database = join(home, 'company-history.sqlite');
  const uiPath = join(home, 'browser-ui-state.json'), registryPath = join(home, 'storages/workspace.json');
  const uiRaw = await regular(uiPath), registryRaw = await regular(registryPath);
  assert.equal(uiRaw, await regular(join(backupDirectory, 'browser-ui-state.json')));
  assert.equal(registryRaw, await regular(join(backupDirectory, 'workspace.json')));
  const ui = JSON.parse(uiRaw), registry = JSON.parse(registryRaw);
  assert.ok(emptyConversationState(ui.entries[`dsh.conversation.${TARGET}`]), 'Target has a saved draft');
  assert.deepEqual(registry.unit, { name: 'workspace', version: 2 });
  assert.equal(registry.pendingMutation, undefined);
  for (const suffix of ['.json', '.json.pending']) assert.ok(await absent(join(home, 'company-pending-events', TARGET + suffix)), 'Unexpected pending journal');
  const db = new DatabaseSync(database, { enableForeignKeyConstraints: true });
  let committed = false, filesChanged = false, projectionStaged;
  try {
    const row = db.prepare('SELECT * FROM sessions WHERE id=?').get(TARGET);
    assert.ok(row && row.cloud_state === 'remote' && row.ready === 1 && row.conflict === null && row.inherited === 0);
    assert.equal(row.event_count, 19); assert.equal(row.synced_seq, 19); assert.equal(row.remote_seq, 19);
    assert.equal(db.prepare("SELECT count(*) n FROM sessions WHERE json_extract(header,'$.parentSession')=?").get(TARGET).n, 0);
    const events = db.prepare('SELECT event FROM events WHERE session_id=? ORDER BY seq').all(TARGET).map(row => JSON.parse(row.event));
    assert.equal(events.length, 19);
    for (const [seq, event] of events.entries()) {
      assert.equal(event.seq, seq); assert.ok(Number.isSafeInteger(event.time) && event.time >= 0);
      assert.ok(Object.keys(event).every(key => ['type', 'seq', 'time', 'data'].includes(key)));
    }
    assert.equal(events[3].type, 'command/run');
    assert.deepEqual(events[3].data, { commandId: 'cmd-1f2529f9-2', name: 'permission', args: ' auto', source: { kind: 'user' } });
    assert.equal(events[6].type, 'command/done');
    assert.deepEqual(events[6].data, { commandId: 'cmd-1f2529f9-2', kind: 'success', text: 'preset auto' });
    assert.ok(initializationOnly({ id: TARGET, header: JSON.parse(row.header), ready: true, inheritedEventCount: 0 },
      events.filter((_, index) => index !== 3 && index !== 6).map((event, seq) => ({ ...event, seq }))));
    assert.ok(db.prepare("SELECT 1 FROM events WHERE session_id=? AND json_extract(event,'$.type')='user/message'").get(RETURN_TO), 'Return conversation must have real messages');
    delete ui.entries[`dsh.conversation.${TARGET}`];
    if (JSON.parse(ui.entries['dsh.sessions.current'] || '{}').sessionId === TARGET) ui.entries['dsh.sessions.current'] = JSON.stringify({ sessionId: RETURN_TO });
    for (const workspace of Object.values(registry.tables.workspaces)) {
      assert.ok(Array.isArray(workspace.sessionIds)); workspace.sessionIds = workspace.sessionIds.filter(id => id !== TARGET);
    }
    for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
      assert.ok(Array.isArray(registry.global[key])); registry.global[key] = registry.global[key].filter(id => id !== TARGET);
    }
    const projection = join(home, 'storages/session_projcache/sessions', `${TARGET}.json`);
    const hasProjection = !await absent(projection);
    if (hasProjection) { await regular(projection); await copyFile(projection, join(backupDirectory, 'target-projection.json')); }
    await writeFile(join(backupDirectory, 'local-repair.json'), JSON.stringify({ targetId: TARGET, phase: 'prepared' }), { flag: 'wx', mode: 0o600 });
    db.exec('BEGIN IMMEDIATE');
    try {
      assert.deepEqual((await planLocalBlankSessions(home)).fingerprints, plan.fingerprints, 'Concurrent account mutation');
      filesChanged = true;
      await replace(uiPath, JSON.stringify(ui)); await replace(registryPath, JSON.stringify(registry, null, 2));
      if (hasProjection) {
        const destination = `${projection}.discard-maintenance`; assert.ok(await absent(destination));
        await rename(projection, destination); projectionStaged = destination;
      }
      assert.equal(Number(db.prepare('DELETE FROM events WHERE session_id=?').run(TARGET).changes), 19);
      assert.equal(Number(db.prepare('DELETE FROM sessions WHERE id=?').run(TARGET).changes), 1);
      db.exec('COMMIT'); committed = true;
    } catch (error) {
      db.exec('ROLLBACK');
      if (filesChanged) { await replace(uiPath, uiRaw); await replace(registryPath, registryRaw); }
      if (projectionStaged) await rename(projectionStaged, projection);
      throw error;
    }
  } finally { db.close(); }
  assert.equal(committed, true);
  const after = await planLocalBlankSessions(home);
  assert.equal(after.fingerprints[TARGET], undefined);
  for (const [id, hash] of Object.entries(plan.fingerprints)) if (id !== TARGET) assert.equal(after.fingerprints[id], hash);
  assert.equal(after.total, plan.total - 1);
  await replace(join(backupDirectory, 'local-repair.json'), JSON.stringify({ targetId: TARGET, phase: 'complete', remaining: after.total }));
  return { deleted: 1, remaining: after.total, retainedVerified: after.total };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await cleanupLegacyLocalSession(process.argv[2], process.argv[3])));
}
