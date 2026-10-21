// Pure browser helpers embedded by the pinned InputBar patch and exercised independently.
export const CONTINUATION_PROMPT = '继续完成刚才中断的任务；先核对当前状态，避免重复已完成的操作。';

export function rufaCanContinue({ continuation, session, input, disabled = false, uploadsPending = false }) {
  return !!(continuation && ['open', 'aborted', 'interrupted', 'error'].includes(continuation.reason)
    && continuation.startSeq !== null && session?.openState === 'open' && !session.blank
    && !session.running && !session.removed && session.subagent === null
    && !session.awaitingFirstTurn && session.pendingSubmissions?.length === 0
    && input?.phase === 'plain' && input.draft.trim() === '' && input.attachmentIds.length === 0
    && !disabled && !uploadsPending);
}

export function rufaSubmitContinuation({ current, keyboard, inputActions, disabled, uploadsPending, lock, setPending }) {
  if (lock.current || !keyboard || !inputActions || !current) return false;
  // Re-read the native shell and session at the click boundary, not a render snapshot.
  if (!rufaCanContinue({ ...current(), input: keyboard.snapshot, disabled, uploadsPending })) return false;
  lock.current = true;
  setPending(true);
  try {
    inputActions.setDraft(CONTINUATION_PROMPT);
    keyboard.submit('queue', 'click');
    return true;
  } catch (error) {
    lock.current = false;
    setPending(false);
    throw error;
  }
}
