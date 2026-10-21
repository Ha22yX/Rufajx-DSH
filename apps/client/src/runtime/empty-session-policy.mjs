export function initializationOnly(record, events) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
  const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max;
  const epoch = value => Number.isSafeInteger(value) && value >= 0;
  const header = record?.header;
  return object(record) && object(header) && Array.isArray(events) && record.ready === true && record.inheritedEventCount === 0
    && keys(header, ['version', 'id', 'createdAt', 'cwd', 'isSeeded', 'agentPreset'])
    && header.version === 4 && header.id === record.id && epoch(header.createdAt) && header.isSeeded === false
    && (header.cwd === undefined || text(header.cwd)) && (header.agentPreset === undefined || text(header.agentPreset, 128))
    && events.every((event, seq) => {
      if (!keys(event, ['type', 'seq', 'time', 'data']) || event.seq !== seq || !epoch(event.time) || !object(event.data)) return false;
      const data = event.data;
      switch (event.type) {
        case 'session/end-seed': return Object.keys(data).length === 0;
        case 'permission/preset': return keys(data, ['preset']) && ['auto', 'workspace-write', 'danger-full-access'].includes(data.preset);
        case 'sandbox/mode': return keys(data, ['mode']) && ['read-only', 'workspace-write', 'danger-full-access'].includes(data.mode);
        case 'approval/policy': return keys(data, ['policy']) && ['ask', 'never'].includes(data.policy);
        case 'agent-preset/selected': return keys(data, ['agentPreset']) && text(data.agentPreset, 128);
        case 'working-directory/change': return keys(data, ['cwd']) && text(data.cwd);
        case 'model/selection': return keys(data, ['provider', 'model', 'reasoningEffort']) && text(data.provider, 128) && text(data.model, 256)
          && (data.reasoningEffort === undefined || text(data.reasoningEffort, 64));
        default: return false;
      }
    });
}

// Unknown shapes are retained. In particular, reference chips,
// claimed commands and attachment-only drafts are not disposable empty input.
export function emptyConversationState(raw) {
  if (raw === null || raw === undefined) return true;
  if (typeof raw !== 'string') return false;
  try {
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || Object.keys(state).some(key => !['draft', 'view', 'viewRequest'].includes(key))
      || !Object.hasOwn(state, 'draft')) return false;
    const draft = state.draft;
    return (typeof draft === 'string' && draft.trim() === '') || (draft !== null && typeof draft === 'object' && !Array.isArray(draft)
      && Object.keys(draft).every(key => ['text', 'references'].includes(key))
      && typeof draft.text === 'string' && draft.text.trim() === '' && Array.isArray(draft.references) && draft.references.length === 0);
  } catch { return false; }
}

export function emptyInputState(state) {
  return !!state && typeof state.draft === 'string' && state.draft.trim() === '' && state.phase === 'plain' && state.claim === undefined
    && ['attachmentIds', 'occurrences', 'queue'].every(key => Array.isArray(state[key]) && state[key].length === 0);
}

