// Serialized into the company browser entry. Only exact native input snapshots
// establish draft emptiness; the privileged host separately checks full events.
export function installUnusedSessionUi(scope, bridge, policy, storage = localStorage) {
  if (typeof bridge?.discardEmptySession !== 'function') return () => {};
  const current = scope.uiSession.adapter.current, panels = scope.layout.panelInfo;
  const workspace = scope.uiWorkspace[Symbol.for('cordis.original')] ?? scope.uiWorkspace;
  const pending = new Map(), discarded = new Set(), inertElements = new Map(), candidates = new Map(), returning = new Set();
  let active = true, visible = true, tracked, source, offSource, openingFor;
  const selected = () => current.getSnapshot().key;
  const inConversation = () => visible && panels.getSnapshot().activePanelId === null;
  const idleInput = candidate => {
    try {
      const state = candidate.session.getSnapshot();
      return !state.subagent && !state.running && state.blank === true && state.promptAttempted === false
        && Array.isArray(state.pendingSubmissions) && state.pendingSubmissions.length === 0
        && policy.emptyInputState(candidate.input.state.getSnapshot())
        // Empty options are a public no-op probe. Native detached sends can
        // have an empty/plain editor while encoding references or images.
        && scope.conversation.input.requestDraftInitialization(candidate.binding, {}) === 'preserved';
    } catch { return false; }
  };
  const previousConfirm = window.__RUFA_CONFIRM_EMPTY_DISCARD__;
  const confirm = id => {
    const candidate = candidates.get(id);
    try { return active && pending.has(id) && !!candidate && !returning.has(id) && (!inConversation() || selected() !== id)
      && idleInput(candidate) && policy.emptyConversationState(storage.getItem(`dsh.conversation.${id}`)); }
    catch { return false; }
  };
  window.__RUFA_CONFIRM_EMPTY_DISCARD__ = confirm;
  const protect = () => {
    for (const [element, before] of inertElements) if (!element.isConnected || !pending.has(element.getAttribute('data-conversation-session'))) {
      element.inert = before; inertElements.delete(element);
    }
    for (const element of document.querySelectorAll('[data-conversation-session]')) if (pending.has(element.getAttribute('data-conversation-session'))) {
      if (!inertElements.has(element)) inertElements.set(element, element.inert);
      element.inert = true;
    }
  };
  const recoverSelection = () => {
    const id = selected();
    if (!active || !inConversation() || !discarded.has(id) || pending.has(id) || openingFor === id) return;
    openingFor = id;
    scope.uiWorkspace.startSession();
  };
  const leave = previous => {
    if (!previous || pending.has(previous.id) || discarded.has(previous.id)) return;
    const state = previous.session.getSnapshot();
    if (state.removed || !idleInput(previous)) return;
    const key = `dsh.conversation.${previous.id}`;
    try { if (!policy.emptyConversationState(storage.getItem(key))) return; } catch { return; }
    let reference;
    try { reference = scope.sessions.retain(previous.id, { source: 'controllerOperation' }); }
    catch { return; }
    candidates.set(previous.id, previous);
    const operation = (async () => {
      const result = await bridge.discardEmptySession(previous.id);
      if (!active || result?.ok !== true || result.value?.deleted !== true) return false;
      discarded.add(previous.id);
      // Preload mirrors this removal into the same account's persistent UI file.
      if (policy.emptyConversationState(storage.getItem(key))) storage.removeItem(key);
      scope.sessions.handleSessionRemoved(previous.id);
      return true;
    })().catch(() => false).finally(() => {
      pending.delete(previous.id); candidates.delete(previous.id); returning.delete(previous.id); reference.release(); protect(); recoverSelection();
    });
    pending.set(previous.id, operation); protect();
  };
  const check = () => {
    if (!active) return;
    const id = inConversation() ? selected() : undefined;
    if (pending.has(id)) returning.add(id);
    if (tracked?.id !== id) { const previous = tracked; tracked = undefined; leave(previous); }
    if (id !== openingFor) openingFor = undefined;
    const nextSource = current.getSnapshot().hooks.session;
    if (source !== nextSource) { offSource?.(); source = nextSource; offSource = source?.subscribe(check); }
    recoverSelection();
    if (!id || tracked || pending.has(id) || discarded.has(id)) return;
    const binding = scope.sessions.binding(id);
    if (!binding || binding.session.getSnapshot().subagent) return;
    try { tracked = { id, binding, session: binding.session, input: scope.conversation.input.for(binding.ctx) }; }
    catch { /* A still-opening or retiring native scope is not safe to discard. */ }
  };
  const openSession = workspace.openSession, descriptor = Object.getOwnPropertyDescriptor(workspace, 'openSession');
  Object.defineProperty(workspace, 'openSession', { configurable: true, writable: true, value: function(target) {
    const id = typeof target === 'string' ? target : target?.childSessionId;
    if (!pending.has(id)) return openSession.call(this, target);
    returning.add(id);
    const navigation = scope.layout.beginNavigation();
    void pending.get(id).then(deleted => {
      if (!active || navigation.aborted) return;
      if (deleted) scope.uiWorkspace.startSession(); else openSession.call(this, target);
    });
  } });
  const observer = new MutationObserver(protect);
  observer.observe(document.getElementById('root') ?? document.documentElement, { childList: true, subtree: true });
  const disposers = [current.subscribe(check), panels.subscribe(check), scope.sessions.list.subscribe(check),
    bridge.onWorkbenchVisibility?.(shown => { visible = shown; check(); })];
  check();
  return () => {
    active = false; offSource?.(); for (const off of disposers) off?.(); observer.disconnect();
    for (const [element, before] of inertElements) element.inert = before;
    descriptor ? Object.defineProperty(workspace, 'openSession', descriptor) : delete workspace.openSession;
    if (window.__RUFA_CONFIRM_EMPTY_DISCARD__ === confirm) window.__RUFA_CONFIRM_EMPTY_DISCARD__ = previousConfirm;
    tracked = undefined;
  };
}
