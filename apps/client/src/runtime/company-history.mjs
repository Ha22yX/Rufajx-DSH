// Pinned Harness integration: display cached history without activating an Agent.
// Remote tails are delivered to the history UI, never replayed as local tool work.
import { attachUnusedSessions } from './unused-sessions.mjs';
import { isDeepStrictEqual } from 'node:util';
const originalService = value => value[Symbol.for('cordis.original')] ?? value;

export async function* followCachedHistory(original, receiver, request, signal, backend, subscribe) {
  const target = request.address.kind === 'session' ? request.address.sessionId : request.address.childSessionId;
  const lifetime = new AbortController();
  const combined = AbortSignal.any([signal, lifetime.signal]);
  const queue = [];
  let wake;
  const push = value => { queue.push(value); const resolve = wake; wake = undefined; resolve?.(); };
  const stop = () => push({ kind: 'stop' });
  combined.addEventListener('abort', stop, { once: true });
  const unsubscribe = subscribe(change => { if (change.id === target) push({ kind: 'remote', change }); });
  let nextSeq;
  let pendingRemote = false;
  const pump = (async () => {
    try {
      for await (const frame of original.call(receiver, request, combined)) push({ kind: 'native', frame });
      push({ kind: 'stop' });
    } catch (error) { push({ kind: 'error', error }); }
  })();
  async function cachedTail(through) {
    const cached = await backend.readCached(target, nextSeq, through === undefined ? Infinity : through - nextSeq);
    if (!cached) throw new Error('会话本地缓存不可用，请重新打开会话。');
    const rows = cached.events;
    if (through !== undefined && rows.length !== through - nextSeq) throw new Error('会话同步记录不连续，请稍后重试。');
    for (const [index, event] of rows.entries()) if (event.seq !== nextSeq + index) throw new Error('会话同步序号不连续。');
    return rows;
  }
  try {
    while (!combined.aborted) {
      const item = queue.shift();
      if (!item) { await new Promise(resolve => { wake = resolve; }); continue; }
      if (item.kind === 'stop') break;
      if (item.kind === 'error') throw item.error;
      if (item.kind === 'remote') {
        if (nextSeq === undefined) { pendingRemote = true; continue; }
        for (const event of await cachedTail()) { nextSeq++; yield { type: 'event', event }; }
        continue;
      }
      const frame = item.frame;
      if (frame.type === 'snapshot') {
        nextSeq = frame.cursor + 1;
        yield frame;
        if (pendingRemote) {
          pendingRemote = false;
          for (const event of await cachedTail()) { nextSeq++; yield { type: 'event', event }; }
        }
      } else if (frame.type === 'event') {
        if (nextSeq === undefined) throw new Error('会话事件先于历史快照。');
        if (frame.event.seq < nextSeq) continue;
        if (frame.event.seq > nextSeq) for (const event of await cachedTail(frame.event.seq)) { nextSeq++; yield { type: 'event', event }; }
        nextSeq++;
        yield frame;
      } else yield frame;
    }
  } finally {
    unsubscribe();
    lifetime.abort();
    combined.removeEventListener('abort', stop);
    await pump;
  }
}

