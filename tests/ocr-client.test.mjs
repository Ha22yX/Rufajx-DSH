import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { patchOcrClientSource } from '../scripts/preinstalled-runtime.mjs';

test('actual OCR client cancels every drag exit and edits native reference spans without flattening other attachments', { skip: !process.env.RUFA_RUNTIME_ROOT }, async () => {
  const source = patchOcrClientSource(await readFile(join(process.env.RUFA_RUNTIME_ROOT, 'node_modules/dsh-file-upload-ocr-plugin/lib/client.js'), 'utf8'));
  class DomTarget extends EventTarget {
    addEventListener(type, listener, options) { super.addEventListener(type, listener, { capture: options === true }); }
    removeEventListener(type, listener, options) { super.removeEventListener(type, listener, { capture: options === true }); }
  }
  const window = new DomTarget(), document = new DomTarget();
  document.querySelector = () => null;
  document.createElement = () => ({ dataset: {} });
  document.head = { appendChild() {} };
  document.body = {};
  const states = [], effects = [], slots = new Map(), calls = [];
  let snapshot = { draft: '', occurrences: [], draftRev: 1, phase: 'plain' };
  const input = { state: { getSnapshot: () => snapshot }, setDraft: () => { throw new Error('Must not flatten the semantic draft'); } };
  const actx = { bail: (_ctx, name, payload) => { calls.push({ name, payload }); return true; } };
  const ctx = { effect: fn => fn(), inputTriggers: { registerSource() {} }, sessions: { scope: () => actx }, conversation: { input: { for: () => input } },
    slots: { inject: (_name, fn) => fn(), register: (spec, component) => { slots.set(spec.id ?? spec.key, { spec, component }); } } };
  const react = { memo: fn => fn, useRef: current => ({ current }), useState: initial => { const index = states.push(initial) - 1; return [initial, value => { states[index] = value; }]; }, useEffect: fn => effects.push(fn) };
  const jsx = (type, props) => ({ type, props });
  window.__ModuleLoader__ = { load: ({ factory }) => factory(name => ({ react, 'react/jsx-runtime': { jsx, jsxs: jsx } })[name] ?? {}).apply(ctx) };
  vm.runInNewContext(source, { window, document, crypto: webcrypto, setTimeout, clearTimeout, console });
  const uploadControl = slots.get('file-input').component({ attach() {} });
  assert.ok(!JSON.stringify(uploadControl).includes('添加文件 / Add file'), 'Duplicate upload button must not render');
  assert.ok(JSON.stringify(uploadControl).includes('"type":"file"'), 'Mounted input and drop handling are retained');
  const disposers = effects.map(fn => fn());
  const dispatch = (target, type, properties = {}) => { const event = new Event(type, { cancelable: true }); Object.assign(event, properties); target.dispatchEvent(event); };
  const exits = [
    [document, 'drop', { dataTransfer: { types: [], files: [] } }],
    [document, 'keydown', { key: 'Escape' }], [window, 'blur'], [window, 'pagehide'],
    [document, 'visibilitychange'], [document, 'pointerdown'], [window, 'dragend'],
    [document, 'dragleave', { dataTransfer: { types: [] } }],
  ];
  for (const [target, type, properties] of exits) {
    dispatch(document, 'dragenter', { dataTransfer: { types: ['Files'] } }); assert.equal(states[1], true);
    dispatch(target, type, properties); assert.equal(states[1], false, type);
  }
  for (const dispose of disposers) dispose?.();
  dispatch(document, 'dragenter', { dataTransfer: { types: ['Files'] } }); assert.equal(states[1], false, 'Unmount must release drag listeners');

  snapshot = { draft: '/plan [first] [second] ', occurrences: [
    { source: 'file-attachment', ref: 'a', offset: 6, length: 7 },
    { source: 'file-attachment', ref: 'b', offset: 14, length: 8 },
  ], claim: { token: '/plan ' }, draftRev: 42, phase: 'claimed' };
  slots.get('file-input').spec.inject('session').attach({ name: 'third.txt', size: 3 }, { kind: 'text', text: 'abc' });
  assert.equal(calls.at(-1).payload.span.start, 6, 'End offset must account for command and two expanded references');
  slots.get('file-attachments').spec.inject('session').remove('b');
  assert.equal(calls.at(-1).name, 'slash/input-insert-text');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).payload)), { text: '', span: { start: 4, end: 5, draftRev: 42 } });
  snapshot = { ...snapshot, phase: 'submitting' };
  const before = calls.length; slots.get('file-attachments').spec.inject('session').remove('a'); assert.equal(calls.length, before);

  const message = slots.get('user').component({ node: { data: { content: [
    { type: 'text', text: '请分析这份文件' },
    { type: 'file', attachment: { name: 'report.pdf', bytes: 2048, attachmentId: 'sha256:internal-reference' } },
    { type: 'file', attachment: { name: 'budget.xlsx', bytes: 4096, attachmentId: 'sha256:second-reference' } },
  ] } } });
  const rendered = JSON.stringify(message.type(message.props));
  assert.ok(rendered.includes('report.pdf') && rendered.includes('budget.xlsx') && rendered.includes('请分析这份文件'));
  assert.ok(rendered.indexOf('report.pdf') < rendered.indexOf('budget.xlsx'), 'Native file order is preserved');
  assert.ok(!rendered.includes('internal-reference') && !rendered.includes('"type":"pre"'), 'Native attachments must not become raw protocol JSON');
});
