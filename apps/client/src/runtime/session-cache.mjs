import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { initializationOnly } from './empty-session-policy.mjs';

// The caller supplies the already isolated company account home, never the
// shared Harness home. Full event JSON includes tool calls/results unchanged.
export class SessionCache {
  constructor(accountHome) {
    mkdirSync(accountHome, { recursive: true, mode: 0o700 });
    this.path = join(accountHome, 'company-history.sqlite');
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); throw new Error('Unsupported company history cache version'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, header TEXT NOT NULL, inherited INTEGER NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0, synced_seq INTEGER NOT NULL DEFAULT 0,
        remote_seq INTEGER NOT NULL DEFAULT 0, cloud_state TEXT NOT NULL,
        ready INTEGER NOT NULL DEFAULT 0, conflict TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL,
        event TEXT NOT NULL, PRIMARY KEY(session_id, seq)
      ) WITHOUT ROWID;
      PRAGMA user_version=1;
    `);
  }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  decode(row) {
    return row && { id: row.id, header: JSON.parse(row.header), inheritedEventCount: row.inherited,
      eventCount: row.event_count, syncedSeq: row.synced_seq, remoteSeq: row.remote_seq,
      cloudState: row.cloud_state, ready: Boolean(row.ready), conflict: row.conflict };
  }
  get(id) { return this.decode(this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id)); }
  list() { return this.db.prepare('SELECT * FROM sessions ORDER BY id').all().map(row => this.decode(row)); }
  ensure(header, inheritedEventCount = 0, cloudState = 'local') {
    const existing = this.get(header.id);
    if (existing) {
      if (!isDeepStrictEqual(existing.header, header) || existing.inheritedEventCount !== inheritedEventCount) {
        throw new Error('Local history metadata differs from session metadata');
      }
      return existing;
    }
    this.db.prepare('INSERT INTO sessions(id,header,inherited,cloud_state,ready) VALUES(?,?,?,?,?)')
      .run(header.id, JSON.stringify(header), inheritedEventCount, cloudState, cloudState === 'local' ? 1 : 0);
    return this.get(header.id);
  }
  observeRemote(summary) {
    return this.transaction(() => {
      this.ensure(summary.upstreamHeader, summary.inheritedEventCount ?? 0, 'remote');
      if (!Number.isSafeInteger(summary.nextSeq) || summary.nextSeq < 0) throw new Error('Invalid cloud history checkpoint');
      this.db.prepare('UPDATE sessions SET remote_seq=? WHERE id=?').run(summary.nextSeq, summary.id);
      return this.get(summary.id);
    });
  }
  append(id, events) {
    return this.transaction(() => {
      const record = this.get(id);
      if (!record) throw new Error('Local history metadata is missing');
      let next = record.eventCount;
      const existing = this.db.prepare('SELECT event FROM events WHERE session_id=? AND seq=?');
      const insert = this.db.prepare('INSERT INTO events(session_id,seq,event) VALUES(?,?,?)');
      for (const event of events) {
        if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq > next) throw new Error('Non-contiguous local history');
        if (event.seq < next) {
          const stored = existing.get(id, event.seq);
          if (!stored || !isDeepStrictEqual(JSON.parse(stored.event), event)) throw new Error('Local history event conflict');
        } else { insert.run(id, event.seq, JSON.stringify(event)); next++; }
      }
      this.db.prepare('UPDATE sessions SET event_count=? WHERE id=?').run(next, id);
      return this.get(id);
    });
  }
  read(id, offset = 0, length = Infinity) {
    if (!Number.isSafeInteger(offset) || offset < 0 || (length !== Infinity && (!Number.isSafeInteger(length) || length < 0))) {
      throw new Error('Invalid local history range');
    }
    return this.db.prepare('SELECT event FROM events WHERE session_id=? AND seq>=? ORDER BY seq LIMIT ?')
      .all(id, offset, length === Infinity ? -1 : length).map(row => JSON.parse(row.event));
  }
  checkpoint(id, nextSeq, ready = true) {
    const record = this.get(id);
    if (!record || !Number.isSafeInteger(nextSeq) || nextSeq < record.syncedSeq || nextSeq > record.eventCount) {
      throw new Error('Invalid local synchronization checkpoint');
    }
    this.db.prepare(`UPDATE sessions SET synced_seq=?,remote_seq=MAX(remote_seq,?),cloud_state='remote',
      ready=MAX(ready,?) WHERE id=?`).run(nextSeq, nextSeq, ready ? 1 : 0, id);
  }
  markLocal(id) {
    this.db.prepare("UPDATE sessions SET synced_seq=0,remote_seq=0,cloud_state='local',ready=1,conflict=NULL WHERE id=?").run(id);
  }
  conflict(id, reason) {
    this.db.prepare("UPDATE sessions SET cloud_state='conflict',conflict=? WHERE id=?").run(reason, id);
  }
  clearVerifiedLegacyConflict(id, expected) {
    return this.transaction(() => {
      const current = this.get(id);
      if (expected.conflict !== 'LIVE_REMOTE_ADVANCED' || !isDeepStrictEqual(current, expected)) {
        throw new Error('Local history changed during verified conflict recovery');
      }
      this.db.prepare("UPDATE sessions SET cloud_state='remote',conflict=NULL WHERE id=? AND conflict='LIVE_REMOTE_ADVANCED'").run(id);
    });
  }
  discardInitialization(id, expectedEventCount) {
    return this.transaction(() => {
      const record = this.get(id);
      if (!record || record.cloudState !== 'local' || record.syncedSeq !== 0 || record.remoteSeq !== 0 || record.conflict
        || record.eventCount !== expectedEventCount || !initializationOnly(record, this.read(id))) return false;
      this.db.prepare('DELETE FROM events WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
      return true;
    });
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
