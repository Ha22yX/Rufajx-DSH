import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, rename, unlink, realpath, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { companyPresetVersion, companyPresetMarker, companyPresetDirectory, companyPresetBundles,
  companyPresetDisabledBundles, companyPresetRows } from './company-preset-data.js';

const maxFileBytes = 2 * 1024 * 1024;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const companyPresetHash = digest(JSON.stringify({ version: companyPresetVersion, bundles: companyPresetBundles,
  disabledBundles: companyPresetDisabledBundles, rows: companyPresetRows }));
const jobs = new Map<string, Promise<void>>();
const message = '客户端预设迁移未完成。原账号配置已保留，请修复配置后重新打开工作台。';
const conflict = () => new Error('客户端预设迁移期间配置发生变化。已保留原账号备份，请核对后重试。');
type FileName = 'package.json' | 'cordis.patch.yml';
interface TransactionFile { name: FileName; before: string; after: string }
interface Journal { format: 1; preset: string; hash: string; files: TransactionFile[] }
export interface PresetMigrationOptions {
  /** Test instrumentation; the production host supplies no callbacks. */
  checkpoint?: (stage: 'prepared' | 'package' | 'patch' | 'validated' | 'committed') => void | Promise<void>;
}

async function safeDirectory(directory: string) {
  const actual = await realpath(directory), expected = resolve(directory);
  if ((process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)
    || !(await lstat(directory)).isDirectory()) throw new Error(message);
}
async function readRegular(file: string, optional = false, maximum = maxFileBytes): Promise<string | null> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error(message);
    const value = await readFile(file, 'utf8');
    if (Buffer.byteLength(value) > maximum) throw new Error(message);
    return value;
  } catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function atomic(file: string, value: string, expected?: string | null) {
  if (expected !== undefined && await readRegular(file, true, maxFileBytes * 5) !== expected) throw conflict();
  const temporary = `${file}.${randomUUID()}.pending`;
  try {
    await writeFile(temporary, value, { flag: 'wx', mode: 0o600, flush: true });
    if (expected !== undefined && await readRegular(file, true, maxFileBytes * 5) !== expected) throw conflict();
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function parsedJournal(source: string): Journal {
  let value: Journal;
  try { value = JSON.parse(source); } catch { throw new Error(message); }
  if (value.format !== 1 || value.preset !== companyPresetVersion || value.hash !== companyPresetHash
    || !Array.isArray(value.files) || value.files.length !== 2) throw new Error(message);
  for (const [index, name] of ['package.json', 'cordis.patch.yml'].entries()) {
    const file = value.files[index];
    if (file.name !== name || typeof file.before !== 'string' || typeof file.after !== 'string'
      || Buffer.byteLength(file.before) > maxFileBytes || Buffer.byteLength(file.after) > maxFileBytes) throw new Error(message);
  }
  return value;
}
async function rollback(directory: string, journal: Journal) {
  // Inspect all files before changing any: never roll back over a subsequent manual edit.
  await safeDirectory(directory);
  for (const file of journal.files) {
    const current = await readRegular(join(directory, file.name));
    if (current !== file.before && current !== file.after) throw conflict();
  }
  for (const file of [...journal.files].reverse()) {
    const path = join(directory, file.name), current = await readRegular(path);
    if (current === file.after && current !== file.before) await atomic(path, file.before, current);
  }
}

/** Merge only statically reviewed leaves; never copy unknown plugin config from another account. */
function mergeConfig(yaml: any, document: any, target: any, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      let nested = target.get(key, true);
      if (nested === undefined) { nested = document.createNode({}); target.set(key, nested); }
      if (!yaml.isMap(nested) || nested.tag || nested.has('<<')) throw new Error(message);
      mergeConfig(yaml, document, nested, value as Record<string, unknown>);
    } else target.set(key, document.createNode(value));
  }
}

