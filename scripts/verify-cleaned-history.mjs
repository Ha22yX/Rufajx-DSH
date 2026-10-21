// Read-only verification of the final, reviewed permission-only cleanup.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { planLocalBlankSessions } from './local-blank-session-backup.mjs';
import { TARGET } from './cleanup-legacy-local-session.mjs';

const directory = process.argv[2];
assert.ok(directory, 'Reviewed backup directory is required');
const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'));
const receipt = JSON.parse(await readFile(join(directory, 'cloud-result-final.json'), 'utf8'));
assert.equal(receipt.status, 'complete');
assert.equal(receipt.targetId, TARGET);
assert.equal(receipt.targetAbsent, true);
const expected = { ...plan.fingerprints };
assert.ok(expected[TARGET]);
delete expected[TARGET];
const current = await planLocalBlankSessions(plan.accountHome);
assert.deepEqual(Object.keys(current.fingerprints), Object.keys(expected), 'Only the reviewed target may disappear');
const saved = new DatabaseSync(join(directory, 'company-history.sqlite'), { readOnly: true });
const live = new DatabaseSync(join(plan.accountHome, 'company-history.sqlite'), { readOnly: true });
let syncCheckpointsAdvanced = 0;
try {
  for (const [id, fingerprint] of Object.entries(expected)) {
    const before = saved.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    const row = live.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    // Reopening may acknowledge previously uploaded events. It must never
    // rewrite the header, event payload, or any other retained row metadata.
    let advanced = false;
    for (const field of ['synced_seq', 'remote_seq']) {
      assert.ok(Number.isSafeInteger(row[field]) && row[field] >= before[field] && row[field] <= row.event_count);
      advanced ||= row[field] !== before[field];
      row[field] = before[field];
    }
    syncCheckpointsAdvanced += Number(advanced);
    const events = live.prepare('SELECT seq,event FROM events WHERE session_id=? ORDER BY seq').all(id);
    assert.equal(createHash('sha256').update(JSON.stringify({ row, events })).digest('hex'), fingerprint,
      'Retained header, complete event log and non-sync metadata must remain identical');
  }
} finally { saved.close(); live.close(); }
assert.equal(current.candidates.length, 0, 'No initialization-only local sessions remain');
console.log(JSON.stringify({ retained: current.total, fullHistoryUnchanged: true, syncCheckpointsAdvanced, removedTargetAbsent: true, localEmptySessions: 0 }));
