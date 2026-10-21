// Read-only UI eligibility. Resuming is an ordinary native prompt, never event replay.
import { importUpstream } from './import-upstream.mjs';

export function createContinuationProjection(z) {
  const currentSchema = z.object({
    turn: z.number().int().nonnegative(), startSeq: z.number().int().nonnegative().nullable(),
    endSeq: z.number().int().nonnegative().nullable(),
    reason: z.enum(['none', 'open', 'completed', 'aborted', 'interrupted', 'error', 'blocked', 'max-tokens', 'forked', 'other']),
  });
  const empty = () => ({ turn: 0, startSeq: null, endSeq: null, reason: 'none' });
  const ended = new Set(['completed', 'aborted', 'interrupted', 'error', 'blocked', 'max-tokens', 'forked']);
  return {
    key: 'rufaContinuation', stateVersion: 1,
    stateSchema: z.object({ inheritedEventCount: z.number().int().nonnegative(), current: currentSchema }),
    init: (_header, inheritedEventCount = 0) => ({ inheritedEventCount, current: empty() }),
    apply(state, event) {
      if (event.seq < state.inheritedEventCount) return state;
      // A fork's inherited prefix is not an interrupted task in the new session.
      // Untagged end-seed is normal restore lifecycle and must retain eligibility.
      if (event.type === 'session/end-seed' && event.data.inherited === true) return { ...state, current: empty() };
      if (event.type === 'turn/start') return { ...state,
        current: { turn: event.data.turn, startSeq: event.seq, endSeq: null, reason: 'open' } };
      if (event.type !== 'turn/end' || state.current.startSeq === null || event.data.turn !== state.current.turn) return state;
      return { ...state, current: { ...state.current, endSeq: event.seq,
        reason: ended.has(event.data.reason.kind) ? event.data.reason.kind : 'other' } };
    },
    wire: { viewSchema: currentSchema, view: state => state.current },
  };
}

export function installContinuationProjection(ctx) {
  return ctx.inject(['sessionProjections'], async scope => {
    const { z } = await importUpstream('zod');
    scope.sessionProjections.register(createContinuationProjection(z));
  });
}
