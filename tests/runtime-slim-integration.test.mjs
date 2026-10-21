import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const runtime = process.env.RUFA_RUNTIME_ROOT;

test('slim Windows x64 runtime retains real pseudoterminal start, input, resize and exit',
  { skip: !runtime || process.platform !== 'win32', timeout: 30000 }, async t => {
  const marker = JSON.parse(await readFile(join(runtime, 'rufa-runtime-slim.json'), 'utf8'));
  assert.equal(marker.state, 'complete');
  assert.equal(marker.platform, 'win32-x64');
  const require = createRequire(join(runtime, 'package.json'));
  const pty = require('node-pty');
  const cwd = await mkdtemp(join(tmpdir(), 'rufa-slim-pty-'));
  let terminal, text = '';
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native terminal did not complete')), 20000);
      terminal = pty.spawn(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/q'], {
        cwd, cols: 80, rows: 24, env: process.env, useConpty: true,
      });
      terminal.onData(data => { text += data; });
      terminal.onExit(event => { clearTimeout(timer); resolve(event.exitCode); });
      terminal.resize(104, 32);
      terminal.write('echo RUFA_SLIM_NATIVE_PTY_OK\r');
      terminal.write('exit 0\r');
    });
    assert.equal(code, 0);
    assert.match(text, /RUFA_SLIM_NATIVE_PTY_OK/);
    t.diagnostic('Real bundled node-pty x64 binary, ConPTY helper and interactive I/O passed; no model call.');
  } finally { terminal?.destroy(); }
});
