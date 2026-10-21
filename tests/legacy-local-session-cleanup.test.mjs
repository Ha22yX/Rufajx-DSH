import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionCache } from '../apps/client/src/runtime/session-cache.mjs';
import { backupLocalSessions, planLocalBlankSessions } from '../scripts/local-blank-session-backup.mjs';
import { cleanupLegacyLocalSession, TARGET } from '../scripts/cleanup-legacy-local-session.mjs';
const RETURN_TO = 'session-22222222-2222-4222-8222-222222222222';

async function fixture({ message = false, draft = '', receiptOk = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rufa-legacy-cleanup-')), home = join(root, 'account'), backup = join(root, 'backup');
  const cache = new SessionCache(home);
  const header = id => ({ version: 4, id, createdAt: 1000, isSeeded: false, agentPreset: 'standard', cwd: home });
  cache.ensure(header(TARGET));
  const events = Array.from({ length: 19 }, (_, seq) => ({ type: 'permission/preset', seq, time: 1000 + seq, data: { preset: 'auto' } }));
  events[3] = { ...events[3], type: 'command/run', data: { commandId: 'cmd-1f2529f9-2', name: 'permission', args: ' auto', source: { kind: 'user' } } };
  events[6] = { ...events[6], type: 'command/done', data: { commandId: 'cmd-1f2529f9-2', kind: 'success', text: 'preset auto' } };
  if (message) events[10] = { ...events[10], type: 'user/message', data: { content: [{ type: 'text', text: 'Keep this' }] } };
  cache.append(TARGET, events); cache.checkpoint(TARGET, 19);
  cache.ensure(header(RETURN_TO)); cache.append(RETURN_TO, [{ type: 'user/message', seq: 0, time: 2000, data: { content: [{ type: 'text', text: 'Retained task' }] } }]); cache.checkpoint(RETURN_TO, 1); cache.close();
  await mkdir(join(home, 'storages/session_projcache/sessions'), { recursive: true });
  await writeFile(join(home, 'storages/session_projcache/sessions', TARGET + '.json'), '{}');
  const registry = { unit: { name: 'workspace', version: 2 }, global: { archivedSessionIds: [], pinnedSessionIds: [RETURN_TO], workspaceIds: ['project'] },
    tables: { workspaces: { project: { path: home, title: 'Keep project', createdAt: '2000-01-01', updatedAt: '2000-02-01', sessionIds: [TARGET, RETURN_TO] } } } };
  await writeFile(join(home, 'storages/workspace.json'), JSON.stringify(registry));
  await writeFile(join(home, 'browser-ui-state.json'), JSON.stringify({ version: 1, entries: { 'dsh.sessions.current': JSON.stringify({ sessionId: TARGET }), [`dsh.conversation.${TARGET}`]: JSON.stringify({ draft: { text: draft, references: [] } }), 'rufa.projects.view.v1': '{"keep":true}' } }));
  await backupLocalSessions(home, backup);
  const receipt = join(root, 'receipt.json');
  await writeFile(receipt, JSON.stringify({ targetId: TARGET, status: receiptOk ? 'complete' : 'failed', targetAbsent: receiptOk, applied: { deletedSessions: 1, deletedEvents: 19, skipped: {} } }));
  return { home, backup, receipt, registry };
}

test('offline legacy cleanup requires cloud proof and preserves meaningful records, drafts and project metadata', async t => {
  for (const options of [{ message: true }, { draft: 'Unsent' }, { receiptOk: false }]) {
    const f = await fixture(options), before = await planLocalBlankSessions(f.home);
    await assert.rejects(cleanupLegacyLocalSession(f.backup, f.receipt));
    assert.deepEqual((await planLocalBlankSessions(f.home)).fingerprints, before.fingerprints);
    assert.deepEqual(JSON.parse(await readFile(join(f.home, 'storages/workspace.json'))), f.registry);
  }
  const missingBackup = await fixture();
  await rename(join(missingBackup.backup, 'company-history.sqlite'), join(missingBackup.backup, 'unavailable.sqlite'));
  await assert.rejects(cleanupLegacyLocalSession(missingBackup.backup, missingBackup.receipt));
  assert.equal((await planLocalBlankSessions(missingBackup.home)).total, 2);
  const priorStage = await fixture();
  const projection = join(priorStage.home, 'storages/session_projcache/sessions', TARGET + '.json');
  await writeFile(projection + '.discard-maintenance', 'Existing unrelated stage');
  await assert.rejects(cleanupLegacyLocalSession(priorStage.backup, priorStage.receipt));
  assert.equal(await readFile(projection, 'utf8'), '{}');
  assert.equal(await readFile(projection + '.discard-maintenance', 'utf8'), 'Existing unrelated stage');
  assert.equal((await planLocalBlankSessions(priorStage.home)).total, 2);
  const failing = await fixture(), beforeFailure = await planLocalBlankSessions(failing.home);
  const db = new DatabaseSync(join(failing.home, 'company-history.sqlite'));
  db.exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;"); db.close();
  await assert.rejects(cleanupLegacyLocalSession(failing.backup, failing.receipt));
  assert.deepEqual((await planLocalBlankSessions(failing.home)).fingerprints, beforeFailure.fingerprints);
  assert.deepEqual(JSON.parse(await readFile(join(failing.home, 'storages/workspace.json'))), failing.registry);
  assert.equal(JSON.parse((JSON.parse(await readFile(join(failing.home, 'browser-ui-state.json')))).entries['dsh.sessions.current']).sessionId, TARGET);
  assert.equal(await readFile(join(failing.home, 'storages/session_projcache/sessions', TARGET + '.json'), 'utf8'), '{}');
  const f = await fixture();
  assert.deepEqual(await cleanupLegacyLocalSession(f.backup, f.receipt), { deleted: 1, remaining: 1, retainedVerified: 1 });
  const registry = JSON.parse(await readFile(join(f.home, 'storages/workspace.json')));
  f.registry.tables.workspaces.project.sessionIds = [RETURN_TO]; assert.deepEqual(registry, f.registry);
  const ui = JSON.parse(await readFile(join(f.home, 'browser-ui-state.json')));
  assert.equal(ui.entries[`dsh.conversation.${TARGET}`], undefined);
  assert.equal(JSON.parse(ui.entries['dsh.sessions.current']).sessionId, RETURN_TO);
  assert.equal(ui.entries['rufa.projects.view.v1'], '{"keep":true}');
  assert.equal(JSON.parse(await readFile(join(f.backup, 'local-repair.json'))).phase, 'complete');
});
