import { sessionAccess } from './session-access.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { cleanupBlankSessions, dryRunBlankSessions } from '../src/blank-session-cleanup.js';
import { eventDigest } from '../src/security.js';
import { SqliteStore } from '../src/sqlite-store.js';

const execute = promisify(execFile);
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rufa-blank-cleanup-'));
  const path = join(directory, 'company.sqlite'), store = new SqliteStore(path);
  t.after(async () => {
    await store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('rufa-blank-cleanup-'));
    await rm(directory, { recursive: true, force: true });
  });
  const now = Date.now(), oldTime = now - 3_600_000, old = new Date(oldTime).toISOString();
  const owner = await store.createUser({ username: 'blank-owner', displayName: 'fixture profile', role: 'employee', passwordHash: 'fixture-password-hash' });
  const login = { id: randomUUID(), userId: owner.id, deviceId: randomUUID(), deviceLabel: 'fixture device', accessHash: 'fixture-access-hash', refreshHash: 'fixture-refresh-hash',
    accessExpiresAt: new Date(now + 60_000).toISOString(), refreshExpiresAt: new Date(now + 600_000).toISOString(), revokedAt: null, createdAt: old };
  await store.createLogin(login, owner.passwordHash);
  const event = (type: string, data: unknown, seq = 0) => ({ type, data, seq, time: oldTime });
  const create = async (id: string, events: unknown[] = [], overrides: Record<string, unknown> = {}, ownerId = owner.id) => {
    const header = { version: 4, id, createdAt: oldTime, isSeeded: false, cwd: '/fixture/workspace', ...overrides };
    await store.createSession(ownerId, { id, upstreamHeader: header });
    events.forEach((value, seq) => store.db.prepare('INSERT INTO rufa_session_events(session_id,seq,event,digest) VALUES(?,?,?,?)').run(id, seq, JSON.stringify(value), eventDigest(value)));
    store.db.prepare('UPDATE rufa_sessions SET created_at=?,updated_at=?,next_seq=? WHERE id=?').run(old, old, events.length, id);
  };
  const plan = () => dryRunBlankSessions(path, { now: () => now });
  const apply = (value: unknown, name = 'before.sqlite') => cleanupBlankSessions(path, value, join(directory, name), { now: () => now });
  return { directory, path, store, now, oldTime, old, owner, login, event, create, plan, apply };
}

