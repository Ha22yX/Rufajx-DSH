import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const POLICY = 'pure-initialization-v3';
const TYPES = ['permission/preset', 'sandbox/mode', 'approval/policy', 'agent-preset/selected', 'working-directory/change', 'model/selection', 'session/end-seed', 'command/run', 'command/done'];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const epoch = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const targetIdValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const commandIdValid = (value: unknown) => typeof value === 'string' && /^cmd-[A-Za-z0-9-]{1,124}$/.test(value);

/** Unknown header fields and all fork/subagent lineage are retained, never inferred to be blank. */
function initializationHeader(raw: string, id: string): boolean {
  const header: unknown = JSON.parse(raw);
  return object(header) && keys(header, ['version', 'id', 'createdAt', 'cwd', 'isSeeded', 'agentPreset'])
    && header.version === 4 && header.id === id && epoch(header.createdAt) && header.isSeeded === false
    && (header.cwd === undefined || text(header.cwd)) && (header.agentPreset === undefined || text(header.agentPreset, 128));
}

/** Exact configuration envelopes only; command pairing is separately mandatory. */
function initializationEvent(raw: string, seq: number): boolean {
  const event: unknown = JSON.parse(raw);
  if (!object(event) || !keys(event, ['type', 'seq', 'time', 'data']) || event.seq !== seq || !epoch(event.time) || !object(event.data)) return false;
  const data = event.data;
  switch (event.type) {
    case 'command/run': return keys(data, ['commandId', 'name', 'args', 'source']) && commandIdValid(data.commandId)
      && data.name === 'permission' && data.args === ' auto' && object(data.source)
      && keys(data.source, ['kind']) && data.source.kind === 'user';
    case 'command/done': return keys(data, ['commandId', 'kind', 'text']) && commandIdValid(data.commandId)
      && data.kind === 'success' && data.text === 'preset auto';
    // Only the exact empty restore marker carries no content. Inherited markers
    // and unknown extensions remain protected, together with the header checks.
    case 'session/end-seed': return Object.keys(data).length === 0;
    case 'permission/preset': return keys(data, ['preset']) && typeof data.preset === 'string' && ['auto', 'workspace-write', 'danger-full-access'].includes(data.preset);
    case 'sandbox/mode': return keys(data, ['mode']) && typeof data.mode === 'string' && ['read-only', 'workspace-write', 'danger-full-access'].includes(data.mode);
    case 'approval/policy': return keys(data, ['policy']) && typeof data.policy === 'string' && ['ask', 'never'].includes(data.policy);
    case 'agent-preset/selected': return keys(data, ['agentPreset']) && text(data.agentPreset, 128);
    case 'working-directory/change': return keys(data, ['cwd']) && text(data.cwd);
    case 'model/selection': return keys(data, ['provider', 'model', 'reasoningEffort']) && text(data.provider, 128) && text(data.model, 256)
      && (data.reasoningEffort === undefined || text(data.reasoningEffort, 64));
    default: return false;
  }
}

export interface BlankCandidate { id: string; fingerprint: string; eventCount: number; classification: 'pure-initialization' | 'permission-auto-configuration' }
export interface BlankCleanupPlan {
  version: 1; policy: typeof POLICY; planId: string; createdAt: string; cutoff: string;
  targetId?: string;
  source: { path: string; device: string; inode: string };
  summary: { totalSessions: number; candidateSessions: number; candidateEvents: number; retained: Record<string, number> };
  candidates: BlankCandidate[];
}
export interface BlankCleanupResult {
  planId: string; plannedSessions: number; deletedSessions: number; deletedEvents: number; skipped: Record<string, number>;
}
const count = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
function sourceOf(path: string) {
  if (path === ':memory:' || path.startsWith('\\\\')) throw new Error('LOCAL_EXISTING_DATABASE_REQUIRED');
  const canonical = realpathSync(path), stat = statSync(canonical);
  if (!stat.isFile()) throw new Error('LOCAL_EXISTING_DATABASE_REQUIRED');
  return { path: canonical, device: String(stat.dev), inode: String(stat.ino) };
}
function open(path: string, readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly, enableForeignKeyConstraints: true, allowExtension: false });
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (![3, 4].includes(Number(db.prepare('PRAGMA user_version').get()!.user_version))) throw new Error('SCHEMA_VERSION_3_OR_4_REQUIRED');
    db.function('rufa_cleanup_header', { deterministic: true }, (raw, id) => {
      try { return typeof raw === 'string' && typeof id === 'string' && initializationHeader(raw, id) ? 1 : 0; } catch { return 0; }
    });
    db.function('rufa_cleanup_initialization', { deterministic: true }, (raw, seq) => {
      try { return typeof raw === 'string' && typeof seq === 'number' && initializationEvent(raw, seq) ? 1 : 0; } catch { return 0; }
    });
    db.function('rufa_cleanup_sha', { deterministic: true }, value => sha(String(value)));
    return db;
  } catch (error) { db.close(); throw error; }
}

