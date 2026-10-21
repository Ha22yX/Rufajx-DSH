import { importUpstream, companyRequest, bridgeConfig } from './import-upstream.mjs';
import { mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { SessionCache } from './session-cache.mjs';
import { initializationOnly } from './empty-session-policy.mjs';
const persistence = await importUpstream('@deepseek-ai/dsh-session-persistence');
const { SessionPersistence, SessionPersistenceRevision, materializeCreateHeader, materializeAppendBatch, validateStoredEvents, assertVersion,
  SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionHandleClosedError, SessionReadOnlyError, SessionOwnershipLostError, SessionPersistenceNotFoundError } = persistence;
export const name = 'rufa-remote-persistence';
const MAX_BATCH_BYTES = 24 * 1024 * 1024;
const MAX_EVENT_COUNT = 500;

function deepFreeze(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) continue;
    pending.push(...Object.values(item)); Object.freeze(item);
  }
  return value;
}

// Native editor drafts are not session events. Metadata and inherited fork
// history must also stay local until this session admits its own work.
function startsSubmission(event, inheritedEventCount) {
  if (event.seq < inheritedEventCount) return false;
  return event.type === 'turn/start'
    || (event.type === 'user/message' && event.data?.source?.kind !== 'runtime-context')
    || (event.type === 'agent/inbox/spliced' && event.data?.inserted?.length > 0);
}
function localSummary(record) {
  return { id: record.id, upstreamHeader: record.header, inheritedEventCount: record.inheritedEventCount,
    nextSeq: record.events.length, updatedAt: 'local' };
}
function cacheSummary(record) {
  return { id: record.id, upstreamHeader: record.header, inheritedEventCount: record.inheritedEventCount,
    nextSeq: record.eventCount, updatedAt: 'cached' };
}
function checkedHeader(summary) {
  const header = materializeCreateHeader(summary.upstreamHeader);
  if (header.id !== summary.id) throw new Error('Cloud session identity mismatch');
  assertVersion(header);
  if (!Number.isSafeInteger(summary.inheritedEventCount ?? 0) || (summary.inheritedEventCount ?? 0) < 0) throw new Error('Invalid fork inheritance');
  return deepFreeze(header);
}
function snapshot(summary) {
  return { header: checkedHeader(summary), eventCount: summary.nextSeq,
    revision: SessionPersistenceRevision(`${summary.id}:${summary.nextSeq}:${summary.updatedAt}`), formatStatus: 'current' };
}

