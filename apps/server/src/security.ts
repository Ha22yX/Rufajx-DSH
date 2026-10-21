import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { invalid } from './types.js';

const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});
export function validatePassword(password: unknown, minimum: 10 | 12 = 12): asserts password is string {
  if (typeof password !== 'string' || password.length < minimum || password.length > 128) throw invalid(`密码必须为${minimum}至128个字符`);
}
export async function hashPassword(password: string, minimum: 10 | 12 = 12): Promise<string> {
  validatePassword(password, minimum);
  const salt = randomBytes(24).toString('hex');
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
// Invalid usernames still pay the same KDF cost as known users.
const dummyHash = `scrypt-v1$${'00'.repeat(24)}$${'00'.repeat(64)}`;
export async function verifyPassword(password: string, encoded: string | undefined): Promise<boolean> {
  const [algorithm, salt, expected] = (encoded ?? dummyHash).split('$');
  if (algorithm !== 'scrypt-v1' || !/^[a-f0-9]{48}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(expected ?? '')) return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex')) && encoded !== undefined;
}
export const makeToken = () => randomBytes(48).toString('base64url');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
export const eventDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') throw invalid('账号格式无效');
  const username = value.normalize('NFKC').trim().toLowerCase();
  if (username.length < 2 || username.length > 64 || !/^[\p{L}\p{N}_.@-]+$/u.test(username)) throw invalid('账号须为2至64个字母、数字、汉字或_.@-');
  return username;
}