type Metadata = { id: string; owner_status: string; default_title: number; valid_header: number; inherited: number;
  created_at: string; updated_at: string; next_seq: number; lease_id: string | null; lease_login_id: string | null;
  lease_expires_at: string | null; referenced: number; event_count: number; first_seq: number | null; last_seq: number | null; non_initialization: number;
  command_runs: number; command_dones: number; permission_pair: number };
// SQL inspects types/shape; no messages, titles, file contents, credentials, or profile values are returned.
const metadataSql = `SELECT s.id,u.status AS owner_status,s.title='新会话' AS default_title,
 rufa_cleanup_header(s.upstream_header,s.id) AS valid_header,s.inherited_event_count AS inherited,
 s.created_at,s.updated_at,s.next_seq,s.lease_id,s.lease_login_id,s.lease_expires_at,
 EXISTS(SELECT 1 FROM rufa_sessions child WHERE json_extract(child.upstream_header,'$.parentSession')=s.id) AS referenced,
 (SELECT count(*) FROM rufa_session_events e WHERE e.session_id=s.id) AS event_count,
 (SELECT min(seq) FROM rufa_session_events e WHERE e.session_id=s.id) AS first_seq,
 (SELECT max(seq) FROM rufa_session_events e WHERE e.session_id=s.id) AS last_seq,
 EXISTS(SELECT 1 FROM rufa_session_events e WHERE e.session_id=s.id AND
   CASE WHEN json_extract(e.event,'$.type') IN (${TYPES.map(type => `'${type}'`).join(',')})
   THEN rufa_cleanup_initialization(e.event,e.seq) ELSE 0 END <> 1) AS non_initialization,
 (SELECT count(*) FROM rufa_session_events e WHERE e.session_id=s.id AND json_extract(e.event,'$.type')='command/run') AS command_runs,
 (SELECT count(*) FROM rufa_session_events e WHERE e.session_id=s.id AND json_extract(e.event,'$.type')='command/done') AS command_dones,
 EXISTS(SELECT 1 FROM rufa_session_events run JOIN rufa_session_events done ON done.session_id=run.session_id
   AND json_extract(done.event,'$.data.commandId')=json_extract(run.event,'$.data.commandId')
   WHERE run.session_id=s.id AND json_extract(run.event,'$.type')='command/run'
   AND json_extract(done.event,'$.type')='command/done' AND run.seq<done.seq
   AND EXISTS(SELECT 1 FROM rufa_session_events preset WHERE preset.session_id=s.id
     AND preset.seq>run.seq AND preset.seq<done.seq AND json_extract(preset.event,'$.type')='permission/preset'
     AND json_extract(preset.event,'$.data.preset')='auto')) AS permission_pair
 FROM rufa_sessions s JOIN rufa_users u ON u.id=s.owner_id`;

