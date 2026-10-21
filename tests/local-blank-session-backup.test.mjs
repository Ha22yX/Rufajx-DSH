import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionCache } from '../apps/client/src/runtime/session-cache.mjs';
import { planLocalBlankSessions, backupLocalSessions } from '../scripts/local-blank-session-backup.mjs';

test('blank cleanup plans retain drafts, work, remote records and inconsistent journals, and produce a complete recoverable backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rufa-blank-backup-')), home = join(root, 'account');
  const cache = new SessionCache(home), entries = {};
  const header = id => ({ version: 4, id, createdAt: 1, isSeeded: false, cwd: root });
  const init = { seq: 0, type: 'permission/preset', time: 1, data: { preset: 'auto' } };
  const ids = ['empty', 'empty-journal', 'text', 'attachment', 'remote', 'work', 'unknown', 'journal-work', 'corrupt-count'];
  for (const id of ids) { cache.ensure(header(id)); cache.append(id, [init]); }
  entries['dsh.conversation.text'] = JSON.stringify({ draft: { text: 'Keep my draft', references: [] }, view: 'conversation', viewRequest: null });
  entries['dsh.conversation.attachment'] = JSON.stringify({ draft: { text: '', references: [{ kind: 'file', id: 'attachment' }] }, view: 'conversation', viewRequest: null });
  const content = { seq: 1, time: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'Keep submitted content' }] } };
  cache.append('work', [content]);
  cache.append('unknown', [{ seq: 1, time: 2, type: 'future/custom-event', data: {} }]);
  cache.checkpoint('remote', 1);
  cache.db.prepare('UPDATE sessions SET event_count=2 WHERE id=?').run('corrupt-count');
  cache.close();
  await mkdir(join(home, 'company-pending-events'));
  for (const id of ['empty-journal', 'journal-work']) await writeFile(join(home, 'company-pending-events', `${id}.json`), JSON.stringify({
    id, header: header(id), inheritedEventCount: 0, local: true, uploadRequested: false, nextSeq: 0,
    events: id === 'journal-work' ? [init, content] : [init],
  }));
  await writeFile(join(home, 'browser-ui-state.json'), JSON.stringify({ version: 1, entries }));
  await mkdir(join(home, 'storages')); await writeFile(join(home, 'storages', 'workspace.json'), '{"keep":"project folders"}');
  const plan = await planLocalBlankSessions(home);
  assert.deepEqual(plan.candidates.map(row => row.id), ['empty', 'empty-journal']);
  assert.equal(plan.retained.length, 7);
  const destination = join(root, 'backup');
  const saved = await backupLocalSessions(home, destination);
  assert.deepEqual(saved.fingerprints, plan.fingerprints);
  const db = new DatabaseSync(join(destination, 'company-history.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n, 9); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
  finally { db.close(); }
  assert.equal(await readFile(join(destination, 'browser-ui-state.json'), 'utf8'), await readFile(join(home, 'browser-ui-state.json'), 'utf8'));
  assert.equal(await readFile(join(destination, 'company-pending-events', 'journal-work.json'), 'utf8'), await readFile(join(home, 'company-pending-events', 'journal-work.json'), 'utf8'));
  assert.deepEqual((await planLocalBlankSessions(home)).fingerprints, plan.fingerprints, 'Plan and backup never mutate source histories');
  await assert.rejects(backupLocalSessions(home, destination), /EEXIST/);
});
