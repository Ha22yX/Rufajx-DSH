// Synthetic SQLite fault injection only; never used by the server runtime.
import { SqliteStore } from '../src/sqlite-store.js';

const store = new SqliteStore(process.argv[2]);
const watchdog = setTimeout(() => process.exit(99), 15_000);
process.once('message', async (message: any) => {
  try {
    if (message.operation === 'hold') {
      store.db.exec('BEGIN IMMEDIATE');
      const deadline = new Date(Date.now() + 200).toISOString();
      if (message.expire === 'lease') store.db.prepare('UPDATE rufa_sessions SET lease_expires_at=? WHERE id=?').run(deadline, message.sessionId);
      if (message.expire === 'access') store.db.prepare('UPDATE rufa_logins SET access_expires_at=? WHERE id=?').run(deadline, message.loginId);
      process.send?.({ status: 'locked', deadline });
      setTimeout(async () => { store.db.exec('COMMIT'); await store.close(); clearTimeout(watchdog); process.disconnect(); }, 800);
      return;
    }
    if (message.phase === 'before-commit') {
      store.db.function('crash_on_second_event', () => process.exit(73));
      store.db.exec('CREATE TEMP TRIGGER crash_event BEFORE INSERT ON rufa_session_events WHEN NEW.seq=1 BEGIN SELECT crash_on_second_event(); END');
    } else {
      const execute = store.db.exec.bind(store.db);
      store.db.exec = sql => { execute(sql); if (sql === 'COMMIT') process.exit(74); };
    }
    await store.appendEvents(message.sessionId, { ...message.access, now: () => new Date().toISOString() }, message.leaseId, 0, message.events);
    process.exit(98);
  } catch { process.exit(97); }
});
process.send?.({ status: 'ready' });