function reason(row: Metadata, now: string, cutoff: string): string | undefined {
  if (row.owner_status === 'deleted') return 'archived_account';
  if (!row.default_title) return 'custom_title';
  if (!row.valid_header || row.inherited !== 0) return 'unknown_or_lineage_header';
  if (row.referenced) return 'referenced_parent';
  if (!timestamp(row.created_at) || !timestamp(row.updated_at)) return 'invalid_metadata';
  if (row.updated_at > cutoff || row.created_at > cutoff) return 'recent';
  if (row.lease_id || row.lease_login_id || row.lease_expires_at) {
    if (!row.lease_id || !row.lease_login_id || !timestamp(row.lease_expires_at)) return 'invalid_lease';
    if (row.lease_expires_at > now) return 'active_lease';
  }
  if (row.next_seq !== row.event_count || (row.event_count > 0 && (row.first_seq !== 0 || row.last_seq !== row.event_count - 1))) return 'sequence_mismatch';
  if (row.non_initialization) return 'content_or_unknown_event';
  // This migration exception is one exact permission-auto invocation, not a
  // general rule that commands (or even repeated configuration commands) are blank.
  if ((row.command_runs || row.command_dones) && (row.command_runs !== 1 || row.command_dones !== 1 || !row.permission_pair)) return 'unpaired_configuration_command';
  return undefined;
}
function candidate(db: DatabaseSync, row: Metadata): BlankCandidate {
  // Only already-classified initialization records are hashed. The plan stores opaque hashes, not values.
  const session = db.prepare(`SELECT rufa_cleanup_sha(json_object('id',id,'owner',owner_id,'title',title,
    'workspace',workspace_ref,'header',upstream_header,'inherited',inherited_event_count,'next',next_seq,
    'created',created_at,'updated',updated_at,'lease',lease_id,'login',lease_login_id,'expires',lease_expires_at)) AS hash
    FROM rufa_sessions WHERE id=?`).get(row.id)!;
  const events = db.prepare('SELECT seq,digest,rufa_cleanup_sha(event) AS hash FROM rufa_session_events WHERE session_id=? ORDER BY seq').all(row.id);
  return { id: row.id, eventCount: row.event_count, fingerprint: sha(JSON.stringify([session.hash, events])),
    classification: row.command_runs ? 'permission-auto-configuration' : 'pure-initialization' };
}
function inspect(db: DatabaseSync, now: string, cutoff: string, targetId?: string) {
  const retained: Record<string, number> = {}, candidates: BlankCandidate[] = [];
  const query = db.prepare(`${metadataSql}${targetId === undefined ? '' : ' WHERE s.id=?'} ORDER BY s.id`);
  const rows = (targetId === undefined ? query.all() : query.all(targetId)) as unknown as Metadata[];
  for (const row of rows) {
    const why = reason(row, now, cutoff);
    if (why) count(retained, why); else candidates.push(candidate(db, row));
  }
  return { summary: { totalSessions: rows.length, candidateSessions: candidates.length, candidateEvents: candidates.reduce((sum, item) => sum + item.eventCount, 0), retained }, candidates };
}
export function dryRunBlankSessions(path: string, options: { now?: () => number; minimumAgeMs?: number; targetId?: string } = {}): BlankCleanupPlan {
  if (options.targetId !== undefined && !targetIdValid(options.targetId)) throw new Error('INVALID_TARGET_ID');
  const time = (options.now ?? Date.now)(), minimumAgeMs = options.minimumAgeMs ?? 600_000;
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0 || !epoch(time) || time < minimumAgeMs) throw new Error('INVALID_TIME');
  const now = new Date(time).toISOString(), cutoff = new Date(time - minimumAgeMs).toISOString();
  const source = sourceOf(path), db = open(source.path, true);
  try {
    db.exec('BEGIN');
    const inspected = inspect(db, now, cutoff, options.targetId);
    db.exec('COMMIT');
    return { version: 1, policy: POLICY, planId: randomUUID(), createdAt: now, cutoff, source,
      ...(options.targetId === undefined ? {} : { targetId: options.targetId }), ...inspected };
  } finally { db.close(); }
}
function validatePlan(value: unknown): asserts value is BlankCleanupPlan {
  if (!object(value) || value.version !== 1 || value.policy !== POLICY || typeof value.planId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(value.planId) || !timestamp(value.createdAt) || !timestamp(value.cutoff) || value.cutoff > value.createdAt
    || !object(value.source) || !text(value.source.path) || !text(value.source.device) || !text(value.source.inode)
    || !Array.isArray(value.candidates) || value.candidates.length > 100_000
    || (value.targetId !== undefined && !targetIdValid(value.targetId))) throw new Error('INVALID_PLAN');
  const ids = new Set<string>();
  for (const entry of value.candidates) {
    if (!object(entry) || !text(entry.id, 128) || typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(entry.fingerprint)
      || !Number.isSafeInteger(entry.eventCount) || Number(entry.eventCount) < 0 || ids.has(entry.id)
      || !['pure-initialization', 'permission-auto-configuration'].includes(String(entry.classification))
      || (value.targetId !== undefined && entry.id !== value.targetId)) throw new Error('INVALID_PLAN');
    ids.add(entry.id);
  }
}

