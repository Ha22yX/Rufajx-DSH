import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RememberedPasswordStore } from '../dist/remembered-login.js';
import { COMPANY_SERVER, companyEndpoint, companyProfile } from '../dist/company-config.js';

// A mock encryption provider verifies persistence contracts; the desktop smoke uses real Windows safeStorage.
function encryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
async function fixture(t, provider = encryption()) {
  const root = await mkdtemp(join(tmpdir(), 'rufa-remember-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'remembered-login.enc');
  return { path, provider, store: new RememberedPasswordStore(path, provider) };
}
test('remembered password is encrypted, survives a new store instance, and never appears in metadata', async t => {
  const { store, path, provider } = await fixture(t);
  await store.write(COMPANY_SERVER, 'alice', 'synthetic-password-only');
  const disk = await readFile(path);
  for (const value of ['synthetic-password-only', 'alice', COMPANY_SERVER]) assert.equal(disk.includes(Buffer.from(value)), false);
  const restored = new RememberedPasswordStore(path, provider);
  assert.deepEqual(await restored.info(COMPANY_SERVER), { remembered: true, username: 'alice' });
  assert.equal(await restored.passwordFor(COMPANY_SERVER, 'alice'), 'synthetic-password-only');
  assert.equal(await restored.passwordFor(COMPANY_SERVER, 'bob'), null);
  assert.equal(await restored.passwordFor('https://other.example', 'alice'), null);
  assert.deepEqual(await restored.info('https://other.example'), { remembered: false, username: '' });
});
test('opt-out is ordered after outstanding writes and removes both encrypted files', async t => {
  const { store, path } = await fixture(t);
  await Promise.all([store.write(COMPANY_SERVER, 'alice', 'synthetic-one'), store.write(COMPANY_SERVER, 'alice', 'synthetic-two'), store.clear()]);
  await assert.rejects(access(path), { code: 'ENOENT' });
  await assert.rejects(access(`${path}.pending`), { code: 'ENOENT' });
  await writeFile(`${path}.pending`, 'orphan encrypted bytes'); await store.clear();
  await assert.rejects(access(`${path}.pending`), { code: 'ENOENT' });
  assert.deepEqual(await store.info(COMPANY_SERVER), { remembered: false, username: '' });
});
test('unavailable encryption never falls back to plaintext; invalid ciphertext has a safe error and can be forgotten', async t => {
  const provider = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('should not run'); }, decryptString: () => { throw new Error('should not run'); } };
  const { path, store } = await fixture(t, provider);
  await assert.rejects(store.write(COMPANY_SERVER, 'alice', 'synthetic-secret'));
  await assert.rejects(access(path), { code: 'ENOENT' });
  await writeFile(path, 'synthetic-sensitive-invalid-ciphertext');
  const corrupt = new RememberedPasswordStore(path, encryption());
  await assert.rejects(corrupt.info(COMPANY_SERVER), error => !error.message.includes('synthetic-sensitive'));
  await corrupt.clear(); assert.equal(await corrupt.passwordFor(COMPANY_SERVER, 'alice'), null);
});
test('ordinary development and packaged clients always select the fixed company endpoint', () => {
  assert.deepEqual(companyEndpoint(false), { server: COMPANY_SERVER, allowLocalHttp: false });
  assert.deepEqual(companyEndpoint(false, undefined, 'http://localhost:1234'), { server: COMPANY_SERVER, allowLocalHttp: false });
  assert.deepEqual(companyEndpoint(true, 'C:\\isolated', 'http://localhost:1234'), { server: COMPANY_SERVER, allowLocalHttp: false });
  assert.deepEqual(companyEndpoint(false, 'C:\\isolated', 'http://127.0.0.1:1234'), { server: 'http://127.0.0.1:1234', allowLocalHttp: true });
  for (const server of ['https://outside.example', 'http://localhost.evil.example', 'http://localhost:1234/path']) assert.throws(() => companyEndpoint(false, 'C:\\isolated', server));
});
test('isolated profiles cannot overlap production credentials through case or relative path normalization', () => {
  const production = 'C:\\Users\\test\\AppData\\Roaming\\RufaDSH';
  for (const input of [production, production.toUpperCase(), `${production}\\child`, `${production}\\..\\RufaDSH`, 'relative', '\\rooted', 'C:\\Users\\test\\AppData\\Roaming']) {
    assert.throws(() => companyProfile(production, false, input), { code: 'INVALID_TEST_PROFILE' });
  }
  assert.deepEqual(companyProfile(production, false, 'C:\\Temp\\isolated'), { userRoot: 'C:\\Temp\\isolated', isolatedTestProfile: 'C:\\Temp\\isolated' });
  assert.deepEqual(companyProfile(production, true, 'relative'), { userRoot: production });
});
