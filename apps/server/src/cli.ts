import { hashPassword, normalizeUsername } from './security.js';
import { openDatabase } from './database.js';
import { SqliteStore } from './sqlite-store.js';

async function main() {
  const { store } = await openDatabase();
  try {
    if (process.argv[2] === 'migrate') { console.log('Database migration complete.'); }
    else if (process.argv[2] === 'backup') {
      if (!(store instanceof SqliteStore)) throw new Error('Use the PostgreSQL backup tools for the optional postgres driver');
      const destination = process.argv[3] ?? process.env.RUFA_BACKUP_PATH;
      if (!destination) throw new Error('Backup destination required');
      await store.backupTo(destination); console.log('Consistent SQLite backup complete.');
    }
    else if (process.argv[2] === 'bootstrap-admin') {
      const username = normalizeUsername(process.env.RUFA_BOOTSTRAP_USERNAME);
      const password = process.env.RUFA_BOOTSTRAP_PASSWORD;
      if (!password) throw new Error('Bootstrap password required');
      delete process.env.RUFA_BOOTSTRAP_PASSWORD;
      const passwordHash = await hashPassword(password);
      const user = await store.createUser({ username, displayName: process.env.RUFA_BOOTSTRAP_DISPLAY_NAME ?? username, role: 'admin', passwordHash }, true);
      console.log(`Initial administrator created: ${user.id}`);
    } else throw new Error('Use migrate, bootstrap-admin or backup');
  } finally { await store.close(); }
}
main().catch(() => { console.error('Command failed. Check configuration; bootstrap requires an empty account database and a password of 12-128 characters.'); process.exitCode = 1; });
