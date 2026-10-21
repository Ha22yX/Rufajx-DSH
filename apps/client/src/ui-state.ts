import { readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const maxBytes = 12 * 1024 * 1024;
export function isUiStateKey(key: unknown): key is string {
  return typeof key === 'string' && (key === 'dsh.sessions.current' || key === 'rufa.projects.view.v1'
    || /^dsh\.conversation\.[A-Za-z0-9_-]{1,160}$/.test(key));
}
function checkedEntries(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid UI state');
  const values = Object.entries(input);
  if (values.length > 10000) throw new Error('Too many UI state entries');
  const entries: Record<string, string> = Object.create(null);
  for (const [key, value] of values) {
    if (!isUiStateKey(key) || typeof value !== 'string' || Buffer.byteLength(value) > 1024 * 1024) throw new Error('Invalid UI state entry');
    JSON.parse(value); // Native stores serialize semantic JSON, never binary credentials.
    entries[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(entries)) > maxBytes) throw new Error('UI state storage is full');
  return entries;
}

/** Account-local mirror of native draft/selection JSON, independent of loopback port. */
export class AccountUiStateStore {
  readonly #directory: string;
  readonly #file: string;
  #entries: Record<string, string> = Object.create(null);
  #exists = false;
  constructor(companyHome: string) {
    this.#directory = resolve(companyHome);
    this.#assertDirectory();
    this.#file = join(this.#directory, 'browser-ui-state.json');
    try {
      const stat = lstatSync(this.#file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes + 1024) throw new Error('Invalid UI state file');
      const bytes = readFileSync(this.#file);
      if (bytes.byteLength > maxBytes + 1024) throw new Error('UI state storage is full');
      const saved = JSON.parse(bytes.toString('utf8'));
      if (saved.version !== 1) throw new Error('Unsupported UI state version');
      this.#entries = checkedEntries(saved.entries); this.#exists = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  #assertDirectory() {
    const canonical = realpathSync.native(this.#directory);
    const same = process.platform === 'win32' ? canonical.toLowerCase() === this.#directory.toLowerCase() : canonical === this.#directory;
    if (!same) throw new Error('Account UI state directory was redirected');
  }
  snapshot() { return { exists: this.#exists, entries: { ...this.#entries } }; }
  commit(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid UI state operation');
    const value = input as { set?: unknown; remove?: unknown };
    if (Object.keys(value).some(key => key !== 'set' && key !== 'remove')) throw new Error('Invalid UI state operation');
    const additions = checkedEntries(value.set ?? {}), remove = value.remove ?? [];
    if (!Array.isArray(remove) || remove.length > 10000 || remove.some(key => !isUiStateKey(key))) throw new Error('Invalid UI state deletion');
    const pending = { ...this.#entries, ...additions };
    for (const key of remove) delete pending[key];
    const next = checkedEntries(pending);
    if (this.#exists && JSON.stringify(next) === JSON.stringify(this.#entries)) return;
    this.#assertDirectory();
    const temporary = `${this.#file}.${randomUUID()}.pending`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, entries: next }), { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, this.#file);
      this.#entries = next; this.#exists = true;
    } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  }
}
