import type { SessionAccess } from '../src/store.js';
import type { Login } from '../src/types.js';

export function sessionAccess(login: Login, clock?: string | (() => string)): SessionAccess {
  return { userId: login.userId, loginId: login.id, accessHash: login.accessHash,
    now: typeof clock === 'function' ? clock : () => clock ?? new Date().toISOString() };
}
