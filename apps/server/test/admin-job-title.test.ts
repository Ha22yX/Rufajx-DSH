import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { hashPassword } from '../src/security.js';
import { SqliteStore } from '../src/sqlite-store.js';
import type { Store } from '../src/store.js';
import type { ManagedUser } from '../src/types.js';
import { MemoryStore } from './memory-store.js';

const password = 'admin-job-title-test-2026';
const passwordHash = await hashPassword(password);
const baseUrl = '/api/v1/admin/users';
type Credentials = { accessToken: string; user: { id: string; jobTitle: string } };
const headers = (credentials: Credentials) => ({ authorization: `Bearer ${credentials.accessToken}` });

async function fixture(t: TestContext, backend: 'memory' | 'sqlite') {
  const directory = backend === 'sqlite' ? await mkdtemp(join(tmpdir(), 'rufa-admin-job-title-')) : undefined;
  const store = directory ? new SqliteStore(join(directory, 'company.sqlite')) : new MemoryStore();
  const stores: Store[] = [store];
  const apps: ReturnType<typeof buildApp>[] = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    for (const opened of stores) await opened.close();
    if (directory) {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('rufa-admin-job-title-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
  const admin = await store.createUser({ username: 'manager', displayName: '管理姓名', role: 'admin', passwordHash });
  const employee = await store.createUser({ username: 'employee', displayName: '员工原姓名', jobTitle: '员工原职位', role: 'employee', passwordHash });
  const app = buildApp(store, configFromEnv({})); apps.push(app);
  const login = async (username: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<Credentials>();
  };
  const manager = await login('manager'), employeeLogin = await login('employee');
  const create = (payload: Record<string, unknown>, credentials = manager) => app.inject({ method: 'POST', url: baseUrl, headers: headers(credentials),
    payload: { username: 'job-person', displayName: '职位测试账号', role: 'employee', password, ...payload } });
  const change = (payload: Record<string, unknown>, id = employee.id, credentials = manager) => app.inject({ method: 'PATCH', url: `${baseUrl}/${id}`, headers: headers(credentials), payload });
  const audits = () => store instanceof MemoryStore ? store.audits : store.db.prepare('SELECT * FROM rufa_audit').all();
  return { store, stores, app, apps, admin, employee, manager, employeeLogin, login, create, change, audits };
}

for (const backend of ['memory', 'sqlite'] as const) {
  test(`${backend}: admin jobTitle supports create, trim, omission and clear in public and managed outputs`, async t => {
    const f = await fixture(t, backend);
    const created = await f.create({ displayName: 'Jack Ma 测试账号', jobTitle: '  研发测试职位  ' });
    assert.equal(created.statusCode, 201, created.body);
    const user = created.json<{ user: ManagedUser }>().user;
    assert.equal(user.jobTitle, '研发测试职位');
    assert.ok(!Object.hasOwn(user, 'passwordHash'));
    const initialPasswordHash = (await f.store.findUser(user.username))!.passwordHash;
    const employee = await f.login(user.username);
    assert.equal(employee.user.jobTitle, user.jobTitle);
    for (const payload of [{ username: 'without-title' }, { username: 'empty-title', jobTitle: '' }]) {
      const emptyCreated = await f.create(payload);
      assert.equal(emptyCreated.statusCode, 201); assert.equal(emptyCreated.json().user.jobTitle, '');
    }

    const renamed = await f.change({ displayName: '改名后仍保留职位' }, user.id);
    assert.equal(renamed.statusCode, 200, renamed.body); assert.equal(renamed.json().user.jobTitle, user.jobTitle);
    const updated = await f.change({ jobTitle: '  研发负责人测试职位  ' }, user.id);
    assert.equal(updated.statusCode, 200, updated.body); assert.equal(updated.json().user.jobTitle, '研发负责人测试职位');
    const me = await f.app.inject({ url: '/api/v1/auth/me', headers: headers(employee) });
    assert.equal(me.statusCode, 200); assert.equal(me.json().user.jobTitle, updated.json().user.jobTitle);
    const list = await f.app.inject({ url: baseUrl, headers: headers(f.manager) });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().users.find((row: ManagedUser) => row.id === user.id).jobTitle, updated.json().user.jobTitle);
    assert.equal((await f.store.findUser(user.username))!.passwordHash, initialPasswordHash);

    for (const empty of ['', '  \t  ']) {
      const cleared = await f.change({ jobTitle: empty }, user.id);
      assert.equal(cleared.statusCode, 200); assert.equal(cleared.json().user.jobTitle, '');
    }
    const auditText = JSON.stringify(f.audits());
    for (const value of ['Jack Ma 测试账号', '研发测试职位', '研发负责人测试职位', password, employee.accessToken]) assert.ok(!auditText.includes(value));
    assert.equal(f.audits().filter(row => row.action === 'admin.user.create').length, 3);
    assert.equal(f.audits().filter(row => row.action === 'admin.user.update').length, 4);
  });

  test(`${backend}: admin jobTitle enforces raw 100-character boundary and rejects invalid values without partial writes`, async t => {
    const f = await fixture(t, backend);
    const boundary = '职'.repeat(100);
    const created = await f.create({ jobTitle: boundary });
    assert.equal(created.statusCode, 201); assert.equal(created.json().user.jobTitle, boundary);
    const updated = await f.change({ jobTitle: boundary });
    assert.equal(updated.statusCode, 200); assert.equal(updated.json().user.jobTitle, boundary);
    const before = await f.store.findUser('employee');
    for (const value of [null, 12, false, [], {}, '职'.repeat(101), ' '.repeat(101), ` ${boundary}`]) {
      const create = await f.create({ username: 'invalid-title', jobTitle: value });
      assert.equal(create.statusCode, 400, create.body); assert.equal(create.json().error.code, 'INVALID_REQUEST');
      const change = await f.change({ displayName: '不能部分保存', role: 'admin', jobTitle: value });
      assert.equal(change.statusCode, 400, change.body); assert.equal(change.json().error.code, 'INVALID_REQUEST');
    }
    assert.equal(await f.store.findUser('invalid-title'), undefined);
    assert.deepEqual(await f.store.findUser('employee'), before);
    assert.equal((await f.change({})).statusCode, 400);
    assert.equal(f.audits().filter(row => row.action === 'admin.user.create').length, 1);
    assert.equal(f.audits().filter(row => row.action === 'admin.user.update').length, 1);
  });

  test(`${backend}: admin jobTitle preserves employee isolation, last-admin protection and deleted-account restrictions`, async t => {
    const f = await fixture(t, backend);
    assert.equal((await f.create({ jobTitle: '越权职位' }, f.employeeLogin)).statusCode, 403);
    assert.equal((await f.change({ jobTitle: '越权职位' }, f.employee.id, f.employeeLogin)).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'PATCH', url: `${baseUrl}/${f.employee.id}`, payload: { jobTitle: '未登录职位' } })).statusCode, 401);
    const protectedAdmin = await f.change({ role: 'employee', jobTitle: '不能部分保存' }, f.admin.id);
    assert.equal(protectedAdmin.statusCode, 409); assert.equal(protectedAdmin.json().error.code, 'LAST_ADMIN');
    assert.deepEqual(await f.store.findUser('manager'), f.admin);
    const remove = await f.app.inject({ method: 'DELETE', url: `${baseUrl}/${f.employee.id}`, headers: headers(f.manager) });
    assert.equal(remove.statusCode, 204);
    assert.equal((await f.change({ jobTitle: '回收站拒绝编辑' })).statusCode, 404);
    const deleted = (await f.store.findUser('employee'))!;
    assert.equal(deleted.jobTitle, f.employee.jobTitle);
    await f.store.purgeExpiredUsers(deleted.purgeAfter!);
    assert.equal((await f.change({ jobTitle: '归档拒绝编辑' })).statusCode, 404);
    assert.equal((await f.store.findUser('employee'))!.jobTitle, '');
    await f.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers(f.manager) });
    assert.equal((await f.create({ jobTitle: '已注销管理' })).statusCode, 401);
    assert.equal((await f.change({ jobTitle: '已注销管理' }, f.admin.id)).statusCode, 401);
    assert.equal(f.audits().filter(row => row.action === 'admin.user.update').length, 0);
  });
}

