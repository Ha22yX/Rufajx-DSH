import test from 'node:test';
import assert from 'node:assert/strict';


import { recycleStatus } from '../src/renderer/recycle-status.mjs';

test('recycle presentation separates accounts, restorable items and permanent chat archives at the exact deadline', () => {
  const now = Date.parse('2026-10-19T12:00:00Z'), future = new Date(now + 7 * 86400000).toISOString();
  assert.equal(recycleStatus({ status: 'active' }, now).group, 'accounts');
  assert.equal(recycleStatus({ status: 'disabled' }, now).group, 'accounts');
  const deleted = { status: 'deleted', purgeAfter: future, purgedAt: null };
  assert.equal(recycleStatus(deleted, now).recoverable, true); assert.match(recycleStatus(deleted, now).remaining, /7 天/);
  assert.equal(recycleStatus(deleted, Date.parse(future)).recoverable, false);
  assert.equal(recycleStatus({ ...deleted, purgedAt: future }, now).group, 'archive');
  assert.equal(recycleStatus({ ...deleted, purgeAfter: 'invalid' }, now).recoverable, false);
  assert.equal(recycleStatus({ status: 'deleted' }, now).recoverable, false);
});

// Account-tab filtering, restore confirmation and archived read access are covered by
// admin-center-ui.test.mjs against the real Electron DOM and new management module.