class RemoteHandle {
  pending = []; closed = false; closing = null; lease = null; lostOwnership = false; failure = null; tail = Promise.resolve(); timer = null;
  uploadRequested = false; needsReconcile = false; localFailure = null; nativeFailure = null;
  constructor(service, summary, access, lease, local = false) {
    this.service = service; this.id = summary.id; this.header = checkedHeader(summary);
    this.inheritedEventCount = summary.inheritedEventCount ?? 0; this.access = access;
    this.nextSeq = local ? 0 : summary.nextSeq; this.lease = lease; this.local = local;
    this.journal = service.journalPath(this.id);
  }
  startHeartbeat() {
    if (!this.heartbeat && !this.closing) {
      this.heartbeat = setInterval(() => {
        this.enqueueOperation(() => this.renew()).catch(error => { this.failure = error; });
      }, 40_000);
      this.heartbeat.unref();
    }
  }
  assertOpen() { if (this.closed) throw new SessionHandleClosedError(this.id, 'access'); }
  assertWrite() {
    this.assertOpen(); if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'write');
    if (this.nativeFailure) throw this.nativeFailure;
    if (this.lostOwnership) throw new SessionOwnershipLostError(this.id);
    if (this.service.cache.get(this.id)?.conflict) throw new Error('会话同步冲突尚未解决，不能继续写入。');
  }
  loseOwnership() { this.lostOwnership = true; clearInterval(this.heartbeat); this.heartbeat = null; throw new SessionOwnershipLostError(this.id); }
  enqueueOperation(operation) {
    const result = this.service.enqueue(this.id, operation);
    this.tail = result.catch(() => {}); // Callers receive the rejection; later flush retries retained events.
    return result;
  }
  async renew() {
    this.assertWrite();
    if (this.local) return;
    if (this.lease && Date.parse(this.lease.expiresAt) <= Date.now()) this.loseOwnership();
    try {
      const result = await companyRequest('POST', `/sessions/${encodeURIComponent(this.id)}/lease`, { deviceId: bridgeConfig().deviceId });
      if (this.lease && result.leaseId !== this.lease.leaseId) this.loseOwnership();
      this.lease = result;
    } catch (error) {
      if ([401, 403, 409].includes(error.status)) this.loseOwnership();
      throw error;
    }
  }
  async recover() {
    let saved;
    try { saved = JSON.parse(await readFile(this.journal, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (saved.id !== this.id || !Array.isArray(saved.events)) throw new Error('Invalid pending session journal');
    if (saved.header && !isDeepStrictEqual(materializeCreateHeader(saved.header), this.header)) throw new Error('Pending session journal header differs from cloud');
    // Ambiguous prior commits are verified against cloud facts, never silently dropped.
    const committed = saved.events.filter(event => event.seq < this.nextSeq);
    if (committed.length) {
      const cloud = await this.fetchEvents(committed[0].seq, committed.length);
      if (!isDeepStrictEqual(cloud, committed)) throw new Error('Pending session journal differs from committed cloud events');
    }
    const pending = saved.events.filter(event => event.seq >= this.nextSeq);
    const overlap = Math.min(pending.length, this.pending.length);
    if (!isDeepStrictEqual(pending.slice(0, overlap), this.pending.slice(0, overlap))) throw new Error('Pending journal differs from local history');
    this.accept(pending.slice(this.pending.length));
  }
  accept(events) {
    const copied = validateStoredEvents(this.header, materializeAppendBatch(events)).map(event => deepFreeze(event));
    let next = this.nextSeq + this.pending.length;
    for (const event of copied) {
      if (event.seq !== next++) throw new Error('Non-contiguous session events refused');
      const bytes = Buffer.byteLength(JSON.stringify({ seq: event.seq, event }));
      if (bytes > MAX_BATCH_BYTES - 1024) throw new Error('单条会话事件超过同步上限，内容尚未保存；请联系管理员。');
    }
    // The native event callback is synchronous. Commit the immutable bytes
    // before returning to its caller, even when another operation owns the
    // network/journal lane. A crash must not erase an already accepted event.
    this.pending.push(...copied);
    if (copied.some(event => startsSubmission(event, this.inheritedEventCount))) this.uploadRequested = true;
    try {
      this.service.cache.ensure(this.header, this.inheritedEventCount, this.local ? 'local' : 'remote');
      this.service.cache.append(this.id, this.localFailure ? this.pending : copied);
      this.localFailure = null;
    } catch (error) {
      // Retain the failed suffix in memory for an explicit durable flush retry;
      // native cleanup events still arrive after observer errors. Keep their
      // contiguous bytes too, but never report an unsuccessful append saved.
      this.localFailure = error; throw error;
    }
  }
  record() {
    return { id: this.id, header: this.header, inheritedEventCount: this.inheritedEventCount,
      local: this.local, uploadRequested: this.uploadRequested, nextSeq: this.nextSeq, events: this.pending.slice() };
  }
  retainCache(record = this.record()) {
    this.service.cache.ensure(this.header, this.inheritedEventCount, record.local ? 'local' : 'remote');
    this.service.cache.append(this.id, record.events);
    if (this.service.cache.get(this.id)?.conflict) return;
    // Local snapshots never reverse a completed promotion. Only the explicit,
    // verified empty-cloud-404 path is allowed to convert remote to local.
    if (!record.local) this.service.cache.checkpoint(this.id, record.nextSeq);
    this.localFailure = null;
  }
  async journalPending() {
    // Cache and journal must describe the same immutable prefix. Native events
    // may arrive during any filesystem await; they belong to the next snapshot.
    const record = this.record();
    this.retainCache(record);
    await mkdir(this.service.journalRoot, { recursive: true, mode: 0o700 });
    const temporary = `${this.journal}.pending`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flush: true });
    await rename(temporary, this.journal);
    return record;
  }
  enqueueLive(event) {
    if (this.closing) throw new SessionHandleClosedError(this.id, 'append');
    this.assertOpen(); if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'write');
    try { this.accept([event]); }
    catch (error) { if (error !== this.localFailure) this.nativeFailure = error; throw error; }
    // Journal writes and network commits share a serial lane.
    this.enqueueOperation(() => this.journalPending()).catch(error => { this.failure = error; });
    if (!this.timer && !this.lostOwnership) {
      this.timer = setTimeout(() => {
        this.timer = null;
        Promise.resolve().then(() => this.flush()).catch(error => { this.failure = error; this.service.ctx.logger.warn('公司会话同步失败；待提交事件已保留，下个保存检查点将重试。'); });
      }, 200);
      this.timer.unref();
    }
  }
  append(events, options) {
    if (this.closing) throw new SessionHandleClosedError(this.id, 'append');
    this.assertWrite(); options?.signal?.throwIfAborted();
    this.accept(events);
    return this.flush(options);
  }
  async drain(signal) {
    this.assertWrite(); signal?.throwIfAborted();
    const durable = await this.journalPending();
    if (this.local) {
      // A new event may arrive during the write. Only a submission already in
      // the durable journal may trigger a remote side effect.
      if (!durable.uploadRequested) { this.failure = null; return; }
      await this.promote(signal);
    }
    if (!this.pending.length && !this.lease) { this.failure = null; return; }
    if (!this.lease || Date.parse(this.lease.expiresAt) < Date.now() + 15_000) await this.renew();
    if (this.needsReconcile) {
      const { session } = await companyRequest('GET', `/sessions/${encodeURIComponent(this.id)}`, undefined, signal);
      await this.reconcileCheckpoint(session.nextSeq, signal);
      this.needsReconcile = false;
    }
    while (this.pending.length) {
      signal?.throwIfAborted();
      // Never upload an event merely because it arrived while the preceding
      // journal or network request was in flight. Retain this exact batch first.
      const batch = await this.journalPending();
      if (Date.parse(this.lease.expiresAt) < Date.now() + 15_000) await this.renew();
      const events = []; let bytes = 1024;
      for (const event of batch.events) {
        const record = { seq: event.seq, event }; const length = Buffer.byteLength(JSON.stringify(record)) + 1;
        if (events.length && (bytes + length > MAX_BATCH_BYTES || events.length >= MAX_EVENT_COUNT)) break;
        events.push(record); bytes += length;
      }
      let result;
      try {
        result = await companyRequest('POST', `/sessions/${encodeURIComponent(this.id)}/events`, {
          leaseId: this.lease.leaseId, expectedNextSeq: this.nextSeq, events,
        }, signal);
      } catch (error) {
        if ([401, 403, 409].includes(error.status)) this.loseOwnership();
        this.needsReconcile = true;
        throw error;
      }
      if (!Number.isSafeInteger(result.nextSeq) || result.nextSeq < this.nextSeq + events.length) {
        this.needsReconcile = true;
        throw new Error('Unexpected cloud event checkpoint');
      }
      if (result.nextSeq !== this.nextSeq + events.length) {
        this.needsReconcile = true;
        await this.reconcileCheckpoint(result.nextSeq, signal);
        this.needsReconcile = false;
      } else { this.pending.splice(0, events.length); this.nextSeq = result.nextSeq; }
      await this.journalPending();
    }
    this.failure = null;
  }
  async reconcileCheckpoint(nextSeq, signal) {
    if (!Number.isSafeInteger(nextSeq) || nextSeq < this.nextSeq || nextSeq > this.nextSeq + this.pending.length) {
      throw new Error('Cloud session checkpoint is outside the retained local history');
    }
    const count = nextSeq - this.nextSeq;
    if (count) {
      const committed = await this.fetchEvents(this.nextSeq, count, signal);
      if (!isDeepStrictEqual(committed, this.pending.slice(0, count))) throw new Error('Pending session journal differs from committed cloud events');
      this.pending.splice(0, count); this.nextSeq = nextSeq;
    }
    await this.journalPending();
  }
  async recoverOwnership(observeNative, signal) {
    this.assertOpen();
    if (this.closing || this.access !== 'write' || this.nativeFailure || this.service.cache.get(this.id)?.conflict) {
      throw this.nativeFailure ?? new Error('当前会话不能安全恢复写入，请重新打开会话后重试。');
    }
    await this.journalPending();
    const expected = this.service.readCached(this.id);
    const checkNative = async () => {
      const native = await observeNative();
      if (!native || !isDeepStrictEqual(native.header, this.header) || !isDeepStrictEqual(native.events, expected.events)
        || native.isCurrent?.() === false || !isDeepStrictEqual(this.service.readCached(this.id).events, expected.events)) {
        throw new Error('会话状态正在变化，尚未恢复写入；请等待当前操作结束后重试。');
      }
      return native.isCurrent;
    };
    await checkNative(); signal?.throwIfAborted();
    const lease = await companyRequest('POST', `/sessions/${encodeURIComponent(this.id)}/lease`, { deviceId: bridgeConfig().deviceId }, signal);
    try {
      const { session } = await companyRequest('GET', `/sessions/${encodeURIComponent(this.id)}`, undefined, signal);
      if (!isDeepStrictEqual(checkedHeader(session), this.header) || (session.inheritedEventCount ?? 0) !== this.inheritedEventCount
        || session.nextSeq !== lease.nextSeq || !Number.isSafeInteger(lease.nextSeq) || lease.nextSeq < expected.syncedSeq) {
        throw new Error('服务器会话状态未能核对，已有记录已保留。');
      }
      if (lease.nextSeq > expected.eventCount) throw new Error('此会话已在其他设备新增内容，请重新打开客户端后继续，当前记录已保留。');
      const committed = await this.fetchEvents(0, lease.nextSeq, signal);
      if (!isDeepStrictEqual(committed, expected.events.slice(0, lease.nextSeq))) {
        this.service.cache.conflict(this.id, 'EVENT_CONFLICT');
        throw new Error('本地与另一设备的会话内容不同，双方记录已保留，不能自动合并。');
      }
      const isCurrent = await checkNative(); signal?.throwIfAborted();
      if (isCurrent?.() === false || !isDeepStrictEqual(this.service.readCached(this.id).events, expected.events)) {
        throw new Error('会话状态正在变化，尚未恢复写入；请等待当前操作结束后重试。');
      }
      if (!Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= Date.now()) throw new SessionOwnershipLostError(this.id);
      this.lease = lease; this.nextSeq = lease.nextSeq; this.pending = expected.events.slice(lease.nextSeq);
      this.lostOwnership = false; this.needsReconcile = false; this.failure = null;
      await this.journalPending(); this.startHeartbeat();
    } catch (error) {
      this.lostOwnership = true; clearInterval(this.heartbeat); this.heartbeat = null;
      await companyRequest('DELETE', `/sessions/${encodeURIComponent(this.id)}/lease`, { leaseId: lease.leaseId }).catch(() => {});
      throw error;
    }
  }
  async promote(signal) {
    const { session } = await companyRequest('POST', '/sessions', { id: this.id, workspaceRef: this.header.cwd,
      upstreamHeader: this.header, inheritedEventCount: this.inheritedEventCount }, signal);
    if (!isDeepStrictEqual(checkedHeader(session), this.header) || (session.inheritedEventCount ?? 0) !== this.inheritedEventCount) {
      throw new Error('Cloud session metadata differs from the local session');
    }
    const lease = await companyRequest('POST', `/sessions/${encodeURIComponent(this.id)}/lease`, { deviceId: bridgeConfig().deviceId }, signal);
    try {
      // Creation or event responses may have been lost before a prior process
      // stopped. Confirm the exact committed prefix before discarding any local event.
      const count = lease.nextSeq;
      if (!Number.isSafeInteger(count) || count < 0 || count > this.pending.length) throw new Error('Cloud session checkpoint is outside the retained local history');
      if (count && !isDeepStrictEqual(await this.fetchEvents(0, count, signal), this.pending.slice(0, count))) {
        throw new Error('Pending session journal differs from committed cloud events');
      }
      this.lease = lease; this.local = false;
      this.pending.splice(0, count); this.nextSeq = count;
      this.service.knownCloud.add(this.id);
      this.startHeartbeat();
      await this.journalPending();
    } catch (error) {
      if (this.local) await companyRequest('DELETE', `/sessions/${encodeURIComponent(this.id)}/lease`, { leaseId: lease.leaseId }).catch(() => {});
      throw error;
    }
  }
  flush(options) {
    this.assertWrite();
    if (this.closing) return this.closing;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    return this.enqueueOperation(() => this.drain(options?.signal));
  }
  async fetchEvents(offset = 0, length = Infinity, signal) {
    const events = []; let next = offset;
    while (events.length < length) {
      const limit = Math.min(500, length - events.length);
      const page = await companyRequest('GET', `/sessions/${encodeURIComponent(this.id)}/events?afterSeq=${next - 1}&limit=${limit}`, undefined, signal);
      if (!Array.isArray(page.events) || page.events.length > limit || !Number.isSafeInteger(page.nextSeq)
        || page.nextSeq < next || page.nextSeq < next + page.events.length) throw new Error('Invalid cloud session event page');
      if (!page.events.length) break;
      for (const record of page.events) {
        if (record.seq !== next || record.event?.seq !== next) throw new Error('Cloud session event sequence mismatch');
        events.push(record.event); next++;
      }
      if (next >= page.nextSeq) break;
    }
    return validateStoredEvents(this.header, events).map(event => deepFreeze(event));
  }
  async read(offset = 0, length = Infinity, options) {
    this.assertOpen();
    options?.signal?.throwIfAborted();
    if (this.access === 'write') this.retainCache();
    const cached = this.service.readCached(this.id, offset, length);
    if (!cached) throw new SessionPersistenceNotFoundError(this.id);
    if (!this.local) this.service.requestSync(this.id);
    return { events: cached.events, eventState: 'shared-frozen' };
  }
  close() {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    if (this.access === 'read') {
      this.closed = true; this.service.handles.delete(this); return Promise.resolve();
    }
    clearInterval(this.heartbeat);
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.closing = this.enqueueOperation(async () => {
      if (this.access === 'write') {
        if (!this.lostOwnership) {
          await this.drain();
          if (!this.local && this.lease) {
            await companyRequest('DELETE', `/sessions/${encodeURIComponent(this.id)}/lease`, { leaseId: this.lease.leaseId });
            await rm(this.journal, { force: true });
          }
        } else await this.journalPending();
      }
      this.closed = true; this.service.handles.delete(this);
      if (this.service.writers.get(this.id) === this) this.service.writers.delete(this.id);
    }).finally(() => { this.closing = null; });
    return this.closing;
  }
  [Symbol.asyncDispose]() { return this.close(); }
}