test('SQLite admin jobTitle creates and updates persist across reopen; failed writes leave no partial changes', async t => {
  const f = await fixture(t, 'sqlite'); const store = f.store as SqliteStore;
  const created = await f.create({ jobTitle: '创建持久职位' });
  assert.equal(created.statusCode, 201);
  const update = await f.change({ jobTitle: '修改持久职位' });
  assert.equal(update.statusCode, 200);
  const before = await store.findUser('employee');
  store.db.exec("CREATE TRIGGER reject_job_update BEFORE UPDATE OF job_title ON rufa_users WHEN NEW.job_title='模拟写失败' BEGIN SELECT RAISE(ABORT,'test write failure'); END");
  const failed = await f.change({ displayName: '不能部分保存', jobTitle: '模拟写失败', role: 'admin', status: 'disabled' });
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(await store.findUser('employee'), before);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(f.employeeLogin) })).statusCode, 200);
  store.db.exec('DROP TRIGGER reject_job_update');
  store.db.exec("CREATE TRIGGER reject_job_create BEFORE INSERT ON rufa_users WHEN NEW.job_title='模拟写失败' BEGIN SELECT RAISE(ABORT,'test write failure'); END");
  assert.equal((await f.create({ username: 'failed-create', jobTitle: '模拟写失败' })).statusCode, 500);
  assert.equal(await store.findUser('failed-create'), undefined);
  store.db.exec('DROP TRIGGER reject_job_create');
  await f.app.close(); await store.close();
  const reopened = new SqliteStore(store.path); f.stores.push(reopened);
  const app = buildApp(reopened, configFromEnv({})); f.apps.push(app);
  assert.equal((await reopened.findUser('job-person'))!.jobTitle, '创建持久职位');
  assert.equal((await reopened.findUser('employee'))!.jobTitle, '修改持久职位');
  const me = await app.inject({ url: '/api/v1/auth/me', headers: headers(f.employeeLogin) });
  assert.equal(me.statusCode, 200); assert.equal(me.json().user.jobTitle, '修改持久职位');
  assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM rufa_audit WHERE action='admin.user.create'").get()!.n, 1);
  assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM rufa_audit WHERE action='admin.user.update'").get()!.n, 1);
  assert.equal(reopened.db.prepare('PRAGMA user_version').get()!.user_version, 4);
});
