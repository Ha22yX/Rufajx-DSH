import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileVersionIpc } from '../src/runtime/file-versions.mjs';
const settle = () => new Promise(done => setImmediate(done));
function channel() { const value = new EventEmitter(); value.connected = true; value.sent = []; value.send = (message, callback) => { value.sent.push(message); callback?.(); }; return value; }

test('runtime private restore checks bind request and check IDs, then cancellation reaches in-flight guard', async () => {
  const wire = channel(); let guard, signal, published = false;
  const close = fileVersionIpc({ async request(_action, _input, context) {
    signal = context.signal; guard = context.confirm; await guard(); signal.throwIfAborted(); await guard(); published = true;
  } }, wire);
  wire.emit('message', { type: 'rufa:file-versions', requestId: 'request-a', action: 'restore' }); await settle();
  const first = wire.sent.at(-1);
  wire.emit('message', { type: 'rufa:file-versions-confirm', requestId: 'wrong-request', checkId: first.checkId, allowed: true }); await settle();
  assert.equal(wire.sent.length, 1);
  wire.emit('message', { type: 'rufa:file-versions-confirm', requestId: 'request-a', checkId: first.checkId, allowed: true }); await settle();
  const second = wire.sent.at(-1); assert.notEqual(first.checkId, second.checkId);
  wire.emit('message', { type: 'rufa:file-versions-cancel', requestId: 'request-a' }); await settle();
  assert.equal(signal.aborted, true); assert.equal(published, false); assert.equal(wire.sent.at(-1).ok, false);
  wire.emit('message', { type: 'rufa:file-versions-confirm', requestId: 'request-a', checkId: second.checkId, allowed: true });
  await close(); assert.equal(published, false);
});

test('shutdown and disconnect cancel pending runtime requests before disposal waits', async () => {
  for (const reason of ['shutdown', 'disconnect']) {
    const wire = channel(); let signal;
    const close = fileVersionIpc({ async request(_action, _input, context) { signal = context.signal; await context.confirm(); } }, wire);
    wire.emit('message', { type: 'rufa:file-versions', requestId: 'pending-request', action: 'restore' }); await settle();
    if (reason === 'shutdown') wire.emit('message', { type: 'rufa:shutdown' }); else wire.emit('disconnect');
    await close(); assert.equal(signal.aborted, true); assert.equal(wire.listenerCount('message'), 0);
  }
});
