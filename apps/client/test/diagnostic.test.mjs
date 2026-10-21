import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { createDiagnosticWriter, protectDiagnostic } from '../dist/diagnostic.js';

test('diagnostics write normally while the output is connected', async () => {
  let output = '';
  const stream = new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } });
  createDiagnosticWriter(stream)('runtime exit: 0 null\n');
  await tick();
  assert.equal(output, 'runtime exit: 0 null\n');
  stream.destroy();
});

test('asynchronous EPIPE is contained and later IPC/exit diagnostics are ignored', async () => {
  let writes = 0;
  const stream = new Writable({ write(chunk, encoding, callback) {
    writes++;
    setImmediate(() => callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })));
  } });
  const diagnostic = createDiagnosticWriter(stream);
  diagnostic('runtime stderr\n');
  await tick(); await tick();
  assert.doesNotThrow(() => diagnostic('runtime IPC: rufa:persistence-flushed true\n'));
  assert.doesNotThrow(() => diagnostic('runtime exit: 0 null\n'));
  assert.equal(writes, 1);
});

test('synchronous pipe failure and closed stream cannot escape the diagnostic sink', async () => {
  const stream = new Writable({ write(chunk, encoding, callback) { callback(); } });
  let writes = 0;
  stream.write = () => { writes++; throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' }); };
  const diagnostic = createDiagnosticWriter(stream);
  assert.doesNotThrow(() => diagnostic('first'));
  assert.doesNotThrow(() => diagnostic('second'));
  assert.equal(writes, 1);
  stream.destroy(); await tick();
  assert.doesNotThrow(() => createDiagnosticWriter(stream)('closed'));
  assert.equal(writes, 1);
});

test('a throwing optional diagnostic callback cannot break runtime lifecycle', () => {
  let calls = 0;
  const diagnostic = protectDiagnostic(() => { calls++; throw new Error('sink unavailable'); });
  assert.doesNotThrow(() => diagnostic('runtime IPC'));
  assert.doesNotThrow(() => diagnostic('runtime exit'));
  assert.equal(calls, 1);
  assert.doesNotThrow(() => protectDiagnostic()('disabled'));
});