function projectPatch(yaml: any, source: string, modelId: string) {
  const document = yaml.parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] });
  if (document.errors.length || !yaml.isSeq(document.contents)) throw new Error(message);
  // The native patch index also traverses groups. Do not guess at dynamic IDs
  // or mutate a structural operation which reuses one of our known row IDs.
  const rows: any[] = [];
  const desiredIds = new Set(companyPresetRows.map(row => row.id));
  const checkInserted = (items: any[]) => {
    for (const item of items) {
      if (!yaml.isMap(item)) continue;
      if (item.get('id', true)?.tag || desiredIds.has(item.get('id'))) throw new Error(message);
      const config = item.get('config', true);
      if (item.get('group') && yaml.isSeq(config)) checkInserted(config.items);
    }
  };
  for (const item of document.contents.items) {
    if (!yaml.isMap(item)) continue;
    if (item.get('id', true)?.tag) throw new Error(message);
    if (item.has('id')) rows.push(item);
    const inserted = item.get('insert', true);
    if (yaml.isSeq(inserted)) checkInserted(inserted.items);
  }
  for (const desired of companyPresetRows) {
    const matches = rows.filter(row => row.get('id') === desired.id);
    if (matches.length > 1) throw new Error(message);
    let row = matches[0];
    if (row?.tag || row?.has('<<')) throw new Error(message);
    if (row && row.items.some((pair: any) => !['id', 'name', 'config', 'disabled'].includes(String(pair.key?.value)))) throw new Error(message);
    const name = row?.get('name');
    if (name !== undefined && name !== desired.name) throw new Error(message);
    if (!row) { row = document.createNode({ id: desired.id }); document.contents.items.push(row); rows.push(row); }
    if (desired.restoreEnabled) row.delete('disabled');
    if (!desired.config && !desired.unset) continue;
    let config = row.get('config', true);
    if (config === undefined) { config = document.createNode({}); row.set('config', config); }
    if (!yaml.isMap(config) || config.tag || config.has('<<')) throw new Error(message);
    if (desired.id === 'agent-default-model') {
      // Native patches replace config as a whole. Preserve existing model fields;
      // fill absent required fields from company selection, never from the snapshot.
      if (!config.has('provider')) config.set('provider', 'deepseek-official');
      if (!config.has('model')) config.set('model', modelId);
    }
    mergeConfig(yaml, document, config, desired.config ?? {});
    for (const key of desired.unset ?? []) config.delete(key);
  }
  document.contents.flow = false;
  const result = String(document);
  if (Buffer.byteLength(result) > maxFileBytes) throw new Error(message);
  return result;
}

async function validateComposedPreset(runtimeRequire: NodeRequire, yaml: any, profile: any, afterPatch: string) {
  const { applyEntryPatches } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis-plugin-include')).href);
  const desiredIds = new Set(companyPresetRows.map(row => row.id));
  const checkWarning = (_message: string, ...args: unknown[]) => {
    if (args.some(value => typeof value === 'string' && desiredIds.has(value))) throw new Error(message);
  };
  let entries: any[] = [];
  for (const layer of profile.layers) entries = applyEntryPatches(entries, layer.patches, checkWarning);
  // The !!js custom tag becomes inert text here, never executable code.
  const patches = yaml.parse(afterPatch, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] });
  entries = applyEntryPatches(entries, patches, checkWarning);
  const byId = new Map<string, any[]>();
  const visit = (items: any[]) => {
    for (const item of items) {
      if (typeof item?.id === 'string') byId.set(item.id, [...byId.get(item.id) ?? [], item]);
      if (item?.group && Array.isArray(item.config)) visit(item.config);
    }
  };
  visit(entries);
  const matches = (actual: any, expected: any): boolean => {
    if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
    if (expected && typeof expected === 'object') return !!actual && typeof actual === 'object'
      && Object.entries(expected).every(([key, value]) => matches(actual[key], value));
    return actual === expected;
  };
  for (const desired of companyPresetRows) {
    const found = byId.get(desired.id);
    if (found?.length !== 1 || found[0].name !== desired.name || desired.restoreEnabled && found[0].disabled === true
      || desired.config && !matches(found[0].config, desired.config)
      || desired.unset?.some(key => found[0].config?.[key] !== undefined)) throw new Error(message);
  }
}

