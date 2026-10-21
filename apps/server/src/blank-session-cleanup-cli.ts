import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { cleanupBlankSessions, dryRunBlankSessions } from './blank-session-cleanup.js';

async function main() {
  const { values } = parseArgs({ options: {
    database: { type: 'string' }, plan: { type: 'string' }, backup: { type: 'string' },
    apply: { type: 'boolean', default: false }, 'min-age-minutes': { type: 'string' }, 'target-id': { type: 'string' },
  }, strict: true, allowPositionals: false });
  const database = values.database ?? process.env.RUFA_DATABASE_PATH;
  if (!database || !values.plan) throw new Error('DATABASE_AND_PLAN_REQUIRED');
  if (values.apply) {
    if (!values.backup || values['min-age-minutes'] !== undefined || values['target-id'] !== undefined) throw new Error('APPLY_REQUIRES_BACKUP_AND_EXISTING_PLAN');
    const plan: unknown = JSON.parse(await readFile(values.plan, 'utf8'));
    console.log(JSON.stringify({ mode: 'apply', ...await cleanupBlankSessions(database, plan, values.backup) }));
  } else {
    if (values.backup) throw new Error('BACKUP_ONLY_WITH_APPLY');
    const minutes = values['min-age-minutes'] ?? '10';
    if (!/^\d+$/.test(minutes) || !Number.isSafeInteger(Number(minutes) * 60_000)) throw new Error('INVALID_MINIMUM_AGE');
    const plan = dryRunBlankSessions(database, { minimumAgeMs: Number(minutes) * 60_000, targetId: values['target-id'] });
    // Never replace an earlier reviewed plan. Contains opaque IDs/hashes, no message data.
    await writeFile(values.plan, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ mode: 'dry-run', planId: plan.planId, ...plan.summary }));
  }
}
main().catch(() => {
  // Avoid logging raw SQLite errors, paths, or parsed source values.
  console.error(JSON.stringify({ error: 'BLANK_SESSION_CLEANUP_FAILED', message: 'Check CLI arguments, existing SQLite v3 database, unique plan/backup paths and file permissions. No cleanup success was reported; retain any backup for inspection.' }));
  process.exitCode = 1;
});
