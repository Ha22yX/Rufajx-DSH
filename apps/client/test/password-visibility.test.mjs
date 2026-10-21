import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { recycleStatus } from '../src/renderer/recycle-status.mjs';
import { updatePresentation } from '../src/renderer/update-view.mjs';

const source = (await readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const html = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const unsigned = { user: null, booting: false, harness: { status: 'stopped' } };
const signed = { user: { id: 'alice', username: 'alice', displayName: '合成测试', role: 'employee' }, booting: false, harness: { status: 'running' } };

// Execute the actual renderer module and its event handlers; DOM/IPC are test doubles, not a GUI claim.
async function renderer(overrides = {}) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, {
    value: '', type: id === 'password' ? 'password' : 'text', checked: false, hidden: false, attrs: new Map(),
    setAttribute(name, value) { this.attrs.set(name, value); }, removeAttribute(name) { this.attrs.delete(name); },
    toggleAttribute(name, active) { if (active) this.attrs.set(name, ''); else this.attrs.delete(name); },
    replaceChildren() {},
  }]));
  const calls = [], events = new Map(); let onState;
  const context = vm.createContext({ recycleStatus, updatePresentation, createAdminCenter: () => ({ syncIdentity() {}, deactivate() {}, open() {} }), document: { getElementById: id => nodes.get(id), body: { classList: { toggle() {} } } },
    window: { setInterval() {}, addEventListener: (event, handler) => events.set(event, handler), rufa: {
      onState: handler => { onState = handler; },
      async call(action, input) {
        calls.push({ action, input: structuredClone(input) });
        if (overrides[action]) return overrides[action](input);
        const value = action === 'state' ? unsigned : action === 'login.saved' ? { remembered: true, username: 'alice' }
          : action === 'login.revealSavedPassword' ? { password: 'synthetic-saved-only' }
          : action === 'login' ? signed : {};
        return { ok: true, value: structuredClone(value) };
      },
    } },
  });
  vm.runInContext(source, context); await flush();
  return { nodes, calls, events, emit: value => onState(value), get: id => nodes.get(id),
    click: () => nodes.get('toggle-password').onclick(),
    input(id, value) { const node = nodes.get(id); node.value = value; node.oninput(); },
    submit() { nodes.get('login-form').onsubmit({ preventDefault() {} }); },
  };
}

test('eye toggles typed passwords without fetching or erasing hand-entered text', async () => {
  const ui = await renderer(); ui.input('password', 'synthetic-typed-only');
  await ui.click(); assert.equal(ui.get('password').type, 'text');
  assert.equal(ui.get('toggle-password').attrs.get('aria-label'), '隐藏密码');
  await ui.click(); assert.equal(ui.get('password').type, 'password');
  assert.equal(ui.get('password').value, 'synthetic-typed-only');
  assert.equal(ui.calls.filter(row => row.action === 'login.revealSavedPassword').length, 0);
});

test('saved password is lazy, discarded on hide, and submitted by its saved identity', async () => {
  const ui = await renderer();
  assert.equal(ui.get('password').value, ''); assert.equal(ui.get('password').placeholder, '••••••••');
  assert.equal(ui.calls.some(row => row.action === 'login.revealSavedPassword'), false);
  await ui.click(); assert.equal(ui.get('password').value, 'synthetic-saved-only');
  await ui.click(); assert.equal(ui.get('password').value, ''); assert.equal(ui.get('password').type, 'password');
  await ui.click(); ui.submit(); await flush();
  const request = ui.calls.find(row => row.action === 'login');
  assert.equal(request.input.password, ''); assert.equal(request.input.useSavedPassword, true);
  assert.equal(ui.get('password').value, ''); assert.equal(ui.get('password').type, 'password');
});

test('editing a revealed value gives it normal input semantics; forgetting discards unedited saved plaintext', async () => {
  const ui = await renderer(); await ui.click(); ui.input('password', 'synthetic-edited-only');
  await ui.click(); assert.equal(ui.get('password').value, 'synthetic-edited-only');
  ui.get('remember-password').checked = false; ui.get('remember-password').onchange(); await flush();
  assert.equal(ui.get('password').value, 'synthetic-edited-only');
  const other = await renderer(); await other.click(); other.get('remember-password').checked = false;
  other.get('remember-password').onchange(); await flush(); assert.equal(other.get('password').value, '');
});

test('late saved plaintext never refills a changed, hidden, submitted, or abandoned login form', async t => {
  const cases = {
    'account switched away and back': ui => { ui.input('username', 'bob'); ui.input('username', 'alice'); },
    'typed replacement': ui => ui.input('password', 'synthetic-new-input'),
    'remember disabled': ui => { ui.get('remember-password').checked = false; ui.get('remember-password').onchange(); },
    'eye clicked again': ui => ui.click(),
    'page left': ui => ui.events.get('pagehide')(),
    'login submitted': ui => ui.submit(),
    'restoring login': ui => ui.emit({ ...unsigned, booting: true }),
    'another session signed in': ui => ui.emit(signed),
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const pending = deferred(), ui = await renderer({ 'login.revealSavedPassword': () => pending.promise });
    const showing = ui.click(); await mutate(ui); await flush();
    const result = { ok: true, value: { password: 'synthetic-late-only' } }; pending.resolve(result); await showing;
    assert.notEqual(ui.get('password').value, 'synthetic-late-only');
    assert.equal(result.value.password, ''); assert.equal(ui.get('password').type, 'password');
    if (name === 'typed replacement') assert.equal(ui.get('password').value, 'synthetic-new-input');
  });
});

test('late saved metadata cannot overwrite an account the user has already typed', async () => {
  const pending = deferred(), ui = await renderer({ 'login.saved': () => pending.promise });
  ui.input('username', 'bob'); ui.input('password', 'synthetic-bob-only');
  pending.resolve({ ok: true, value: { remembered: true, username: 'alice' } }); await flush();
  assert.equal(ui.get('username').value, 'bob'); assert.equal(ui.get('password').value, 'synthetic-bob-only');
});
