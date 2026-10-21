// Run only after a reviewed local-blank-session backup, against the dev desktop.
// Deletion occurs through the same navigation lifecycle as normal user actions.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { planLocalBlankSessions } from './local-blank-session-backup.mjs';

const plan = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.equal(plan.version, 1);
const pages = await (await fetch('http://127.0.0.1:9337/json/list')).json(), sockets = [];
async function connect(page) {
  assert.ok(page, 'Expected development page');
  const ws = new WebSocket(page.webSocketDebuggerUrl); sockets.push(ws);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let serial = 0; const pending = new Map();
  ws.addEventListener('message', event => { const value = JSON.parse(event.data), waiter = pending.get(value.id); if (waiter) { clearTimeout(waiter.timer); pending.delete(value.id); value.error ? waiter.reject(new Error(value.error.message)) : waiter.resolve(value.result); } });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error('Desktop check timed out')); }, 10000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  return async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, 'Desktop operation failed');
    return result.result.value;
  };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await fn()) return; await pause(100); }
  throw new Error(`Timed out: ${description}`);
}
try {
  const shell = await connect(pages.find(page => page.type === 'page' && page.url.endsWith('/renderer/index.html')));
  const ui = await connect(pages.find(page => page.type === 'page' && page.url.startsWith('http://127.0.0.1:')));
  const checkAccount = async () => {
    const state = await shell('window.rufa.call("state").then(r=>({development:r.value.development,userId:r.value.user?.id,server:r.value.serverUrl,harness:r.value.harness.status}))');
    assert.ok(state.development && state.userId && state.server && state.harness === 'running');
    assert.equal(createHash('sha256').update(`${state.server}:${state.userId}`).digest('hex'), basename(plan.accountHome), 'Current account must match the reviewed backup');
  };
  await checkAccount();
  const target = await ui('JSON.parse(localStorage.getItem("dsh.sessions.current")||"{}").sessionId');
  assert.ok(plan.retained.some(row => row.id === target), 'Keep a real existing conversation selected as the return target');
  assert.equal(await ui('[...document.querySelectorAll("button")].some(e=>/^(停止|停止生成|Stop|Stop generation)$/.test((e.getAttribute("aria-label")||e.textContent).trim()))'), false, 'No running task');
  assert.equal(await ui('[...document.querySelectorAll("[contenteditable=true],textarea")].some(e=>(e.value||e.textContent||"").trim().length>0)'), false, 'No draft in the active editor');
  const expanded = await ui('[...document.querySelectorAll("[data-rufa-project-id] [data-row-key][aria-expanded=true]")].map(e=>e.closest("[data-rufa-project-id]").dataset.rufaProjectId)');
  await ui('document.querySelectorAll("[data-rufa-project-id] [data-row-key][aria-expanded=false]").forEach(e=>e.click())');
  const removed = [], skipped = [];
  for (const candidate of plan.candidates) {
    await checkAccount();
    const now = await planLocalBlankSessions(plan.accountHome), current = now.candidates.find(row => row.id === candidate.id);
    if (!Object.hasOwn(now.fingerprints, candidate.id)) { removed.push(candidate.id); continue; }
    if (!current || current.fingerprint !== candidate.fingerprint) { skipped.push({ id: candidate.id, reason: 'changed-since-backup' }); continue; }
    const selector = `[data-rufa-session-id="${candidate.id}"]`;
    if (!await ui(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) { skipped.push({ id: candidate.id, reason: 'not-visible' }); continue; }
    await ui(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await until(() => ui(`Boolean(document.querySelector('[data-conversation-session="${candidate.id}"] [contenteditable=true]'))`), 'blank conversation open');
    const empty = await ui('document.querySelector("[contenteditable=true]").textContent.trim()===""&&!document.querySelector("[data-composer-chip]")');
    assert.equal(empty, true, 'Reviewed blank acquired content; stop cleanup');
    assert.ok(await ui(`Boolean(document.querySelector('[data-rufa-session-id="${target}"]'))`), 'Return target remains available');
    await ui(`document.querySelector('[data-rufa-session-id="${target}"]').click()`);
    await until(async () => !Object.hasOwn((await planLocalBlankSessions(plan.accountHome)).fingerprints, candidate.id), 'normal navigation discarded empty record');
    await until(() => ui(`localStorage.getItem('dsh.conversation.${candidate.id}')===null`), 'discarded draft state cleared');
    const journalExists = await stat(join(plan.accountHome, 'company-pending-events', `${candidate.id}.json`)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    assert.equal(journalExists, false, 'Discarded journal must not return on restart');
    removed.push(candidate.id);
  }
  await ui(`document.querySelectorAll('[data-rufa-project-id] [data-row-key][aria-expanded=true]').forEach(e=>{if(!${JSON.stringify(expanded)}.includes(e.closest('[data-rufa-project-id]').dataset.rufaProjectId))e.click()})`);
  const after = await planLocalBlankSessions(plan.accountHome);
  for (const row of plan.retained) assert.equal(after.fingerprints[row.id], plan.fingerprints[row.id], 'A retained conversation must remain byte-for-byte unchanged');
  for (const id of removed) {
    await until(() => ui(`localStorage.getItem('dsh.conversation.${id}')===null`), 'removed draft remains absent');
    const mirror = JSON.parse(await readFile(join(plan.accountHome, 'browser-ui-state.json'), 'utf8'));
    assert.equal(mirror.entries[`dsh.conversation.${id}`], undefined, 'Removed draft mirror must remain absent');
    assert.equal(await stat(join(plan.accountHome, 'company-pending-events', `${id}.json`)).then(() => true, error => {
      if (error.code === 'ENOENT') return false; throw error;
    }), false, 'Removed journal must remain absent');
  }
  console.log(JSON.stringify({ removedCount: removed.length, remaining: after.total, remainingBlank: after.candidates.length, retainedVerified: plan.retained.length, skipped }));
} finally { sockets.forEach(ws => ws.close()); }