export class RemotePersistence extends SessionPersistence {
  handles = new Set(); writers = new Map(); knownCloud = new Set();
  lanes = new Map();
  discarding = new Set(); discarded = new Set(); mutations = new Map();
  listeners = new Set(); syncTasks = new Map(); pendingNotifications = new Map(); syncRequestedAt = new Map(); stopped = false;
  constructor(ctx) {
    super(ctx);
    Object.defineProperty(this, 'rufaExactHistory', { value: true, enumerable: true });
    if (!process.env.DSH_HOME) throw new Error('Isolated DSH_HOME required');
    this.journalRoot = join(process.env.DSH_HOME, 'company-pending-events');
    this.cache = new SessionCache(process.env.DSH_HOME);
    this.backgroundAbort = new AbortController();
  }
  onRemoteChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  enqueue(id, operation) {
    const result = (this.lanes.get(id) ?? Promise.resolve()).then(operation);
    const settled = result.catch(() => {});
    this.lanes.set(id, settled);
    void settled.then(() => { if (this.lanes.get(id) === settled) this.lanes.delete(id); });
    return result;
  }
  assertAvailable(id) {
    if (this.discarding.has(id) || this.discarded.has(id)) throw new Error('此空白会话已离开，请在当前会话继续。');
  }
  async withSessionMutation(id, operation) {
    this.assertAvailable(id);
    this.mutations.set(id, (this.mutations.get(id) ?? 0) + 1);
    try { return await operation(); }
    finally { const count = this.mutations.get(id) - 1; count ? this.mutations.set(id, count) : this.mutations.delete(id); }
  }
  readCached(id, offset = 0, length = Infinity) {
    const record = this.cache.get(id);
    if (!record?.ready) return undefined;
    const events = validateStoredEvents(record.header, this.cache.read(id, offset, length)).map(event => deepFreeze(event));
    return { ...record, header: deepFreeze(record.header), events };
  }
  async notifyRemote(id, fromSeq) {
    const record = this.cache.get(id);
    if (!record?.ready) return;
    fromSeq = Math.min(fromSeq, this.pendingNotifications.get(id) ?? fromSeq);
    this.pendingNotifications.set(id, fromSeq);
    const payload = { id, header: deepFreeze(record.header), inheritedEventCount: record.inheritedEventCount,
      fromSeq, nextSeq: record.eventCount, events: this.readCached(id, fromSeq).events };
    await Promise.all([...this.listeners].map(listener => listener(payload)));
    this.pendingNotifications.delete(id);
  }
  requestSync(id) {
    if (this.stopped || (id && (this.discarding.has(id) || this.discarded.has(id) || this.cache.get(id)?.cloudState === 'local'))) return;
    const key = id ?? '*';
    if (Date.now() - (this.syncRequestedAt.get(key) ?? 0) < 5000) return;
    this.syncRequestedAt.set(key, Date.now());
    void this.sync(id, { signal: this.backgroundAbort.signal }).catch(error => {
      if (!this.stopped) this.ctx.logger.warn('公司历史后台同步未完成，本地记录已保留，将在下次同步重试。');
    });
  }
  startBackground() {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => this.requestSync(), 30_000); this.syncTimer.unref();
  }
  async stopBackground() {
    this.stopped = true; clearInterval(this.syncTimer); this.backgroundAbort.abort();
    await Promise.allSettled([...this.syncTasks.values()]);
    await Promise.allSettled([...this.lanes.values()]);
  }
  async sync(id, options = {}) {
    const key = id ?? '*';
    if (this.syncTasks.has(key)) return this.syncTasks.get(key);
    const operation = async () => {
      options.signal?.throwIfAborted();
      if (id) return this.pull(id, undefined, options.signal);
      const errors = await this.retryPending(options.signal);
      let cursor;
      do {
        const page = await companyRequest('GET', `/sessions?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, options.signal);
        if (!Array.isArray(page.sessions)) throw new Error('Invalid company session catalog');
        for (const summary of page.sessions) {
          options.signal?.throwIfAborted();
          try { await this.syncSummary(summary, options.signal); } catch (error) { errors.push(error); }
        }
        cursor = page.nextCursor;
      } while (cursor);
      // An omitted row is NOT evidence of deletion: paging may fail or race.
      if (errors.length) throw new AggregateError(errors, '部分会话尚未同步，其他会话已继续同步，本地记录已保留。');
      return this.cache.list();
    };
    const task = (id ? this.enqueue(id, operation) : Promise.resolve().then(operation)).finally(() => {
      if (this.syncTasks.get(key) === task) this.syncTasks.delete(key);
    });
    this.syncTasks.set(key, task); return task;
  }
  async retryPending(signal) {
    await this.loadLocalJournals();
    const errors = [];
    for (const record of this.cache.list()) {
      signal?.throwIfAborted();
      if (!record.ready || record.conflict) continue;
      const hasPending = record.cloudState === 'local'
        ? this.cache.read(record.id).some(event => startsSubmission(event, record.inheritedEventCount))
        : record.eventCount > record.syncedSeq;
      const active = this.writers.get(record.id);
      if (!hasPending || active?.lostOwnership) continue;
      if (!active && this.writers.has(record.id)) continue;
      let handle;
      try {
        if (active) { await active.flush({ signal }); continue; }
        handle = await this.open(record.id, 'write', { signal });
        await handle.flush({ signal }); await handle.close();
      } catch (error) {
        // Recovery is a persistence-only operation; it must not reserve a local
        // writer indefinitely and prevent the user's later native open.
        if (handle && !handle.closed) {
          clearInterval(handle.heartbeat); clearTimeout(handle.timer);
          try { await handle.enqueueOperation(() => handle.journalPending()); }
          catch (journalError) { errors.push(journalError); }
          finally {
            if (handle.lease && !handle.lostOwnership) await companyRequest('DELETE', `/sessions/${encodeURIComponent(handle.id)}/lease`, { leaseId: handle.lease.leaseId }).catch(() => {});
            handle.closed = true; this.handles.delete(handle); this.writers.delete(handle.id);
          }
        }
        errors.push(error);
      }
    }
    return errors;
  }
  async syncSummary(summary, signal) {
    const id = summary.id;
    if (this.syncTasks.has(id)) { await this.syncTasks.get(id); return; }
    const operation = () => this.pull(id, summary, signal);
    const task = this.enqueue(id, operation).finally(() => {
      if (this.syncTasks.get(id) === task) this.syncTasks.delete(id);
    });
    this.syncTasks.set(id, task); await task;
  }
  async pull(id, supplied, signal) {
    let summary = supplied;
    if (!summary) {
      const local = this.cache.get(id);
      if (local?.cloudState === 'local') return local;
      try { summary = (await companyRequest('GET', `/sessions/${encodeURIComponent(id)}`, undefined, signal)).session; }
      catch (error) {
        if (error.status !== 404 || !local) throw error;
        const events = this.cache.read(id);
        if (!initializationOnly(local, events)) {
          this.cache.conflict(id, 'REMOTE_MISSING');
          throw new Error('服务器会话已不存在；本地完整记录和未同步内容已保留，请联系管理员恢复。');
        }
        this.cache.markLocal(id); this.knownCloud.delete(id);
        const writer = this.writers.get(id);
        if (writer) {
          clearInterval(writer.heartbeat); writer.heartbeat = null; writer.lease = null;
          writer.local = true; writer.nextSeq = 0; writer.pending = events.map(event => deepFreeze(event)); writer.uploadRequested = false;
          await writer.journalPending();
        }
        await this.notifyRemote(id, events.length);
        return this.cache.get(id);
      }
    }
    checkedHeader(summary); this.knownCloud.add(id);
    this.writers.get(id)?.retainCache();
    const before = this.cache.get(id);
    if (before?.conflict) throw new Error('本地与服务器会话存在同步冲突，记录已保留，请先恢复冲突。');
    this.cache.observeRemote(summary);
    const record = this.cache.get(id); const writer = this.writers.get(id);
    if (summary.nextSeq < record.syncedSeq && supplied) return this.pull(id, undefined, signal);
    if (summary.nextSeq < record.syncedSeq) {
      this.cache.conflict(id, 'REMOTE_REWOUND'); throw new Error('Cloud history checkpoint moved backwards');
    }
    if (writer && !writer.local && summary.nextSeq > record.eventCount) {
      // Another owner advancing beyond a live session invalidates that handle,
      // not the retained history. On reopen, compare every overlapping event
      // before accepting the remote tail; only a real content fork is a conflict.
      writer.loseOwnership();
    }
    const fromSeq = record.eventCount;
    const transport = new RemoteHandle(this, summary, 'read', null);
    let next = record.syncedSeq;
    while (next < summary.nextSeq) {
      signal?.throwIfAborted();
      const events = await transport.fetchEvents(next, Math.min(500, summary.nextSeq - next), signal);
      if (!events.length) throw new Error('Cloud history ended before its checkpoint');
      try { this.cache.append(id, events); }
      catch (error) { this.cache.conflict(id, 'EVENT_CONFLICT'); throw error; }
      next += events.length;
      this.cache.checkpoint(id, next, false);
    }
    this.cache.checkpoint(id, summary.nextSeq);
    if (writer) {
      // A native event can be accepted while the HTTP read is in flight. Its
      // pending tail is still owned locally and must never be replaced silently.
      this.cache.append(id, writer.pending);
      writer.nextSeq = summary.nextSeq;
      writer.pending = validateStoredEvents(writer.header, this.cache.read(id, summary.nextSeq)).map(event => deepFreeze(event));
      writer.local = false;
    }
    if (!writer && (!before?.ready || this.cache.get(id).eventCount > fromSeq || this.pendingNotifications.has(id))) await this.notifyRemote(id, fromSeq);
    return this.cache.get(id);
  }
  async ensureWrite(id, { submission = false, signal, recoverForUser } = {}) {
    this.assertAvailable(id);
    const writer = this.writers.get(id);
    if (!writer) {
      if (submission && recoverForUser && this.cache.get(id)?.conflict === 'LIVE_REMOTE_ADVANCED') {
        await this.enqueue(id, () => this.recoverLegacyConflict(id, signal));
      }
      const record = this.cache.get(id);
      if (record?.cloudState !== 'local') await this.sync(id, { signal });
      this.assertAvailable(id);
      const current = this.cache.get(id);
      if (current?.conflict) throw new Error('会话同步冲突尚未解决，不能继续运行。');
      if (current?.ready) await this.notifyRemote(id, current.eventCount);
      return { id, local: current?.cloudState === 'local', nextSeq: current?.syncedSeq ?? 0, eventCount: current?.eventCount ?? 0, leaseId: null };
    }
    return writer.enqueueOperation(async () => {
      this.assertAvailable(id);
      if (submission && recoverForUser && this.cache.get(id)?.conflict === 'LIVE_REMOTE_ADVANCED') {
        await recoverForUser();
        writer.lostOwnership = true; clearInterval(writer.heartbeat); writer.heartbeat = null;
        await this.recoverLegacyConflict(id, signal);
      }
      if (submission && recoverForUser && !writer.local && (writer.lostOwnership || Date.parse(writer.lease?.expiresAt) <= Date.now())) {
        await writer.recoverOwnership(recoverForUser, signal);
      }
      signal?.throwIfAborted(); writer.assertWrite();
      if (this.cache.get(id)?.conflict) throw new Error('会话同步冲突尚未解决，不能继续运行。');
      if (writer.local && !submission) return { id, local: true, nextSeq: 0, eventCount: writer.pending.length, leaseId: null };
      if (submission) writer.uploadRequested = true;
      const admit = async () => {
        await writer.drain(signal);
        if (!writer.local) {
          await writer.renew();
          if (writer.lease.nextSeq !== writer.nextSeq) writer.loseOwnership();
        }
      };
      try { await admit(); }
      catch (error) {
        if (!submission || !recoverForUser || !writer.lostOwnership) throw error;
        await writer.recoverOwnership(recoverForUser, signal); await admit();
      }
      return { id, local: writer.local, nextSeq: writer.nextSeq, eventCount: this.cache.get(id).eventCount, leaseId: writer.lease?.leaseId ?? null };
    });
  }
  async recoverLegacyConflict(id, signal) {
    const before = this.cache.get(id);
    if (before?.conflict !== 'LIVE_REMOTE_ADVANCED') return;
    const events = this.readCached(id).events;
    const lease = await companyRequest('POST', `/sessions/${encodeURIComponent(id)}/lease`, { deviceId: bridgeConfig().deviceId }, signal);
    try {
      const { session } = await companyRequest('GET', `/sessions/${encodeURIComponent(id)}`, undefined, signal);
      if (!isDeepStrictEqual(checkedHeader(session), before.header) || (session.inheritedEventCount ?? 0) !== before.inheritedEventCount
        || session.nextSeq !== lease.nextSeq || !Number.isSafeInteger(lease.nextSeq) || lease.nextSeq < before.syncedSeq) {
        throw new Error('服务器会话状态未能核对，已有同步冲突标记和完整记录已保留。');
      }
      const transport = new RemoteHandle(this, session, 'read', null);
      const count = Math.min(events.length, lease.nextSeq);
      if (!isDeepStrictEqual(await transport.fetchEvents(0, count, signal), events.slice(0, count))) {
        throw new Error('本地与服务器会话存在内容分歧，已有同步冲突标记和完整记录已保留。');
      }
      signal?.throwIfAborted();
      this.cache.clearVerifiedLegacyConflict(id, before);
    } finally {
      await companyRequest('DELETE', `/sessions/${encodeURIComponent(id)}/lease`, { leaseId: lease.leaseId }).catch(() => {});
    }
  }
  journalPath(id) { return join(this.journalRoot, `${encodeURIComponent(id)}.json`); }
  async readLocal(id) {
    if (this.discarded.has(id)) return undefined;
    const writer = this.writers.get(id);
    if (writer?.local && !writer.closed) return writer.record();
    let record;
    try { record = JSON.parse(await readFile(this.journalPath(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    if (this.discarded.has(id)) return undefined;
    if (record.local !== true) return undefined; // Legacy remote recovery journals remain supported.
    if (record.id !== id || !Array.isArray(record.events)) throw new Error('Invalid local session journal');
    record.header = checkedHeader(localSummary(record));
    record.events = validateStoredEvents(record.header, materializeAppendBatch(record.events)).map(event => deepFreeze(event));
    if (record.events.some((event, index) => event.seq !== index)) throw new Error('Non-contiguous local session journal');
    return record;
  }
  adoptLocal(record, access) {
    this.assertAvailable(record.id);
    const handle = new RemoteHandle(this, localSummary(record), access, null, true);
    handle.accept(record.events);
    this.handles.add(handle);
    if (access === 'write') this.writers.set(handle.id, handle);
    return handle;
  }
  async create(header, options) {
    options?.signal?.throwIfAborted();
    const frozen = materializeCreateHeader(header); assertVersion(frozen);
    this.assertAvailable(frozen.id);
    const inherited = options?.inheritedEventCount;
    if (!Number.isSafeInteger(inherited ?? 0) || (inherited ?? 0) < 0 || (frozen.isSeeded && inherited === undefined) || (!frozen.isSeeded && (inherited ?? 0) !== 0)) throw new Error('Invalid fork inheritance');
    if (this.writers.has(frozen.id)) throw new SessionAlreadyOwnedError(frozen.id);
    this.writers.set(frozen.id, null);
    return this.enqueue(frozen.id, async () => {
    try {
      options?.signal?.throwIfAborted();
      if (this.knownCloud.has(frozen.id) || this.cache.get(frozen.id)) throw new SessionAlreadyExistsError(frozen.id);
      const record = { id: frozen.id, header: frozen, inheritedEventCount: inherited ?? 0, local: true, uploadRequested: false, events: [] };
      await mkdir(this.journalRoot, { recursive: true, mode: 0o700 });
      try { await writeFile(this.journalPath(frozen.id), JSON.stringify(record), { mode: 0o600, flag: 'wx', flush: true }); }
      catch (error) { if (error.code === 'EEXIST') throw new SessionAlreadyExistsError(frozen.id); throw error; }
      return this.adoptLocal(record, 'write');
    } catch (error) { this.writers.delete(frozen.id); throw error; }
    });
  }
  async open(id, access, options) {
    this.assertAvailable(id);
    options?.signal?.throwIfAborted();
    // Observers read the authoritative local store without entering the write
    // lane (including observers called by a pull notification on that lane).
    const observed = this.cache.get(id);
    if (access === 'read' && observed?.ready) {
      const handle = new RemoteHandle(this, cacheSummary(observed), access, null, observed.cloudState === 'local');
      this.handles.add(handle); this.requestSync(id); return handle;
    }
    if (access === 'write' && this.writers.has(id)) throw new SessionAlreadyOwnedError(id);
    if (access === 'write') this.writers.set(id, null);
    return this.enqueue(id, async () => {
    try {
      options?.signal?.throwIfAborted();
      let cached = this.cache.get(id);
      const local = await this.readLocal(id);
      this.assertAvailable(id);
      if (local) {
        this.cache.ensure(local.header, local.inheritedEventCount);
        this.cache.append(id, local.events);
        cached = this.cache.get(id);
      }
      if (cached?.ready && cached.cloudState === 'local') return this.adoptLocal({ id, header: cached.header,
        inheritedEventCount: cached.inheritedEventCount, events: this.readCached(id).events, local: true }, access);
      if (cached) {
        await this.pull(id, undefined, options?.signal);
        this.assertAvailable(id);
        cached = this.cache.get(id);
        if (cached.cloudState === 'local') return this.adoptLocal({ id, header: cached.header,
          inheritedEventCount: cached.inheritedEventCount, events: this.readCached(id).events, local: true }, access);
      }
      const { session } = await companyRequest('GET', `/sessions/${encodeURIComponent(id)}`, undefined, options?.signal);
      return await this.adopt(session, access);
    } catch (error) {
      if (access === 'write') this.writers.delete(id);
      if (error.status === 404) throw new SessionPersistenceNotFoundError(id);
      throw error;
    }
    });
  }
  async adopt(summary, access) {
    checkedHeader(summary);
    this.knownCloud.add(summary.id);
    const lease = access === 'write' ? await companyRequest('POST', `/sessions/${encodeURIComponent(summary.id)}/lease`, { deviceId: bridgeConfig().deviceId }) : null;
    if (lease && lease.nextSeq !== summary.nextSeq) {
      try {
        summary = (await companyRequest('GET', `/sessions/${encodeURIComponent(summary.id)}`)).session;
        checkedHeader(summary);
        if (summary.nextSeq !== lease.nextSeq) throw new Error('Cloud session changed after write lease acquisition');
      } catch (error) {
        await companyRequest('DELETE', `/sessions/${encodeURIComponent(summary.id)}/lease`, { leaseId: lease.leaseId }).catch(() => {});
        throw error;
      }
    }
    const handle = new RemoteHandle(this, summary, access, lease);
    try { await this.pull(summary.id, summary); }
    catch (error) {
      clearInterval(handle.heartbeat); handle.closed = true;
      if (lease) await companyRequest('DELETE', `/sessions/${encodeURIComponent(summary.id)}/lease`, { leaseId: lease.leaseId }).catch(() => {});
      throw error;
    }
    this.handles.add(handle);
    if (access === 'write') {
      handle.accept(this.cache.read(handle.id, handle.nextSeq));
      this.writers.set(handle.id, handle);
      try { await handle.recover(); }
      catch (error) {
        clearInterval(handle.heartbeat); this.handles.delete(handle); this.writers.delete(handle.id); handle.closed = true;
        await companyRequest('DELETE', `/sessions/${encodeURIComponent(handle.id)}/lease`, { leaseId: lease.leaseId }).catch(() => {});
        throw error;
      }
      handle.startHeartbeat();
    }
    return handle;
  }
  async flush() {
    await Promise.allSettled([...this.lanes.values()]);
    const results = await Promise.allSettled([...this.writers.values()].filter(Boolean).map(handle => handle.flush()));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, '公司会话尚未全部保存。'); }
  async stat(id, options) {
    options?.signal?.throwIfAborted();
    if (this.discarded.has(id)) return undefined;
    const cached = this.cache.get(id);
    if (cached?.ready) { this.requestSync(id); return snapshot(cacheSummary(cached)); }
    const local = await this.readLocal(id);
    if (this.discarded.has(id)) return undefined;
    if (local) return snapshot(localSummary(local));
    try { const summary = (await companyRequest('GET', `/sessions/${encodeURIComponent(id)}`, undefined, options?.signal)).session;
      this.knownCloud.add(id); return snapshot(summary); }
    catch (error) { if (error.status === 404) return undefined; throw error; }
  }
  async list(options) {
    options?.signal?.throwIfAborted();
    await this.loadLocalJournals();
    const cached = this.cache.list().filter(record => record.ready);
    if (cached.length) { this.requestSync(); return cached.map(record => snapshot(cacheSummary(record))); }
    await this.sync(undefined, options);
    return this.cache.list().filter(record => record.ready).map(record => snapshot(cacheSummary(record)));
  }
  async loadLocalJournals() {
    if (this.loadedLocalJournals) return;
    let files;
    try { files = await readdir(this.journalRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = decodeURIComponent(file.slice(0, -5));
      if (this.cache.get(id) || this.discarding.has(id) || this.discarded.has(id)) continue;
      const local = await this.readLocal(id);
      if (this.discarding.has(id) || this.discarded.has(id)) continue;
      if (local) { this.cache.ensure(local.header, local.inheritedEventCount); this.cache.append(id, local.events); }
    }
    this.loadedLocalJournals = true;
  }
}

export async function apply(ctx) {
  let backend;
  let service;
  let stopping = false;
  const discardChecks = new Map();
  const confirmDiscard = requestId => new Promise(resolve => {
    if (stopping || !process.connected) { resolve(false); return; }
    const checkId = randomUUID();
    const timer = setTimeout(() => finish(false), 5000);
    const finish = allowed => { clearTimeout(timer); discardChecks.delete(checkId); resolve(allowed === true); };
    discardChecks.set(checkId, { requestId, finish });
    process.send({ type: 'rufa:discard-empty-check', requestId, checkId }, error => { if (error) finish(false); });
  });
  const onMessage = message => {
    if (message?.type === 'rufa:discard-empty-confirm') {
      const check = discardChecks.get(message.checkId);
      if (check?.requestId === message.requestId) check.finish(message.allowed);
      return;
    }
    if (message?.type === 'rufa:discard-empty' && typeof message.requestId === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(message.requestId)) {
      const operation = !stopping && backend?.discardUnusedSession ? backend.discardUnusedSession(message.sessionId, () => confirmDiscard(message.requestId)) : Promise.resolve({ deleted: false });
      void operation.catch(() => ({ deleted: false })).then(value => {
        if (process.connected) process.send({ type: 'rufa:discard-empty-result', requestId: message.requestId, deleted: value.deleted === true }, () => {});
      });
      return;
    }
    if (message?.type !== 'rufa:shutdown' || stopping) return;
    stopping = true;
    for (const check of [...discardChecks.values()]) check.finish(false);
    if (process.connected) process.send({ type: 'rufa:shutdown-received' }, () => {});
    // Windows does not deliver a graceful SIGTERM through child.kill(). Invoke
    // the original launcher's registered handler through the private parent IPC.
    void backend.flush().catch(() => {}).finally(() => { process.emit('SIGTERM'); });
  };
  const onDisconnect = () => onMessage({ type: 'rufa:shutdown' });
  // Match the upstream backend's resource ordering: retain event routing while
  // disposing the service and its dependent consumers, then drain the handles.
  ctx.effect(function* () {
    if (process.send) { process.on('message', onMessage); process.on('disconnect', onDisconnect); }
    yield () => { process.removeListener('message', onMessage); process.removeListener('disconnect', onDisconnect); };
    ctx.on('session/event', (session, event) => { backend.writers.get(session.id)?.enqueueLive(event); });
    ctx.on('session/flush', session => backend.writers.get(session.id)?.flush());
    ctx.on('session/disposed', session => {
      backend.writers.get(session.id)?.close().catch(() => ctx.logger.warn('会话关闭时未完成云端保存，恢复记录已保留。'));
    });
    yield async () => {
      await backend.stopBackground();
      const results = await Promise.allSettled([...backend.handles].map(handle => handle.close()));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (process.connected) await new Promise(resolve => process.send({ type: 'rufa:persistence-flushed', ok: errors.length === 0 }, () => resolve()));
      backend.cache.close();
      if (errors.length) throw new AggregateError(errors, '仍有会话未完成保存。');
    };
    service = ctx.plugin({ name: 'rufa-remote-persistence-service', apply(serviceCtx) { backend = new RemotePersistence(serviceCtx); } });
    yield service.dispose;
  }, 'rufa persistence resources');
  await service.await();
  const { installHistoryIntegration } = await import('./company-history.mjs');
  installHistoryIntegration(ctx, backend);
  backend.startBackground();
}
