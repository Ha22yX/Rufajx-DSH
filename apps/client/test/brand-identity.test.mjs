import test from 'node:test';
import assert from 'node:assert/strict';
import { publicCompanyUser, apply } from '../src/runtime/brand/index.mjs';

test('brand bootstrap publishes only actual company identity fields, never credentials', async () => {
  const account = { id: 'internal-id', username: 'employee-a', displayName: '同事甲', role: 'employee', accessToken: 'synthetic-secret', password: 'synthetic-password' };
  assert.deepEqual(publicCompanyUser(account), { username: 'employee-a', displayName: '同事甲', jobTitle: '', role: 'employee' });
  assert.equal(publicCompanyUser({ ...account, jobTitle: '工程师' }).jobTitle, '工程师');
  assert.equal(publicCompanyUser({ username: 'unknown', role: 'superadmin' }), null);
  let collect;
  await apply({ inject() {}, on(event, fn) { assert.equal(event, 'webserver/index-inject'); collect = fn; } }, { user: account });
  const injections = []; collect(injections);
  assert.deepEqual(injections.find(row => row.kind === 'global').value, publicCompanyUser(account));
  assert.equal(JSON.stringify(injections).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(injections).includes('synthetic-password'), false);
});