/** Backup first, then reclassify each reviewed candidate under one SQLite write transaction. */
export async function cleanupBlankSessions(path: string, planValue: unknown, backupPath: string, options: { now?: () => number } = {}): Promise<BlankCleanupResult> {
  validatePlan(planValue); const plan = planValue;
  const source = sourceOf(path);
  if (JSON.stringify(source) !== JSON.stringify(plan.source)) throw new Error('PLAN_DATABASE_MISMATCH');
  const destination = resolve(backupPath);
  if (backupPath.startsWith('\\\\') || destination === source.path || ['-wal', '-shm', '-journal'].some(suffix => destination === source.path + suffix) || existsSync(destination)) throw new Error('NEW_BACKUP_PATH_REQUIRED');
  const db = open(source.path, false);
  let saved: DatabaseSync | undefined;
  try {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const reserved = openSync(destination, 'wx', 0o600); closeSync(reserved);
    await backup(db, destination); chmodSync(destination, 0o600);
    saved = open(destination, true);
    if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' || saved.prepare('PRAGMA foreign_key_check').all().length) throw new Error('BACKUP_VERIFICATION_FAILED');
    const savedCandidates = new Map(inspect(saved, plan.createdAt, plan.cutoff, plan.targetId).candidates.map(row => [row.id, row]));
    db.exec('BEGIN IMMEDIATE');
    try {
      // The clock is read after lock acquisition; an old plan never expands its candidate set.
      const time = (options.now ?? Date.now)(); if (!epoch(time)) throw new Error('INVALID_TIME');
      const now = new Date(time).toISOString(); if (now < plan.createdAt) throw new Error('INVALID_TIME');
      const result: BlankCleanupResult = { planId: plan.planId, plannedSessions: plan.candidates.length, deletedSessions: 0, deletedEvents: 0, skipped: {} };
      for (const expected of plan.candidates) {
        const row = db.prepare(`${metadataSql} WHERE s.id=?`).get(expected.id) as Metadata | undefined;
        if (!row) { count(result.skipped, 'missing'); continue; }
        const why = reason(row, now, plan.cutoff);
        if (why) { count(result.skipped, why); continue; }
        const actual = candidate(db, row), archived = savedCandidates.get(expected.id);
        if (actual.fingerprint !== expected.fingerprint || actual.eventCount !== expected.eventCount || actual.classification !== expected.classification) { count(result.skipped, 'changed_since_plan'); continue; }
        if (!archived || archived.fingerprint !== actual.fingerprint) { count(result.skipped, 'not_in_backup'); continue; }
        db.prepare('INSERT INTO rufa_audit(id,actor_id,action,target_id,request_id,created_at) VALUES(?,NULL,?,?,?,?)')
          .run(randomUUID(), 'system.session.purge-empty', expected.id, plan.planId, now);
        const deletedEvents = Number(db.prepare('DELETE FROM rufa_session_events WHERE session_id=?').run(expected.id).changes);
        const deleted = Number(db.prepare('DELETE FROM rufa_sessions WHERE id=?').run(expected.id).changes);
        if (deleted !== 1 || deletedEvents !== expected.eventCount) throw new Error('DELETE_COUNT_MISMATCH');
        result.deletedSessions++; result.deletedEvents += deletedEvents;
      }
      db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { saved?.close(); db.close(); }
}