test('SQLite blank cleanup removes only strict initialization records, retains messages/files/archives, and stores opaque audit', async t => {
  const f = await fixture(t);
  await f.create('blank-zero');
  const initial = [
    f.event('agent-preset/selected', { agentPreset: 'standard' }, 0),
    f.event('permission/preset', { preset: 'auto' }, 1),
    f.event('sandbox/mode', { mode: 'danger-full-access' }, 2),
    f.event('approval/policy', { policy: 'ask' }, 3),
    f.event('working-directory/change', { cwd: '/fixture/workspace' }, 4),
    f.event('model/selection', { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'medium' }, 5),
  ];
  await f.create('blank-initialization', initial);
  const kept: string[] = [];
  for (const type of ['user/message', 'assistant/message', 'system/message', 'developer/message', 'turn/start', 'step/start', 'tool/call', 'tool/result', 'request/header', 'image/offload', 'deliverables/presented', 'session/title', 'session/end-seed', 'job/registered', 'job/settled', 'unknown/future']) {
    const id = `keep-${type.replace('/', '-')}`; kept.push(id);
    await f.create(id, [f.event(type, type === 'session/end-seed' ? { inherited: true } : { content: [{ type: 'text', text: 'private-message-sentinel' }], attachment: 'private-attachment-sentinel' })]);
  }
  const deletedOwner = await f.store.createUser({ username: 'archived-owner', displayName: 'archived fixture', role: 'employee', passwordHash: 'archive-fixture-hash' });
  await f.create('keep-account-archive', [], {}, deletedOwner.id); kept.push('keep-account-archive');
  await f.store.updateUser(deletedOwner.id, { status: 'deleted' });
  await f.store.saveFile({ id: 'preserved-file', ownerId: f.owner.id, metadata: { name: 'private-attachment-sentinel' }, createdAt: f.old, deletedAt: null }, Buffer.from('private-file-sentinel'));
  const beforeAudits = Number(f.store.db.prepare('SELECT count(*) AS n FROM rufa_audit').get()!.n);
  const plan = f.plan();
  assert.deepEqual(plan.candidates.map(row => row.id), ['blank-initialization', 'blank-zero']);
  for (const secret of ['private-message-sentinel', 'private-attachment-sentinel', 'private-file-sentinel', f.owner.passwordHash, f.login.accessHash, '/fixture/workspace']) assert.ok(!JSON.stringify(plan).includes(secret));
  assert.equal(Number(f.store.db.prepare('SELECT count(*) AS n FROM rufa_audit').get()!.n), beforeAudits);
  const result = await f.apply(plan);
  assert.equal(result.deletedSessions, 2); assert.equal(result.deletedEvents, 6);
  for (const id of kept) assert.ok(await f.store.getSession(id));
  assert.equal((await f.store.getFile('preserved-file'))!.ownerId, f.owner.id);
  assert.equal(Buffer.from(f.store.db.prepare('SELECT contents FROM rufa_upstream_files WHERE id=?').get('preserved-file')!.contents as Uint8Array).toString(), 'private-file-sentinel');
  const audit = f.store.db.prepare("SELECT actor_id,action,target_id,request_id FROM rufa_audit WHERE action='system.session.purge-empty' ORDER BY target_id").all();
  assert.deepEqual(audit.map(row => ({ ...row })), ['blank-initialization', 'blank-zero'].map(id => ({ actor_id: null, action: 'system.session.purge-empty', target_id: id, request_id: plan.planId })));
  const saved = new DatabaseSync(join(f.directory, 'before.sqlite'), { readOnly: true });
  try {
    assert.equal(saved.prepare("SELECT count(*) AS n FROM rufa_sessions WHERE id IN ('blank-initialization','blank-zero')").get()!.n, 2);
    assert.equal(saved.prepare("SELECT count(*) AS n FROM rufa_session_events WHERE session_id='blank-initialization'").get()!.n, 6);
    assert.equal(saved.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { saved.close(); }
});

test('SQLite blank cleanup retains custom titles, invalid or extended payloads, lineage, sequence gaps and active leases', async t => {
  const f = await fixture(t);
  for (const [id, header] of Object.entries({ 'old-format': { version: 3 }, fork: { parentSession: 'parent' }, seeded: { isSeeded: true }, child: { origin: 'subagent' }, depth: { delegationDepth: 1 }, extension: { attachments: ['file'] } })) await f.create(id, [], header);
  await f.create('parent');
  await f.create('custom'); f.store.db.prepare('UPDATE rufa_sessions SET title=? WHERE id=?').run('private-custom-title', 'custom');
  await f.create('inherited'); f.store.db.prepare('UPDATE rufa_sessions SET inherited_event_count=1 WHERE id=?').run('inherited');
  await f.create('missing-header'); f.store.db.prepare('UPDATE rufa_sessions SET upstream_header=NULL WHERE id=?').run('missing-header');
  await f.create('gap', [f.event('permission/preset', { preset: 'auto' }, 2)]); f.store.db.prepare('UPDATE rufa_session_events SET seq=2 WHERE session_id=?').run('gap');
  await f.create('wrong-next'); f.store.db.prepare('UPDATE rufa_sessions SET next_seq=2 WHERE id=?').run('wrong-next');
  await f.create('extra-data', [f.event('permission/preset', { preset: 'auto', attachments: ['file'] })]);
  await f.create('coerced-data', [f.event('permission/preset', { preset: ['auto'] })]);
  await f.create('extra-envelope', [{ ...f.event('approval/policy', { policy: 'ask' }), message: 'private-message-sentinel' }]);
  await f.create('delegation-policy', [f.event('approval/policy', { policy: 'never', source: 'delegation' })]);
  await f.create('active');
  await f.store.acquireLease('active', sessionAccess(f.login, new Date(f.now).toISOString()), 120_000);
  await f.create('invalid-lease'); f.store.db.prepare('UPDATE rufa_sessions SET lease_id=? WHERE id=?').run(randomUUID(), 'invalid-lease');
  await f.create('recent'); f.store.db.prepare('UPDATE rufa_sessions SET updated_at=? WHERE id=?').run(new Date(f.now).toISOString(), 'recent');
  await f.create('expired'); await f.store.acquireLease('expired', sessionAccess(f.login, f.old), f.now - 1 - f.oldTime);
  const plan = f.plan(); assert.deepEqual(plan.candidates.map(row => row.id), ['expired']);
  assert.equal(plan.summary.retained.active_lease, 1); assert.equal(plan.summary.retained.referenced_parent, 1);
  assert.equal(plan.summary.retained.custom_title, 1); assert.equal(plan.summary.retained.recent, 1);
  assert.equal((await f.apply(plan)).deletedSessions, 1);
});

test('SQLite cleanup rechecks reviewed records after new content, leases, lineage or configuration changes and never adds candidates', async t => {
  const f = await fixture(t);
  for (const id of ['content', 'lease', 'config', 'parent', 'unchanged']) await f.create(id);
  const plan = f.plan();
  // A separate database connection represents writes arriving after the dry-run snapshot.
  const other = new SqliteStore(f.path);
  try {
    const lease = await other.acquireLease('content', sessionAccess(f.login, f.old), f.now + 120_000 - f.oldTime);
    await other.appendEvents('content', sessionAccess(f.login, f.old), lease.leaseId, 0, [{ seq: 0, event: f.event('user/message', { text: 'late-private-message' }) }]);
    await other.releaseLease('content', sessionAccess(f.login, f.old), lease.leaseId);
    await other.acquireLease('lease', sessionAccess(f.login, f.old), f.now + 120_000 - f.oldTime);
    other.db.prepare('UPDATE rufa_sessions SET workspace_ref=? WHERE id=?').run('/new-workspace', 'config');
  } finally { await other.close(); }
  await f.create('new-child', [], { parentSession: 'parent' });
  await f.create('new-blank');
  const result = await f.apply(plan);
  assert.equal(result.deletedSessions, 1);
  assert.deepEqual(result.skipped, { changed_since_plan: 1, content_or_unknown_event: 1, active_lease: 1, referenced_parent: 1 });
  for (const id of ['content', 'lease', 'config', 'parent', 'new-child', 'new-blank']) assert.ok(await f.store.getSession(id));
  assert.equal(await f.store.getSession('unchanged'), undefined);
});

test('SQLite cleanup audit failure rolls back all deletes while retaining the consistent backup', async t => {
  const f = await fixture(t); await f.create('a-first'); await f.create('z-fail', [f.event('approval/policy', { policy: 'ask' })]);
  const plan = f.plan();
  f.store.db.exec("CREATE TRIGGER reject_empty_cleanup BEFORE INSERT ON rufa_audit WHEN NEW.action='system.session.purge-empty' AND NEW.target_id='z-fail' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  await assert.rejects(f.apply(plan));
  assert.ok(await f.store.getSession('a-first')); assert.ok(await f.store.getSession('z-fail'));
  assert.equal((await f.store.readEvents('z-fail', -1, 5)).length, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM rufa_audit WHERE action='system.session.purge-empty'").get()!.n, 0);
  assert.ok((await readFile(join(f.directory, 'before.sqlite'))).length > 0);
  f.store.db.exec('DROP TRIGGER reject_empty_cleanup');
  assert.equal((await f.apply(plan, 'retry.sqlite')).deletedSessions, 2);
  const repeated = await f.apply(plan, 'repeated.sqlite');
  assert.equal(repeated.deletedSessions, 0); assert.equal(repeated.skipped.missing, 2);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM rufa_audit WHERE action='system.session.purge-empty'").get()!.n, 2);
});

test('SQLite cleanup refuses reused backup paths, wrong database plans and malformed plans without deleting', async t => {
  const f = await fixture(t); await f.create('retained'); const plan = f.plan();
  await writeFile(join(f.directory, 'existing.sqlite'), 'do-not-overwrite');
  await assert.rejects(f.apply(plan, 'existing.sqlite'), /NEW_BACKUP_PATH_REQUIRED/);
  assert.equal(await readFile(join(f.directory, 'existing.sqlite'), 'utf8'), 'do-not-overwrite');
  await assert.rejects(cleanupBlankSessions(f.path, plan, f.path), /NEW_BACKUP_PATH_REQUIRED/);
  await assert.rejects(f.apply({ ...plan, source: { ...plan.source, inode: 'wrong' } }), /PLAN_DATABASE_MISMATCH/);
  await assert.rejects(f.apply({ ...plan, candidates: [...plan.candidates, ...plan.candidates] }), /INVALID_PLAN/);
  await assert.rejects(f.apply({ ...plan, candidates: [{ ...plan.candidates[0], fingerprint: 'not-a-hash' }] }), /INVALID_PLAN/);
  await assert.rejects(f.apply({ ...plan, policy: 'pure-initialization-v1' }), /INVALID_PLAN/);
  assert.ok(await f.store.getSession('retained'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM rufa_audit').get()!.n, 0);
});

test('SQLite dry-run opens read-only, never initializes or migrates unsupported databases', async t => {
  const f = await fixture(t); await f.create('preserved');
  f.store.db.exec('PRAGMA user_version=2');
  assert.throws(() => f.plan(), /SCHEMA_VERSION_3_OR_4_REQUIRED/);
  assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version, 2);
  assert.throws(() => dryRunBlankSessions(join(f.directory, 'missing.sqlite')));
  await assert.rejects(readFile(join(f.directory, 'missing.sqlite')), { code: 'ENOENT' });
});

test('SQLite v2 cleanup admits exact empty restore markers and retains inherited, extended, malformed and content-bearing variants', async t => {
  const f = await fixture(t);
  await f.create('blank-marker', [f.event('session/end-seed', {})]);
  await f.create('blank-mixed-markers', [f.event('permission/preset', { preset: 'auto' }), f.event('session/end-seed', {}, 1), f.event('session/end-seed', {}, 2)]);
  const kept: string[] = [];
  for (const [label, data] of Object.entries({ inherited: { inherited: true }, false: { inherited: false }, extension: { extra: true }, text: { text: 'private-marker-sentinel' }, array: [], null: null, string: '', number: 0, missing: undefined })) {
    const id = `keep-marker-${label}`; kept.push(id);
    await f.create(id, [f.event('session/end-seed', data)]);
  }
  for (const [label, extra] of Object.entries({ ignorable: { ignorable: true }, surface: { surfaceOp: 'append' }, sources: { sourceEventSeqs: [] }, time: { time: null } })) {
    const id = `keep-envelope-${label}`; kept.push(id);
    await f.create(id, [{ ...f.event('session/end-seed', {}), ...extra }]);
  }
  for (const type of ['user/message', 'request/header', 'job/registered', 'job/settled']) {
    const id = `keep-mixed-${type.replace('/', '-')}`; kept.push(id);
    await f.create(id, [f.event('session/end-seed', {}), f.event(type, {}, 1)]);
  }
  const plan = f.plan();
  assert.equal(plan.policy, 'pure-initialization-v3');
  assert.deepEqual(plan.candidates.map(row => row.id), ['blank-marker', 'blank-mixed-markers']);
  assert.equal(plan.summary.candidateEvents, 4);
  assert.ok(!JSON.stringify(plan).includes('private-marker-sentinel'));
  const result = await f.apply(plan);
  assert.equal(result.deletedSessions, 2); assert.equal(result.deletedEvents, 4);
  for (const id of kept) assert.ok(await f.store.getSession(id));
  const saved = new DatabaseSync(join(f.directory, 'before.sqlite'), { readOnly: true });
  try {
    const marker = saved.prepare('SELECT event FROM rufa_session_events WHERE session_id=?').get('blank-marker')!;
    assert.deepEqual(JSON.parse(String(marker.event)), f.event('session/end-seed', {}));
  } finally { saved.close(); }
});

test('SQLite empty restore markers keep lineage, references and lease protections even with zero minimum age', async t => {
  const f = await fixture(t);
  const marker = [f.event('session/end-seed', {})];
  for (const [id, header] of Object.entries({ seeded: { isSeeded: true }, child: { parentSession: 'parent' }, origin: { origin: 'subagent' }, unknown: { attachment: 'file' } })) await f.create(id, marker, header);
  await f.create('parent', marker);
  await f.create('inherited', marker); f.store.db.prepare('UPDATE rufa_sessions SET inherited_event_count=1 WHERE id=?').run('inherited');
  await f.create('active', marker);
  await f.store.acquireLease('active', sessionAccess(f.login, new Date(f.now).toISOString()), 120_000);
  await f.create('invalid-lease', marker); f.store.db.prepare('UPDATE rufa_sessions SET lease_id=? WHERE id=?').run(randomUUID(), 'invalid-lease');
  await f.create('recent', marker); f.store.db.prepare('UPDATE rufa_sessions SET created_at=?,updated_at=? WHERE id=?').run(new Date(f.now).toISOString(), new Date(f.now).toISOString(), 'recent');
  assert.equal(f.plan().candidates.length, 0);
  const plan = dryRunBlankSessions(f.path, { now: () => f.now, minimumAgeMs: 0 });
  assert.deepEqual(plan.candidates.map(row => row.id), ['recent']);
  assert.equal(plan.summary.retained.active_lease, 1);
  assert.equal(plan.summary.retained.invalid_lease, 1);
  assert.equal(plan.summary.retained.referenced_parent, 1);
  assert.equal((await f.apply(plan)).deletedSessions, 1);
  for (const id of ['seeded', 'child', 'origin', 'unknown', 'parent', 'inherited', 'active', 'invalid-lease']) assert.ok(await f.store.getSession(id));
});

test('SQLite v2 cleanup rechecks marker changes and new content after the reviewed plan', async t => {
  const f = await fixture(t);
  for (const id of ['marker-inherited', 'marker-content', 'marker-time', 'marker-unchanged']) await f.create(id, [f.event('session/end-seed', {})]);
  const plan = f.plan();
  const other = new SqliteStore(f.path);
  try {
    for (const [id, changed] of [['marker-inherited', f.event('session/end-seed', { inherited: true })], ['marker-time', { ...f.event('session/end-seed', {}), time: f.oldTime + 1 }]] as const) {
      other.db.prepare('UPDATE rufa_session_events SET event=?,digest=? WHERE session_id=? AND seq=0').run(JSON.stringify(changed), eventDigest(changed), id);
    }
    const message = f.event('user/message', { text: 'post-plan-private-message' }, 1);
    other.db.prepare('INSERT INTO rufa_session_events(session_id,seq,event,digest) VALUES(?,?,?,?)').run('marker-content', 1, JSON.stringify(message), eventDigest(message));
    other.db.prepare('UPDATE rufa_sessions SET next_seq=2 WHERE id=?').run('marker-content');
  } finally { await other.close(); }
  const result = await f.apply(plan);
  assert.equal(result.deletedSessions, 1); assert.equal(result.deletedEvents, 1);
  assert.deepEqual(result.skipped, { content_or_unknown_event: 2, changed_since_plan: 1 });
  for (const id of ['marker-inherited', 'marker-content', 'marker-time']) assert.ok(await f.store.getSession(id));
  assert.equal(await f.store.getSession('marker-unchanged'), undefined);
});

test('standalone cleanup CLI defaults to dry-run, emits counts only, and requires a fresh backup for apply', async t => {
  const f = await fixture(t); await f.create('cli-empty'); await f.create('cli-content', [f.event('user/message', { text: 'cli-private-message-sentinel' })]);
  const cli = fileURLToPath(new URL('../src/blank-session-cleanup-cli.ts', import.meta.url));
  const planPath = join(f.directory, 'reviewed-plan.json'), backupPath = join(f.directory, 'cli-before.sqlite');
  const args = ['--import', 'tsx', cli, '--database', f.path, '--plan', planPath];
  const preview = await execute(process.execPath, args);
  const report = JSON.parse(preview.stdout); assert.equal(report.mode, 'dry-run'); assert.equal(report.candidateSessions, 1);
  assert.ok(await f.store.getSession('cli-empty'));
  assert.ok(!preview.stdout.includes('cli-private-message-sentinel')); assert.ok(!preview.stdout.includes(f.login.accessHash));
  const planText = await readFile(planPath, 'utf8'); assert.ok(!planText.includes('cli-private-message-sentinel'));
  await assert.rejects(execute(process.execPath, args)); // Existing plans are never overwritten.
  assert.equal(await readFile(planPath, 'utf8'), planText);
  await assert.rejects(execute(process.execPath, [...args, '--apply']));
  const applied = await execute(process.execPath, [...args, '--apply', '--backup', backupPath]);
  assert.equal(JSON.parse(applied.stdout).deletedSessions, 1);
  assert.equal(await f.store.getSession('cli-empty'), undefined); assert.ok(await f.store.getSession('cli-content'));
});

test('SQLite v3 recognizes only one exact successful permission-auto pair with a matching configuration event', async t => {
  const f = await fixture(t);
  const run = { commandId: 'cmd-1f2529f9-2', name: 'permission', args: ' auto', source: { kind: 'user' } };
  const done = { commandId: run.commandId, kind: 'success', text: 'preset auto' };
  const pair = () => [f.event('command/run', run), f.event('permission/preset', { preset: 'auto' }, 1),
    f.event('sandbox/mode', { mode: 'danger-full-access' }, 2), f.event('command/done', done, 3)];
  await f.create('exact-config', pair());
  const variants: Record<string, unknown[]> = {};
  for (const [label, data] of Object.entries({ other: { ...run, name: 'goal' }, args: { ...run, args: 'auto' },
    source: { ...run, source: { kind: 'model' } }, extraSource: { ...run, source: { kind: 'user', extra: true } },
    attachment: { ...run, attachments: ['private-attachment'] }, missing: { name: 'permission', args: ' auto', source: { kind: 'user' } } })) {
    variants[`run-${label}`] = [f.event('command/run', data), ...pair().slice(1)];
  }
  for (const [label, data] of Object.entries({ id: { ...done, commandId: 'cmd-other' }, failure: { ...done, kind: 'error' },
    text: { ...done, text: 'private-business-result' }, extra: { ...done, sourceEventSeq: 1 }, missing: { commandId: done.commandId, kind: 'success' } })) {
    variants[`done-${label}`] = [...pair().slice(0, 3), f.event('command/done', data, 3)];
  }
  variants['missing-done'] = pair().slice(0, 3);
  variants['missing-run'] = pair().slice(1).map((value, seq) => ({ ...value, seq }));
  variants['wrong-order'] = [f.event('command/done', done), f.event('permission/preset', { preset: 'auto' }, 1), f.event('command/run', run, 2)];
  variants['no-config'] = [f.event('command/run', run), f.event('command/done', done, 1)];
  variants['wrong-preset'] = [f.event('command/run', run), f.event('permission/preset', { preset: 'workspace-write' }, 1), f.event('command/done', done, 2)];
  variants['envelope-extension'] = [{ ...pair()[0], ignorable: true }, ...pair().slice(1)];
  variants['duplicate-done'] = [...pair(), f.event('command/done', done, 4)];
  variants['repeated-pair'] = [...pair(), ...pair().map(value => ({ ...value, seq: value.seq + 4 }))];
  variants['distinct-pairs'] = [...pair(), ...pair().map(value => ({ ...value, seq: value.seq + 4,
    data: ['command/run', 'command/done'].includes(value.type) ? { ...(value.data as object), commandId: 'cmd-second' } : value.data }))];
  for (const type of ['user/message', 'turn/start', 'tool/result', 'command/unknown']) variants[`mixed-${type}`] = [...pair(), f.event(type, { text: 'private-message' }, 4)];
  for (const [id, events] of Object.entries(variants)) await f.create(id, events);
  const plan = f.plan();
  assert.deepEqual(plan.candidates.map(({ id, classification }) => ({ id, classification })), [{ id: 'exact-config', classification: 'permission-auto-configuration' }]);
  assert.ok(!JSON.stringify(plan).includes('private-'));
  assert.equal((await f.apply(plan)).deletedEvents, 4);
  for (const id of Object.keys(variants)) assert.ok(await f.store.getSession(id), id);
  const saved = new DatabaseSync(join(f.directory, 'before.sqlite'), { readOnly: true });
  try { assert.deepEqual(saved.prepare('SELECT event FROM rufa_session_events WHERE session_id=? ORDER BY seq').all('exact-config').map(row => JSON.parse(String(row.event))), pair()); }
  finally { saved.close(); }
});

test('targeted v3 plans restrict inspection and apply to one reviewed ID and retain other eligible records', async t => {
  const f = await fixture(t);
  await f.create('target'); await f.create('other');
  const plan = dryRunBlankSessions(f.path, { now: () => f.now, targetId: 'target' });
  assert.equal(plan.targetId, 'target'); assert.equal(plan.summary.totalSessions, 1);
  assert.deepEqual(plan.candidates.map(row => row.id), ['target']);
  assert.equal(plan.candidates[0].classification, 'pure-initialization');
  const unscoped = f.plan();
  await assert.rejects(f.apply({ ...plan, candidates: unscoped.candidates }), /INVALID_PLAN/);
  await assert.rejects(f.apply({ ...plan, policy: 'pure-initialization-v2' }), /INVALID_PLAN/);
  await assert.rejects(f.apply({ ...plan, targetId: '' }), /INVALID_PLAN/);
  for (const targetId of ['', '../target', 'one OR 1=1', 'a'.repeat(129)]) assert.throws(() => dryRunBlankSessions(f.path, { targetId }), /INVALID_TARGET_ID/);
  const missing = dryRunBlankSessions(f.path, { now: () => f.now, targetId: 'missing' });
  assert.equal(missing.summary.totalSessions, 0); assert.deepEqual(missing.candidates, []);
  assert.equal((await f.apply(plan)).deletedSessions, 1);
  assert.ok(await f.store.getSession('other')); assert.equal(await f.store.getSession('target'), undefined);
});

test('targeted permission configuration keeps lease and post-plan payload protections', async t => {
  const f = await fixture(t);
  const events = [f.event('command/run', { commandId: 'cmd-one', name: 'permission', args: ' auto', source: { kind: 'user' } }),
    f.event('permission/preset', { preset: 'auto' }, 1), f.event('command/done', { commandId: 'cmd-one', kind: 'success', text: 'preset auto' }, 2)];
  await f.create('target', events); await f.create('untargeted');
  const lease = await f.store.acquireLease('target', sessionAccess(f.login, f.old), f.now + 60_000 - f.oldTime);
  const active = dryRunBlankSessions(f.path, { now: () => f.now, targetId: 'target', minimumAgeMs: 0 });
  assert.equal(active.candidates.length, 0); assert.equal(active.summary.retained.active_lease, 1);
  await f.store.releaseLease('target', sessionAccess(f.login, f.old), lease.leaseId);
  const plan = dryRunBlankSessions(f.path, { now: () => f.now, targetId: 'target' });
  const altered = { ...events[2], data: { commandId: 'cmd-one', kind: 'success', text: 'preset auto', attachment: 'private-extra' } };
  f.store.db.prepare('UPDATE rufa_session_events SET event=?,digest=? WHERE session_id=? AND seq=2').run(JSON.stringify(altered), eventDigest(altered), 'target');
  const result = await f.apply(plan);
  assert.equal(result.deletedSessions, 0); assert.equal(result.skipped.content_or_unknown_event, 1);
  assert.ok(await f.store.getSession('target')); assert.ok(await f.store.getSession('untargeted'));
});

test('standalone v3 target-id CLI binds the plan and refuses rescoping during apply', async t => {
  const f = await fixture(t); await f.create('cli-target'); await f.create('cli-other');
  const cli = fileURLToPath(new URL('../src/blank-session-cleanup-cli.ts', import.meta.url));
  const planPath = join(f.directory, 'target-plan.json'), backupPath = join(f.directory, 'target-before.sqlite');
  const args = ['--import', 'tsx', cli, '--database', f.path, '--plan', planPath];
  const preview = await execute(process.execPath, [...args, '--target-id', 'cli-target']);
  assert.equal(JSON.parse(preview.stdout).candidateSessions, 1); assert.equal(JSON.parse(preview.stdout).totalSessions, 1);
  const plan = JSON.parse(await readFile(planPath, 'utf8')); assert.equal(plan.targetId, 'cli-target');
  assert.deepEqual(plan.candidates.map((row: { id: string }) => row.id), ['cli-target']);
  await assert.rejects(execute(process.execPath, [...args, '--apply', '--backup', backupPath, '--target-id', 'cli-other']));
  assert.ok(await f.store.getSession('cli-target')); assert.ok(await f.store.getSession('cli-other'));
  const applied = await execute(process.execPath, [...args, '--apply', '--backup', backupPath]);
  assert.equal(JSON.parse(applied.stdout).deletedSessions, 1);
  assert.equal(await f.store.getSession('cli-target'), undefined); assert.ok(await f.store.getSession('cli-other'));
});
