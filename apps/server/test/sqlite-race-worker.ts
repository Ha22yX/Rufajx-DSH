// Isolated process used only by SQLite concurrency tests.
import { SqliteStore } from '../src/sqlite-store.js';
import { AppError } from '../src/types.js';

const store = new SqliteStore(process.argv[2]);
process.once('message', async (message: any) => {
  try {
    if (message.operation === 'disable') await store.updateUser(message.userId, { status: 'disabled' });
    else if (message.operation === 'change-password') await store.changePassword(message.change);
    else if (message.operation === 'profile') await store.updateProfile(message.change);
    else if (message.operation === 'preferences') await store.mutatePreferences({ ...message.access, now: () => new Date().toISOString() }, message.mutation);
    else if (message.operation === 'revoke') await store.revokeLogin(message.loginId);
    else if (message.operation === 'restore') await store.restoreUser(message.change);
    else if (message.operation === 'purge') await store.purgeExpiredUsers(message.now);
    else if (message.operation === 'append') await store.appendEvents(message.sessionId, { ...message.access, now: () => new Date().toISOString() }, message.leaseId, 0, [{ seq: 0, event: { type: 'user/message', text: message.text } }]);
    else throw new Error('Unknown worker operation');
    process.send?.({ status: 'ok' });
  } catch (error) { process.send?.({ status: 'error', code: error instanceof AppError ? error.code : 'UNEXPECTED' }); }
  finally { await store.close(); process.disconnect(); }
});
process.send?.({ status: 'ready' });