export function attachSessionHistory(ctx, controller, backend) {
  const { history, commands, listState, controlState } = controller;
  if (typeof controller.promote !== 'function' || typeof history?.follow !== 'function'
    || typeof commands?.prompt !== 'function' || typeof listState?.summarizeCold !== 'function'
    || typeof listState?.list !== 'function' || typeof listState?.summaryFor !== 'function'
    || typeof controlState?.broadcast !== 'function') throw new Error('Harness历史接口已变化，需要更新公司适配。');
  const restores = [];
  const replace = (object, key, replacement) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, writable: true, value: replacement });
    restores.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : delete object[key]);
  };
  const followers = new Set();
  const pendingPrompts = new Map();
  // Wire projection hints only: never retain prepared Sessions, events or leases.
  const listHints = new Map();
  let active = true;
  const subscribe = listener => { followers.add(listener); return () => followers.delete(listener); };
  const withObservation = (row, observation) => {
    const projections = observation.projections, metadata = projections?.values.sessionListMetadata;
    return { ...row,
      ...(metadata ? { blank: metadata.blank, updatedAt: Math.max(observation.header.createdAt, metadata.lastPromptAt ?? 0) } : {}),
      ...(projections ? { projections: { kind: 'cached', asOfSeq: projections.asOfSeq, values: projections.values } } : {}),
    };
  };
  // A cold catalogue does not necessarily have in-memory projection snapshots
  // after process restart. Reuse the native read-only, revision-cached observer
  // to populate titles/last user activity before publishing the initial list.
  const list = listState.list;
  replace(listState, 'list', async function(signal) {
    const rows = await list.call(this, signal), hydrated = [];
    const present = new Set(rows.map(row => row.sessionId));
    for (const id of listHints.keys()) if (!present.has(id)) listHints.delete(id);
    for (const row of rows) {
      signal?.throwIfAborted();
      if (!active) throw new Error('会话列表已关闭。');
      const live = ctx.sessions.get(row.sessionId);
      if (live) { listHints.delete(row.sessionId); hydrated.push(this.summaryFor(live)); continue; }
      if (row.formatStatus !== undefined && row.formatStatus !== 'current') { hydrated.push(row); continue; }
      try {
        const stat = await backend.stat(row.sessionId, { signal });
        signal?.throwIfAborted();
        if (!active) throw new Error('会话列表已关闭。');
        const current = ctx.sessions.get(row.sessionId);
        if (current) { listHints.delete(row.sessionId); hydrated.push(this.summaryFor(current)); continue; }
        const cached = listHints.get(row.sessionId);
        if (stat?.revision !== undefined && cached?.revision === stat.revision) {
          hydrated.push({ ...row, ...cached.fields }); continue;
        }
        if (row.projections?.values.sessionListMetadata && Number.isSafeInteger(stat?.eventCount)
          && row.projections.asOfSeq === stat.eventCount - 1) {
          hydrated.push(row); continue;
        }
        const observation = await ctx.sessionQuery.observeSession(row.sessionId, { projectionMode: 'all', signal });
        try {
          signal?.throwIfAborted();
          if (!active) throw new Error('会话列表已关闭。');
          const resumed = ctx.sessions.get(row.sessionId);
          if (resumed) { listHints.delete(row.sessionId); hydrated.push(this.summaryFor(resumed)); }
          else {
            const fields = withObservation({}, observation);
            if (observation.revision !== undefined && observation.projections) listHints.set(row.sessionId, { revision: observation.revision, fields });
            hydrated.push({ ...row, ...fields });
          }
        } finally { observation[Symbol.dispose](); }
      } catch (error) {
        signal?.throwIfAborted();
        if (!active || error?.name === 'AbortError' || error?.code === 'SESSION_QUERY_ABORTED') throw error;
        listHints.delete(row.sessionId);
        ctx.logger?.warn('公司会话列表：一条历史的显示信息暂时不可用，保留原始记录。');
        const current = ctx.sessions.get(row.sessionId);
        hydrated.push(current ? this.summaryFor(current) : row);
      }
      if (hydrated.length % 8 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    signal?.throwIfAborted();
    if (!active) throw new Error('会话列表已关闭。');
    return hydrated.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
  });
  // Native follow transfers a retained observation to promote(). Release it,
  // without resume/write ownership, crash-repair suffixes or background execution.
  replace(controller, 'promote', observation => observation[Symbol.dispose]());
  const follow = history.follow;
  replace(history, 'follow', function(request, signal) {
    return followCachedHistory(follow, this, request, signal, backend, subscribe);
  });
  const prompt = commands.prompt;
  replace(commands, 'prompt', async function(request, source) {
    // The public native endpoint already rejected blank/invalid requests.
    // On a cold session the subsequent native open(write) also verifies ownership
    // before replay/repair. A live session must pass here before its inbox grows.
    const userRpc = source?.kind === 'user' && typeof request.requestId === 'string' && source.rpcId === request.requestId;
    const key = userRpc ? JSON.stringify([request.sessionId, request.requestId]) : null;
    const existing = key && pendingPrompts.get(key);
    if (existing) {
      if (!isDeepStrictEqual(existing.request, request) || !isDeepStrictEqual(existing.source, source)) throw new Error('重复提交的内容不一致，请重新发送。');
      return existing.task;
    }
    const recoverForUser = !userRpc ? undefined : async () => {
      const live = ctx.sessions.get(request.sessionId), agent = ctx.agents?.get(request.sessionId);
      if (!live || !agent || agent.status !== 'idle' || agent.session !== live) throw new Error('请等待当前任务停止后，再发送消息或点击继续恢复会话。');
      const observed = await ctx.sessionQuery.observeSession(request.sessionId);
      try {
        if (!active || ctx.sessions.get(request.sessionId) !== live || ctx.agents.get(request.sessionId) !== agent
          || agent.status !== 'idle' || observed.source !== 'live' || observed.events.length !== live.seq) {
          throw new Error('会话状态正在变化，请等待当前操作结束后重试。');
        }
        const events = observed.events;
        return { header: observed.header, events, isCurrent: () => active && ctx.sessions.get(request.sessionId) === live
          && ctx.agents.get(request.sessionId) === agent && agent.status === 'idle' && live.seq === events.length };
      } finally { observed[Symbol.dispose](); }
    };
    const submit = async () => {
      if (!active) throw new Error('会话已关闭，请重新打开后发送。');
      await backend.ensureWrite(request.sessionId, { submission: true, recoverForUser });
      if (!active) throw new Error('会话已关闭，请重新打开后发送。');
      return prompt.call(this, request, source);
    };
    const task = Promise.resolve().then(() => backend.withSessionMutation ? backend.withSessionMutation(request.sessionId, submit) : submit());
    if (key) pendingPrompts.set(key, { request: structuredClone(request), source: structuredClone(source), task });
    try { return await task; }
    finally { if (key && pendingPrompts.get(key)?.task === task) pendingPrompts.delete(key); }
  });
  const unsubscribe = backend.onRemoteChange(async change => {
    if (!active) return;
    listHints.delete(change.id);
    const live = ctx.sessions.get(change.id);
    if (live) {
      const cached = await backend.readCached(change.id, live.seq);
      if (cached?.events.length) throw new Error('此会话已在其他设备更新，请重新打开客户端后继续，已有本地记录已保留。');
      return; // Its native event stream already carries all local appends.
    }
    // Publish the exact original envelopes. This notification cannot run an Agent,
    // alter an inbox, enqueue tools or feed the persistence writer back into itself.
    for (const listener of followers) listener(change);
    const observation = await ctx.sessionQuery.observeSession(change.id, { projectionMode: 'all' });
    try {
      // A real prompt can acquire ownership while observation awaits storage.
      // Never overwrite the freshly published live/running row with a cold row.
      if (!active || ctx.sessions.get(change.id) || observation.source === 'live') return;
      const projections = observation.projections;
      if (observation.revision !== undefined && projections) listHints.set(change.id, { revision: observation.revision, fields: withObservation({}, observation) });
      if (projections) for (const [key, value] of Object.entries(projections.values)) {
        controlState.broadcast({ type: 'projection', sessionId: change.id, key, value, seq: projections.asOfSeq });
      }
      if (observation.header.cwd === undefined) return;
      const row = listState.summarizeCold({ header: observation.header, formatStatus: 'current' });
      ctx.emit('api-session/added', withObservation(row, observation));
    } finally { observation[Symbol.dispose](); }
  });
  return () => { active = false; unsubscribe(); for (const restore of restores.reverse()) restore(); followers.clear(); listHints.clear(); };
}

export function installHistoryIntegration(ctx, backend) {
  ctx.inject(['sessionController', 'sessionQuery', 'sessions', 'agents', 'workspaceRegistry'], scope => {
    scope.effect(() => attachSessionHistory(scope, originalService(scope.sessionController), backend));
    scope.effect(() => attachUnusedSessions(scope, originalService(scope.sessionController), backend));
  });
  // Covers non-UI initiators (automation, subagents, retries) as well as the
  // prompt endpoint. Keep the original automatic review and denial behavior.
  ctx.on('agent/pre-step', async (execution, next) => {
    await backend.ensureWrite(execution.agent.id, { submission: true, signal: execution.signal });
    return next();
  }, { prepend: true, global: true });
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (!execution.agent) return next();
    try { await backend.ensureWrite(execution.agent.id, { submission: true, signal: execution.signal }); }
    catch { return { kind: 'deny', reason: '会话尚未完成同步或写入授权，请联网后重试。' }; }
    const decision = await next();
    try { await backend.ensureWrite(execution.agent.id, { submission: true, signal: execution.signal }); }
    catch { return { kind: 'cancel' }; }
    return decision;
  }, { prepend: true, global: true });
  // Native pre-execute may return `ask`; its human wait happens AFTER that
  // waterfall. Revalidate at around-dispatch, after the answer and before body.
  ctx.on('tools/execute', async (execution, next) => {
    if (execution.agent) await backend.ensureWrite(execution.agent.id, { submission: true, signal: execution.signal });
    return next();
  }, { prepend: true, global: true });
}