async function migrate(companyHome: string, runtimeRoot: string, modelId: string, options: PresetMigrationOptions) {
  const directory = join(resolve(companyHome), 'profiles/web');
  await safeDirectory(companyHome); await safeDirectory(join(companyHome, 'profiles')); await safeDirectory(directory);
  const marker = join(directory, companyPresetMarker);
  const marked = await readRegular(marker, true);
  if (marked !== null) {
    let receipt; try { receipt = JSON.parse(marked); } catch { throw new Error(message); }
    if (receipt.version !== companyPresetVersion || typeof receipt.hash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.hash)
      || receipt.status !== 'committed') throw new Error(message);
    // No source parsing, plugin reconciliation, or settings writes after success.
    return;
  }
  const transactionDirectory = join(directory, companyPresetDirectory);
  await mkdir(transactionDirectory, { recursive: true }); await safeDirectory(transactionDirectory);
  const journalPath = join(transactionDirectory, 'journal.json'), backupPath = join(transactionDirectory, 'backup.json');
  const abandoned = await readRegular(journalPath, true, maxFileBytes * 5);
  if (abandoned !== null) {
    await rollback(directory, parsedJournal(abandoned));
    await unlink(journalPath);
  }
  const manifestPath = join(directory, 'package.json'), patchPath = join(directory, 'cordis.patch.yml');
  const beforeManifest = (await readRegular(manifestPath))!, beforePatch = (await readRegular(patchPath))!;
  let manifest;
  try { manifest = JSON.parse(beforeManifest); } catch { throw new Error(message); }
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.some(value => typeof value !== 'string') || !modelId) throw new Error(message);
  const off = new Set<string>(companyPresetDisabledBundles);
  // Keep existing ordering, including aggregate bundles before their guarded
  // components. Only missing base layers need an anchor; new ordinary bundles append.
  const nextBundles: string[] = bundles.filter((name: string) => !off.has(name));
  if (!nextBundles.includes('@deepseek-ai/dsh-base')) nextBundles.unshift('@deepseek-ai/dsh-base');
  if (!nextBundles.includes('@deepseek-ai/dsh-web-app')) nextBundles.splice(nextBundles.indexOf('@deepseek-ai/dsh-base') + 1, 0, '@deepseek-ai/dsh-web-app');
  for (const name of companyPresetBundles) if (!nextBundles.includes(name)) nextBundles.push(name);
  const nextManifest = { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile,
    bundles: nextBundles } } };
  const runtimeRequire = createRequire(join(runtimeRoot, 'package.json')), yaml = runtimeRequire('yaml');
  const afterPatch = projectPatch(yaml, beforePatch, modelId);
  const journal: Journal = { format: 1, preset: companyPresetVersion, hash: companyPresetHash, files: [
    { name: 'package.json', before: beforeManifest, after: `${JSON.stringify(nextManifest, null, 2)}\n` },
    { name: 'cordis.patch.yml', before: beforePatch, after: afterPatch },
  ] };
  if (journal.files.some(file => Buffer.byteLength(file.after) > maxFileBytes)) throw new Error(message);
  const journalText = JSON.stringify(journal);
  if (Buffer.byteLength(journalText) > maxFileBytes * 5) throw new Error(message);
  await atomic(journalPath, journalText, null);
  let committed = false;
  try {
    await options.checkpoint?.('prepared');
    for (const [index, file] of journal.files.entries()) {
      await safeDirectory(directory);
      if (file.before !== file.after) await atomic(join(directory, file.name), file.after, file.before);
      await options.checkpoint?.(index === 0 ? 'package' : 'patch');
    }
    // Check native resolution without evaluating any pre-existing !!js user values.
    const { loadProfile } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
    const profile = loadProfile('dsh', 'web', join(runtimeRoot, 'package.json'), companyHome, { userLayer: false });
    const available = new Set(profile.layers.map((layer: { packageName: string }) => layer.packageName));
    if (companyPresetBundles.some(name => !available.has(name))) throw new Error(message);
    await validateComposedPreset(runtimeRequire, yaml, profile, afterPatch);
    await options.checkpoint?.('validated');
    for (const file of journal.files) if (await readRegular(join(directory, file.name)) !== file.after) throw conflict();
    // Retain an account-private backup; it is never part of the shipped preset or logs.
    await atomic(backupPath, journalText, await readRegular(backupPath, true, maxFileBytes * 5));
    await atomic(marker, JSON.stringify({ version: companyPresetVersion, hash: companyPresetHash, status: 'committed' }), null);
    committed = true;
    await unlink(journalPath);
    await options.checkpoint?.('committed');
  } catch (error) {
    if (!committed) {
      await rollback(directory, journal);
      await unlink(journalPath);
    }
    throw error;
  }
}

/** One transaction per account; concurrent opens share the same migration. */
export function applyCompanyPreset(companyHome: string, runtimeRoot: string, modelId: string, options: PresetMigrationOptions = {}): Promise<void> {
  const key = process.platform === 'win32' ? resolve(companyHome).toLowerCase() : resolve(companyHome);
  const running = jobs.get(key); if (running) return running;
  const job = migrate(companyHome, runtimeRoot, modelId, options).finally(() => { if (jobs.get(key) === job) jobs.delete(key); });
  jobs.set(key, job); return job;
}
