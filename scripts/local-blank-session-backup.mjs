// Read-only plan and backup. Actual disposal uses the client's reviewed lifecycle.
import { DatabaseSync, backup } from 'node:sqlite';
import { readFile, readdir, realpath, mkdir, copyFile, lstat, writeFile } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { initializationOnly, emptyConversationState } from '../apps/client/src/runtime/empty-session-policy.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const key = id => `dsh.conversation.${id}`;
async function file(path, optional = true) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) throw new Error('Unexpected redirected metadata file');
    return await readFile(path, 'utf8');
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
async function load(accountHome) {
  if (!isAbsolute(accountHome)) throw new Error('Absolute account directory required');
  const home = await realpath(accountHome);
  const database = join(home, 'company-history.sqlite');
  const info = await lstat(database);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Existing history database required');
  const uiRaw = await file(join(home, 'browser-ui-state.json'), false);
  const ui = JSON.parse(uiRaw);
  if (ui.version !== 1 || !ui.entries || typeof ui.entries !== 'object' || Array.isArray(ui.entries)) throw new Error('Invalid account UI state');
  const db = new DatabaseSync(database, { readOnly: true });
  if (db.prepare('PRAGMA user_version').get().user_version !== 1) { db.close(); throw new Error('Unexpected history schema'); }
  return { home, db, uiRaw, ui };
}

export async function planLocalBlankSessions(accountHome) {
  const { home, db, ui } = await load(accountHome);
  try {
    db.exec('BEGIN');
    const records = db.prepare('SELECT * FROM sessions ORDER BY id').all();
    const candidates = [], retained = [], fingerprints = {};
    for (const row of records) {
      const events = db.prepare('SELECT seq,event FROM events WHERE session_id=? ORDER BY seq').all(row.id);
      fingerprints[row.id] = sha(JSON.stringify({ row, events }));
      let reason;
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(row.id)) reason = 'invalid-id';
      else if (row.cloud_state !== 'local' || row.synced_seq !== 0 || row.remote_seq !== 0 || row.conflict !== null) reason = 'cloud-or-conflict';
      else if (!emptyConversationState(ui.entries[key(row.id)])) reason = 'draft';
      else {
        try {
          const header = JSON.parse(row.header), parsed = events.map(event => JSON.parse(event.event));
          const record = { id: row.id, header, ready: row.ready === 1, inheritedEventCount: row.inherited };
          if (events.length !== row.event_count || events.some((event, i) => event.seq !== i)
            || !initializationOnly(record, parsed)) reason = 'content-or-unknown';
          else {
            const journalRaw = await file(join(home, 'company-pending-events', `${encodeURIComponent(row.id)}.json`));
            if (journalRaw !== null) {
              const journal = JSON.parse(journalRaw);
              if (journal.id !== row.id || journal.local !== true || journal.uploadRequested === true
                || journal.inheritedEventCount !== 0 || !isDeepStrictEqual(journal.header, header)
                || !isDeepStrictEqual(journal.events, parsed)) reason = 'pending-or-mismatched-journal';
            }
          }
        } catch { reason = 'unreadable-or-unknown'; }
      }
      if (reason) retained.push({ id: row.id, reason });
      else candidates.push({ id: row.id, eventCount: row.event_count, fingerprint: fingerprints[row.id] });
    }
    db.exec('COMMIT');
    return { version: 1, accountHome: home, createdAt: new Date().toISOString(),
      total: records.length, candidates, retained, fingerprints };
  } finally { db.close(); }
}

/** Caller first closes the desktop so cache, journals and draft mirror are quiescent. */
export async function backupLocalSessions(accountHome, directory) {
  if (!isAbsolute(directory)) throw new Error('Absolute backup directory required');
  const plan = await planLocalBlankSessions(accountHome);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const { home, db, uiRaw } = await load(plan.accountHome);
  try { await backup(db, join(directory, 'company-history.sqlite')); } finally { db.close(); }
  await writeFile(join(directory, 'browser-ui-state.json'), uiRaw, { flag: 'wx', mode: 0o600 });
  const registry = await file(join(home, 'storages', 'workspace.json'));
  if (registry !== null) await writeFile(join(directory, 'workspace.json'), registry, { flag: 'wx', mode: 0o600 });
  const journals = join(home, 'company-pending-events');
  let names = [];
  try { names = await readdir(journals); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(join(directory, 'company-pending-events'), { mode: 0o700 });
  for (const name of names) {
    if (!/^[A-Za-z0-9_%-]+\.json(?:\.pending)?$/.test(name)) throw new Error('Unexpected pending history filename');
    await file(join(journals, name), false); // Reject redirected files before copying.
    await copyFile(join(journals, name), join(directory, 'company-pending-events', name));
  }
  const verify = await planLocalBlankSessions(home);
  if (!isDeepStrictEqual(verify.fingerprints, plan.fingerprints)
    || !isDeepStrictEqual(verify.candidates, plan.candidates)
    || await file(join(home, 'browser-ui-state.json'), false) !== uiRaw) throw new Error('Account changed during backup; close the desktop and retry');
  const copy = new DatabaseSync(join(directory, 'company-history.sqlite'), { readOnly: true });
  try {
    if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed');
    if (copy.prepare('SELECT count(*) n FROM sessions').get().n !== plan.total) throw new Error('Backup record count mismatch');
  } finally { copy.close(); }
  await writeFile(join(directory, 'plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [home, directory] = process.argv.slice(2);
  const plan = directory ? await backupLocalSessions(home, directory) : await planLocalBlankSessions(home);
  console.log(JSON.stringify({ total: plan.total, candidateCount: plan.candidates.length,
    retained: plan.retained.reduce((result, row) => ({ ...result, [row.reason]: (result[row.reason] ?? 0) + 1 }), {}),
    ...(directory ? { backupDirectory: directory } : {}), candidates: plan.candidates.map(row => row.id) }));
}
