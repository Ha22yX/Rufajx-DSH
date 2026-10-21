// Apply the actual metadata backup to isolated account copies, never live data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const [backup, plugins, serverUrl, userId] = process.argv.slice(2);
assert.ok(backup && plugins && serverUrl && userId);
const scope = createHash('sha256').update(`${serverUrl}:${userId}`).digest('hex');
const evidence = await realpath(await mkdtemp(join(tmpdir(), 'rufa-project-recovery-replay-')));
const sourceAccountHome = join(evidence, 'source/accounts', scope), targetAccountHome = join(evidence, 'target/accounts', scope);
await mkdir(sourceAccountHome, { recursive: true }); await mkdir(targetAccountHome, { recursive: true });
await cp(join(backup, 'development'), sourceAccountHome, { recursive: true });
await cp(join(backup, 'installed'), targetAccountHome, { recursive: true });
const protectedFiles = ['company-history.sqlite', 'browser-ui-state.json'];
const before = await Promise.all(protectedFiles.map(name => readFile(join(targetAccountHome, name))));
const { migrateCompanyProjects } = await import(pathToFileURL(join(resolve(plugins), 'company-project-migration.mjs')).href);
const options = { sourceAccountHome, targetAccountHome, serverUrl, userId };
const preview = await migrateCompanyProjects({ ...options, dryRun: true });
const applied = await migrateCompanyProjects({ ...options, dryRun: false });
assert.equal(applied.status, 'complete'); assert.deepEqual(applied.changes, preview.changes);
const registry = JSON.parse(await readFile(join(targetAccountHome, 'storages/workspace.json'), 'utf8'));
assert.deepEqual(registry, preview.documents['storages/workspace.json']);
for (const [i, name] of protectedFiles.entries()) assert.deepEqual(await readFile(join(targetAccountHome, name)), before[i]);
const settled = await readFile(join(targetAccountHome, 'storages/workspace.json'));
assert.equal((await migrateCompanyProjects({ ...options, dryRun: false })).status, 'complete');
assert.deepEqual(await readFile(join(targetAccountHome, 'storages/workspace.json')), settled);
const report = { passed: true, projects: registry.global.workspaceIds.length,
  restoredTitles: preview.changes.filter(row => row.kind === 'restore-title').map(row => row.title),
  removedBootstrapProjections: preview.changes.filter(row => row.kind === 'drop-bootstrap-projection').length,
  archivedSessions: registry.global.archivedSessionIds.length, historyAndDraftsUnchanged: true,
  repeatedMigrationUnchanged: true, liveProfileWrites: 0, evidence };
await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
