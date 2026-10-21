import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { importUpstream } from '../src/runtime/import-upstream.mjs';
import { createContinuationProjection, installContinuationProjection } from '../src/runtime/company-continuation.mjs';
import { CONTINUATION_PROMPT, rufaCanContinue, rufaSubmitContinuation } from '../src/runtime/continuation-ui.mjs';
import { patchContinuationSource } from '../scripts/continuation-runtime.mjs';

const sessionState = () => ({ openState: 'open', blank: false, running: false, removed: false,
  subagent: null, awaitingFirstTurn: false, pendingSubmissions: [], promptError: null });
const inputState = () => ({ phase: 'plain', draft: '', attachmentIds: [], queue: [] });
const continuationState = () => ({ turn: 1, startSeq: 0, endSeq: 3, reason: 'aborted' });

test('continuation eligibility distinguishes latest interruptions, ordinary sends, and parked queues', () => {
  const base = { continuation: continuationState(), session: sessionState(), input: inputState() };
  for (const reason of ['open', 'aborted', 'interrupted', 'error']) assert.equal(rufaCanContinue({ ...base, continuation: { ...base.continuation, reason } }), true, reason);
  for (const reason of ['none', 'completed', 'forked', 'blocked', 'max-tokens', 'unknown']) assert.equal(rufaCanContinue({ ...base, continuation: { ...base.continuation, reason } }), false, reason);
  for (const patch of [{ running: true }, { removed: true }, { blank: true }, { openState: 'loading' },
    { openState: 'error' }, { pendingSubmissions: [{}] }, { awaitingFirstTurn: true }, { subagent: { address: {} } }]) {
    assert.equal(rufaCanContinue({ ...base, session: { ...base.session, ...patch } }), false);
  }
  for (const patch of [{ draft: 'new message' }, { attachmentIds: ['image'] }, { phase: 'adjudicating' }, { phase: 'submitting' }, { phase: 'claimed' }]) {
    assert.equal(rufaCanContinue({ ...base, input: { ...base.input, ...patch } }), false);
  }
  assert.equal(rufaCanContinue({ ...base, input: { ...base.input, queue: [{ content: 'parked' }] } }), true);
  assert.equal(rufaCanContinue({ ...base, disabled: true }), false);
  assert.equal(rufaCanContinue({ ...base, uploadsPending: true }), false);
  assert.equal(rufaCanContinue({ ...base, continuation: undefined }), false);
});

test('continue submits one visible native queue message, guards stale drafts and holds its synchronous lock', () => {
  let input = inputState(), session = sessionState(); const sent = [], pending = [], lock = { current: false };
  const options = { current: () => ({ session, continuation: continuationState() }),
    inputActions: { setDraft(text) { input = { ...input, draft: text }; } },
    keyboard: { get snapshot() { return input; }, submit(mode, source) {
      sent.push({ text: input.draft, mode, source }); input = inputState(); // Native detached sends clear while phase stays plain.
    } }, lock, setPending: value => pending.push(value) };
  assert.equal(rufaSubmitContinuation(options), true);
  assert.deepEqual(sent, [{ text: CONTINUATION_PROMPT, mode: 'queue', source: 'click' }]);
  assert.equal(rufaSubmitContinuation(options), false); assert.equal(sent.length, 1);
  lock.current = false; input.draft = 'typed since render';
  assert.equal(rufaSubmitContinuation(options), false); assert.equal(input.draft, 'typed since render');
  input = inputState(); session.running = true;
  assert.equal(rufaSubmitContinuation(options), false);
  session.running = false; options.keyboard.submit = () => { throw new Error('synthetic admission failure'); };
  assert.throws(() => rufaSubmitContinuation(options), /synthetic/);
  assert.equal(lock.current, false); assert.equal(pending.at(-1), false);
  assert.equal(input.draft, CONTINUATION_PROMPT); // A failed attempt remains editable, not silently lost.
});

