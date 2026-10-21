import { buildApp } from './app.js';
import { configFromEnv } from './config.js';
import { openDatabase } from './database.js';
import { DeepSeekSettings } from './deepseek-settings.js';
import { SqliteStore } from './sqlite-store.js';
import { dirname, resolve } from 'node:path';

async function main() {
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const database = await openDatabase();
  let app;
  try {
    const config = configFromEnv();
    config.clientReleasesDir ??= resolve(database.store instanceof SqliteStore ? dirname(database.store.path) : 'data', 'client-releases');
    const secretFile = config.secretFile ?? resolve(database.store instanceof SqliteStore ? dirname(database.store.path) : 'data', 'secrets', 'deepseek.json');
    const settings = await DeepSeekSettings.open(secretFile, config.upstreamKey);
    app = buildApp(database.store, config, database.ready, settings);
  }
  catch (error) { await database.store.close(); throw error; }
  app.addHook('onClose', () => database.store.close());
  try { await app.listen({ host: process.env.HOST ?? '127.0.0.1', port }); }
  catch (error) { await app.close(); throw error; }
  console.log(`Rufa DSH server listening on port ${port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
}
main().catch(() => { console.error('Server startup failed. Check configuration, database connectivity and migrations.'); process.exitCode = 1; });
