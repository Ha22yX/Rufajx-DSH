import { resolve } from 'node:path';
import { SqliteStore } from './sqlite-store.js';
import { PostgresStore } from './postgres-store.js';

export async function openDatabase(env: NodeJS.ProcessEnv = process.env) {
  const driver = env.RUFA_DATABASE_DRIVER ?? 'sqlite';
  if (driver === 'sqlite') {
    const store = new SqliteStore(env.RUFA_DATABASE_PATH ?? resolve('data', 'rufa-dsh.sqlite'));
    return { store, ready: () => store.ping() };
  }
  if (driver === 'postgres') {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL required for postgres');
    const store = PostgresStore.connect(env.DATABASE_URL);
    try { await store.migrate(); } catch (error) { await store.close(); throw error; }
    return { store, ready: async () => { await store.pool.query('SELECT 1'); } };
  }
  throw new Error('Unsupported RUFA_DATABASE_DRIVER');
}