test('real projection registry restores interruptions without changing history and excludes inherited fork work', { skip: !process.env.RUFA_RUNTIME_ROOT }, async () => {
  const [{ Context }, { default: ProjectionRegistry }, { z }] = await Promise.all([
    importUpstream('@deepseek-ai/cordis'), importUpstream('@deepseek-ai/dsh-session-projection'), importUpstream('zod'),
  ]);
  const ctx = new Context(); await ctx.plugin(ProjectionRegistry);
  const mounted = ctx.plugin({ name: 'continuation-test', async apply(scope) { await installContinuationProjection(scope); } }); await mounted.await();
  const header = { id: 'synthetic-session', version: 4, createdAt: 1, isSeeded: false };
  const events = [];
  const add = (type, data) => events.push({ seq: events.length, time: events.length + 1, type, data });
  const restore = (inherited = 0) => ctx.sessionProjections.restore({}, events, 0, header, inherited).snapshot.values.rufaContinuation;
  try {
    assert.equal(restore().reason, 'none');
    add('turn/start', { turn: 1 }); assert.equal(restore().reason, 'open');
    add('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
    assert.equal(restore().reason, 'aborted');
    add('session/end-seed', {}); assert.equal(restore().reason, 'aborted');
    const bytes = JSON.stringify(events), checkpoint = ctx.sessionProjections.restore({}, events, 0, header, 0).checkpoint;
    assert.equal(ctx.sessionProjections.restore(checkpoint, [], events.length, header, 0).snapshot.values.rufaContinuation.reason, 'aborted');
    assert.equal(JSON.stringify(events), bytes);
    assert.equal(restore(events.length).reason, 'none');
    add('session/end-seed', { inherited: true }); assert.equal(restore().reason, 'none');
    add('turn/end', { turn: 1, reason: { kind: 'forked' } }); assert.equal(restore().reason, 'none');
    add('turn/start', { turn: 2 }); add('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'mock', code: 'UNKNOWN' } } });
    assert.equal(restore().reason, 'error');
    add('turn/start', { turn: 3 }); add('turn/end', { turn: 3, reason: { kind: 'completed' } });
    assert.equal(restore().reason, 'completed');
    const definition = createContinuationProjection(z), state = definition.init(header, 0);
    assert.equal(definition.apply(state, { seq: 0, type: 'session/end-seed', data: {} }), state);
    await mounted.dispose(); assert.equal(restore(), undefined);
  } finally { await ctx.fiber.dispose(); }
});

test('patched native InputBar renders play, arrow and stop without replacing its native submission handlers', { skip: !process.env.RUFA_RUNTIME_ROOT }, async () => {
  const source = await readFile(join(process.env.RUFA_RUNTIME_ROOT, 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'), 'utf8');
  const patched = patchContinuationSource(source);
  assert.equal(patchContinuationSource(patched), patched);
  assert.throws(() => patchContinuationSource(patched.replace('const primaryContinues =', 'const brokenContinues =')), /incomplete or changed/);
  new vm.Script(patched); // Parse the full real browser bundle, including the precise injection edit.
  const start = patched.indexOf('// Rufajx native composer continuation v1');
  const end = patched.indexOf('\n\t\t//#endregion', start);
  const fragment = patched.slice(start, end);
  let input = inputState(), session = sessionState(), continuation = continuationState(), sent = [], stopped = 0;
  const hooks = [], effects = []; let cursor = 0;
  const react = { memo: fn => fn, useMemo: fn => fn(), useCallback: fn => fn,
    useRef(value) { const index = cursor++; return hooks[index] ??= { current: value }; },
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => { hooks[index] = value; }]; },
    useEffect(fn, deps) { const index = cursor++, before = hooks[index]; if (!before || deps.some((value, i) => value !== before[i])) { hooks[index] = deps; effects.push(fn); } },
    useLayoutEffect() {},
  };
  const sandbox = { react, react_jsx_runtime: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    _deepseek_ai_dsh_client_ui_primitives: new Proxy({}, { get: (_, key) => key }),
    InputBar_module_css_default: new Proxy({}, { get: (_, key) => key }), clsx: (...values) => values.filter(Boolean).join(' '),
    resolveSubmitMode: () => 'queue', DraftEditor: 'DraftEditor', ContextMeter: 'ContextMeter',
    installDraftWheel() {}, installDraftFilePicker() {}, revealDraftSelection() {},
  };
  vm.runInNewContext(`${fragment}\nglobalThis.InputBar = InputBar;`, sandbox);
  const keyboard = { editor: null, get snapshot() { return input; }, submit(mode, origin) { sent.push({ text: input.draft, mode, origin }); input = inputState(); } };
  const props = { sessionId: 'synthetic-session', variant: 'composer', keyboard,
    inputActions: { setDraft(text) { input = { ...input, draft: text }; } },
    useInput: select => select(input), useSession: select => select(session), useProjection: key => key === 'rufaContinuation' ? continuation : undefined,
    useNotices: () => null, useBusyEnter: () => 'queue', useStopShortcut: () => [], useLexicon() {}, useMenuLauncher: () => false,
    useFileUploads: () => ({}), resolveDraftAttachments: ids => ids.map(id => ({ id, kind: 'image' })),
    rufaCurrentState: () => ({ session, continuation }), t: key => key, stop: () => { stopped++; }, renderSlot: () => null,
  };
  const walk = (node, predicate) => node && typeof node === 'object' && (predicate(node) ? node : [node.props?.children].flat(Infinity).map(child => walk(child, predicate)).find(Boolean));
  const render = () => { cursor = 0; const tree = sandbox.InputBar(props); effects.splice(0).forEach(fn => fn()); return walk(tree, node => node.type === 'button' && node.props.className === 'primary'); };
  let button = render(); assert.equal(button.props['aria-label'], '继续任务'); assert.equal(button.props.disabled, false);
  assert.equal(walk(button, node => node.type === 'path').props.d, 'M5 2.5v11L13 8Z');
  button.props.onClick(); button.props.onClick(); assert.equal(sent.length, 1); assert.equal(sent[0].text, CONTINUATION_PROMPT);
  button = render(); assert.equal(button.props.disabled, true);
  input.draft = 'new user message'; button = render(); assert.equal(button.props['aria-label'], 'input.send'); button.props.onClick(); assert.equal(sent.at(-1).text, 'new user message');
  input.attachmentIds = ['image']; button = render(); assert.equal(button.props['aria-label'], 'input.send'); assert.equal(button.props.disabled, false);
  input = inputState(); session.running = true; button = render(); assert.equal(button.props['aria-label'], 'input.stop'); button.props.onClick(); assert.equal(stopped, 1);
  session.running = false; continuation = { ...continuation, reason: 'completed', endSeq: 8 };
  button = render(); assert.equal(button.props['aria-label'], 'input.send'); assert.equal(button.props.disabled, true);
  continuation = continuationState(); session.blank = true; button = render(); assert.equal(button.props['aria-label'], 'input.send');
  session.blank = false; session.promptError = { error: { message: 'mock failure', code: 'mock' } }; render();
  button = render(); assert.equal(button.props['aria-label'], '继续任务'); assert.equal(button.props.disabled, false);
});
