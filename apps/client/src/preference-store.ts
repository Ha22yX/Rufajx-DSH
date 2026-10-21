import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { CompanyError } from './types.js';

export type PreferenceEntry = { id: string; scope: 'account' | 'project'; projectRef?: string; projectName?: string;
  category: 'communication' | 'spreadsheet' | 'presentation' | 'document' | 'delivery' | 'general';
  topic: string; text: string; enabled: boolean; source?: { sessionId: string; eventSeq?: number };
  version: number; createdAt: string; updatedAt: string; deletedAt: string | null };
export type PreferenceInput = Omit<PreferenceEntry, 'version' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
type Settings = { enabled: boolean; version: number };
type RemoteSnapshot = { revision: number; settings: Settings; entries: PreferenceEntry[] };
export type PreferenceProject = { projectRef: string; projectName: string; workspaceId: string };
type Command = { action: 'put' | 'delete' | 'settings' | 'clear'; entry?: PreferenceInput; id?: string; enabled?: boolean };
type Pending = { mutationId: string; command: Command; expectedVersion?: number; expectedRevision?: number; createdAt: string;
  conflict?: string; sent?: boolean; clearedIds?: string[] };
type StatePart = { entries?: PreferenceEntry[]; settings?: Settings };
type Change = { id: string; kind: string; createdAt: string; before: StatePart; after: StatePart; revision: number; undone?: boolean; mutationIds?: string[]; remote?: boolean };
type DiskState = { format: 1; binding: { server: string; userId: string }; clock: number; versions: Record<string, number>;
  base: RemoteSnapshot; outbox: Pending[]; changes: Change[]; lastSyncedAt: string | null };
export type PreferenceSnapshot = RemoteSnapshot & { serverRevision: number; pendingCount: number; status: string;
  conflicts: { id: string; key: string; code: string; local: StatePart; cloud: StatePart }[]; lastSyncedAt: string | null; lastChangeId?: string };
type Options = { directory: string; server: string; userId: string; valid: () => boolean;
  fetch: (method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<{ status: number; body: unknown }>;
  projects: () => Promise<PreferenceProject[]>; validateText: (text: string) => string; onChange?: (notice?: { changeId: string; message: string }) => void; retryMs?: number };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const copy = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const initial = (): RemoteSnapshot => ({ revision: 0, settings: { enabled: true, version: 0 }, entries: [] });
const keyOf = (command: Command) => command.action === 'clear' ? '*' : command.action === 'settings' ? '$settings' : command.entry?.id ?? command.id!;
const conflict = () => new CompanyError('PREFERENCE_LOCAL_CONFLICT', '偏好已变化，请刷新后再修改。', 409);
const invalid = () => new CompanyError('INVALID_PREFERENCE', '工作偏好参数无效，请检查内容和范围。', 400);
const cleanInput = (entry: PreferenceEntry): PreferenceInput => {
  const { version, createdAt, updatedAt, deletedAt, ...value } = entry; return value;
};

export function validatePreferenceInput(value: unknown, validateText: Options['validateText']): PreferenceInput {
  if (!isRecord(value) || Object.keys(value).some(key => !['id', 'scope', 'projectRef', 'projectName', 'category', 'topic', 'text', 'enabled', 'source'].includes(key))
    || !uuid(value.id) || !['account', 'project'].includes(value.scope) || !['communication', 'spreadsheet', 'presentation', 'document', 'delivery', 'general'].includes(value.category)
    || typeof value.topic !== 'string' || !value.topic.trim() || value.topic.length > 80 || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 400
    || typeof value.enabled !== 'boolean') throw invalid();
  if (value.scope === 'project' ? !uuid(value.projectRef) : value.projectRef !== undefined || value.projectName !== undefined) throw invalid();
  if (value.projectName !== undefined && (typeof value.projectName !== 'string' || !value.projectName.trim() || value.projectName.length > 100)) throw invalid();
  if (value.source !== undefined && (!isRecord(value.source) || Object.keys(value.source).some(key => !['sessionId', 'eventSeq'].includes(key))
    || typeof value.source.sessionId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value.source.sessionId)
    || value.source.eventSeq !== undefined && (!Number.isSafeInteger(value.source.eventSeq) || value.source.eventSeq < 0))) throw invalid();
  let topic, text;
  try { topic = validateText(value.topic); text = validateText(value.text); }
  catch { throw new CompanyError('INVALID_PREFERENCE_CONTENT', '偏好只能记录工作方式和输出格式，不能包含凭据或改变权限、审查及文件保护规则。', 400); }
  return { id: value.id.toLowerCase(), scope: value.scope, category: value.category,
    topic, text, enabled: value.enabled,
    ...(value.scope === 'project' ? { projectRef: value.projectRef.toLowerCase(), ...(value.projectName ? { projectName: value.projectName.trim() } : {}) } : {}),
    ...(value.source ? { source: copy(value.source) } : {}) } as PreferenceInput;
}

function readRemote(value: unknown): RemoteSnapshot {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !isRecord(value.settings)
    || typeof value.settings.enabled !== 'boolean' || !Number.isSafeInteger(value.settings.version) || value.settings.version < 0
    || !Array.isArray(value.entries) || value.entries.length > 20000) throw new Error('偏好同步响应无效。');
  const ids = new Set();
  const entries = value.entries.map((row: unknown) => {
    if (!isRecord(row) || !Number.isSafeInteger(row.version) || row.version < 1 || !Number.isFinite(Date.parse(row.createdAt))
      || !Number.isFinite(Date.parse(row.updatedAt)) || row.deletedAt !== null && !Number.isFinite(Date.parse(row.deletedAt))) throw new Error('偏好同步条目无效。');
    const { version, createdAt, updatedAt, deletedAt, ...input } = row;
    const valid = validatePreferenceInput(input, text => text.trim());
    if (ids.has(valid.id)) throw new Error('偏好同步条目重复。'); ids.add(valid.id);
    return { ...valid, version, createdAt, updatedAt, deletedAt } as PreferenceEntry;
  });
  return { revision: value.revision, settings: { enabled: value.settings.enabled, version: value.settings.version }, entries };
}

export class PreferenceStore {
  private state: DiskState;
  private tail: Promise<unknown> = Promise.resolve();
  private active = true;
  private syncing: Promise<void> | null = null;
  private syncRequested = false;
  private controller = new AbortController();
  private retry?: ReturnType<typeof setTimeout>;
  private syncStatus = 'offline';
  private started = false;
  private constructor(private options: Options, state: DiskState) { this.state = state; }
  static async open(options: Options): Promise<PreferenceStore> {
    const state: DiskState = { format: 1, binding: { server: options.server, userId: options.userId }, clock: 0,
      versions: { $settings: 0 }, base: initial(), outbox: [], changes: [], lastSyncedAt: null };
    const store = new PreferenceStore(options, state); await store.checkPath();
    try {
      const text = await readFile(join(options.directory, 'company-preferences.json'), 'utf8');
      if (Buffer.byteLength(text) > 24 * 1024 * 1024) throw new Error('偏好缓存过大。');
      const saved = JSON.parse(text);
      if (saved?.format !== 1 || !same(saved.binding, state.binding) || !Number.isSafeInteger(saved.clock) || saved.clock < 0
        || !isRecord(saved.versions) || Object.values(saved.versions).some(v => !Number.isSafeInteger(v) || Number(v) < 0)
        || !Array.isArray(saved.outbox) || saved.outbox.length > 1000 || !Array.isArray(saved.changes)) throw new Error('偏好缓存损坏或不属于当前账号。');
      saved.base = readRemote(saved.base);
      for (const item of saved.outbox) {
        if (!uuid(item.mutationId) || !isRecord(item.command) || !['put', 'delete', 'settings', 'clear'].includes(item.command.action)) throw new Error('偏好待同步记录损坏。');
        if (item.command.action === 'put') item.command.entry = validatePreferenceInput(item.command.entry, options.validateText);
      }
      store.state = saved;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    store.check(); return store;
  }
  private check() { if (!this.active || !this.options.valid()) throw new CompanyError('LOGIN_CHANGED', '工作偏好所属账号已变化，请重新打开工作台。', 401); }
  private async checkPath() {
    this.check(); await mkdir(this.options.directory, { recursive: true });
    const canonical = await realpath(this.options.directory), key = (value: string) => process.platform === 'win32' ? normalize(value).toLowerCase() : normalize(value);
    if (key(canonical) !== key(this.options.directory)) throw new Error('偏好账号目录已被重定向。');
    try { if ((await lstat(join(canonical, 'company-preferences.json'))).isSymbolicLink()) throw new Error('偏好缓存已被重定向。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(() => { this.check(); return fn(); }); this.tail = task.catch(() => {}); return task;
  }
  private async commit(next: DiskState, signal?: AbortSignal) {
    signal?.throwIfAborted(); await this.checkPath(); this.check(); signal?.throwIfAborted();
    const text = `${JSON.stringify(next)}\n`;
    if (Buffer.byteLength(text) > 24 * 1024 * 1024) throw new Error('本地工作偏好记录过多，请先完成同步。');
    const file = join(this.options.directory, 'company-preferences.json'), temporary = `${file}.${randomUUID()}.pending`;
    try {
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600, flush: true }); this.check(); signal?.throwIfAborted();
      await rename(temporary, file); this.state = next; this.check(); this.options.onChange?.();
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  private projected(state = this.state): RemoteSnapshot {
    const result = copy(state.base), rows = new Map(result.entries.map(row => [row.id, row]));
    for (const item of state.outbox) {
      const { command, createdAt } = item;
      if (command.action === 'settings') result.settings = { enabled: command.enabled!, version: result.settings.version + 1 };
      else if (command.action === 'clear') {
        for (const [id, row] of rows) if (!row.deletedAt) rows.set(id, { ...row, version: row.version + 1, deletedAt: createdAt, updatedAt: createdAt });
      } else {
        const id = command.entry?.id ?? command.id!, old = rows.get(id);
        if (command.action === 'put') rows.set(id, { ...copy(command.entry!), version: (old?.version ?? 0) + 1,
          createdAt: old?.createdAt ?? createdAt, updatedAt: createdAt, deletedAt: null });
        else if (old) rows.set(id, { ...old, version: old.version + 1, updatedAt: createdAt, deletedAt: createdAt });
      }
      result.revision++;
    }
    result.entries = [...rows.values()]; return result;
  }
  private local(state = this.state): RemoteSnapshot {
    const view = this.projected(state); view.revision = state.clock;
    view.settings.version = state.versions.$settings ?? 0;
    view.entries = view.entries.map(row => ({ ...row, version: state.versions[row.id] ?? 0 })); return view;
  }
  private part(command: Command, view: RemoteSnapshot): StatePart {
    if (command.action === 'settings') return { settings: copy(view.settings) };
    return { entries: view.entries.filter(row => command.action === 'clear' || row.id === keyOf(command)).map(copy) };
  }
  snapshot(): PreferenceSnapshot {
    this.check();
    const local = this.local();
    return { ...local, serverRevision: this.state.base.revision, pendingCount: this.state.outbox.length,
      status: this.syncStatus === 'synced' && this.state.outbox.length ? 'pending' : this.syncStatus,
      lastSyncedAt: this.state.lastSyncedAt, conflicts: this.state.outbox.filter(row => row.conflict).map(row => ({ id: row.mutationId,
        key: keyOf(row.command), code: row.conflict!, local: this.part(row.command, local), cloud: this.part(row.command, this.state.base) })) };
  }
  history() {
    this.check(); const current = this.local();
    return { changes: this.state.changes.map(row => ({ ...copy(row), canUndo: this.canUndo(row, current) })) };
  }
  private canUndo(change: Change, current: RemoteSnapshot): boolean {
    if (change.undone) return false;
    if (change.after.settings && current.settings.version !== change.after.settings.version) return false;
    if (change.after.entries?.some(row => current.entries.find(entry => entry.id === row.id)?.version !== row.version)) return false;
    return change.kind !== 'clear' || current.revision === change.revision;
  }
  private append(state: DiskState, command: Command, time: string) {
    if (state.outbox.length >= 1000) throw new Error('待同步修改过多，请先完成同步。');
    const view = this.projected(state), key = keyOf(command);
    if (state.outbox.some(row => row.conflict && (key === '*' || keyOf(row.command) === '*' || keyOf(row.command) === key))) throw new Error('请先处理这项偏好的同步冲突。');
    const item: Pending = { mutationId: randomUUID(), command, createdAt: time,
      ...(command.action === 'clear' ? { expectedRevision: view.revision, clearedIds: view.entries.filter(row => !row.deletedAt).map(row => row.id) }
        : { expectedVersion: command.action === 'settings' ? view.settings.version : view.entries.find(row => row.id === key)?.version ?? 0 }) };
    state.outbox.push(item); state.clock++;
    if (key === '*') { for (const row of view.entries) if (!row.deletedAt) state.versions[row.id] = state.clock; }
    else state.versions[key] = state.clock;
  }
  async mutate(input: unknown, signal?: AbortSignal): Promise<PreferenceSnapshot> {
    signal?.throwIfAborted();
    const result = await this.enqueue(async () => {
      signal?.throwIfAborted();
      if (!isRecord(input) || !['put', 'delete', 'settings', 'clear', 'undo'].includes(input.action)) throw invalid();
      const allowed: Record<string, string[]> = { put: ['action', 'entry', 'expectedVersion'], delete: ['action', 'id', 'expectedVersion'],
        settings: ['action', 'enabled', 'expectedVersion'], clear: ['action', 'expectedRevision'], undo: ['action', 'changeId'] };
      if (Object.keys(input).some(key => !allowed[input.action].includes(key))) throw invalid();
      const next = copy(this.state), beforeView = this.local(next), time = new Date().toISOString();
      let commands: Command[], before: StatePart;
      if (input.action === 'undo') {
        const previous = next.changes.find(row => row.id === input.changeId);
        if (!previous || !this.canUndo(previous, beforeView)) throw conflict();
        commands = [];
        if (previous.before.settings) commands.push({ action: 'settings', enabled: previous.before.settings.enabled });
        for (const after of previous.after.entries ?? []) {
          const old = previous.before.entries?.find(row => row.id === after.id);
          if (!old || old.deletedAt) { if (!after.deletedAt) commands.push({ action: 'delete', id: after.id }); }
          else commands.push({ action: 'put', entry: cleanInput(old) });
        }
        if (!commands.length) throw conflict(); previous.undone = true;
        before = copy(previous.after);
      } else {
        let command: Command;
        if (input.action === 'put') {
          const entry = validatePreferenceInput(input.entry, this.options.validateText);
          if (entry.scope === 'project') {
            const project = (await this.options.projects()).find(row => row.projectRef === entry.projectRef); this.check(); signal?.throwIfAborted();
            if (!project) throw new Error('此项目未绑定到本机当前账号，请选择已注册项目。');
            entry.projectName = project.projectName;
          }
          const old = beforeView.entries.find(row => row.id === entry.id);
          if ((!old || old.deletedAt) && beforeView.entries.filter(row => !row.deletedAt).length >= 200) throw new Error('最多保存200条工作偏好，请先删除不再需要的条目。');
          command = { action: 'put', entry };
        } else if (input.action === 'delete') {
          if (!uuid(input.id)) throw invalid();
          const entry = beforeView.entries.find(row => row.id === input.id.toLowerCase()); if (!entry || entry.deletedAt) throw conflict();
          command = { action: 'delete', id: entry.id };
        } else if (input.action === 'settings') {
          if (typeof input.enabled !== 'boolean') throw invalid(); command = { action: 'settings', enabled: input.enabled };
        } else command = { action: 'clear' };
        if (command.action === 'clear') { if (input.expectedRevision !== beforeView.revision) throw conflict(); }
        else {
          const version = command.action === 'settings' ? beforeView.settings.version : beforeView.entries.find(row => row.id === keyOf(command))?.version ?? 0;
          if (input.expectedVersion !== version) throw conflict();
        }
        before = this.part(command, beforeView); commands = [command];
      }
      for (const command of commands) {
        if (command.entry) {
          command.entry = validatePreferenceInput(command.entry, this.options.validateText);
          if (command.entry.scope === 'project' && !(await this.options.projects()).some(row => row.projectRef === command.entry!.projectRef)) throw new Error('此项目未绑定到本机当前账号。');
          this.check(); signal?.throwIfAborted();
        }
        this.append(next, command, time);
      }
      const afterView = this.local(next), changedIds = new Set(commands.flatMap(command => command.action === 'clear' ? afterView.entries.map(row => row.id) : command.entry?.id ?? command.id ?? []));
      const after: StatePart = { ...(before.settings ? { settings: afterView.settings } : {}),
        ...(before.entries ? { entries: afterView.entries.filter(row => changedIds.has(row.id)) } : {}) };
      const change: Change = { id: randomUUID(), kind: input.action, createdAt: time, before, after, revision: next.clock,
        mutationIds: next.outbox.slice(this.state.outbox.length).map(row => row.mutationId) };
      next.changes.unshift(change); next.changes = next.changes.slice(0, 50);
      await this.commit(next, signal);
      this.options.onChange?.({ changeId: change.id, message: input.action === 'put' ? commands[0].entry?.scope === 'project' ? '已保存项目偏好' : '已保存个人偏好' : '工作偏好已更新' });
      return { ...this.snapshot(), lastChangeId: change.id };
    });
    this.schedule(0); return result;
  }
  async resolveConflict(id: string, choice: 'local' | 'cloud', signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.enqueue(async () => {
      signal?.throwIfAborted();
      if (!uuid(id) || !['local', 'cloud'].includes(choice)) throw invalid();
      const next = copy(this.state), item = next.outbox.find(row => row.mutationId === id && row.conflict);
      if (!item) throw conflict();
      const key = keyOf(item.command), before = this.projected(next);
      // Preserve later clear/other-item commands. A per-item decision must not
      // silently discard unrelated queued work or move an edit past a clear.
      const index = next.outbox.indexOf(item);
      const clearIndex = next.outbox.findIndex((row, position) => position > index && keyOf(row.command) === '*');
      const boundary = clearIndex < 0 ? next.outbox.length : clearIndex;
      const tail = [...next.outbox.slice(index + 1, boundary).filter(row => keyOf(row.command) !== key), ...next.outbox.slice(boundary)];
      const desired = this.local({ ...next, outbox: key === '*' ? next.outbox : next.outbox.slice(0, boundary) });
      next.outbox = key === '*' ? choice === 'local' ? [] : next.outbox.filter(row => row !== item) : next.outbox.slice(0, index);
      if (key === '*' && choice === 'cloud') {
        const affected = new Set(item.clearedIds ?? next.base.entries.map(row => row.id));
        for (const row of next.outbox.slice(index)) if (affected.has(keyOf(row.command))) row.conflict = 'CLEAR_DEPENDENCY';
      }
      if (choice === 'local') {
        let command = item.command;
        if (key !== '*' && key !== '$settings') {
          const entry = desired.entries.find(row => row.id === key);
          if (entry?.deletedAt) command = { action: 'delete', id: key };
          else if (entry) command = { action: 'put', entry: cleanInput(entry) };
        } else if (key === '$settings') command = { action: 'settings', enabled: desired.settings.enabled };
        // A remote tombstone already represents the chosen local deletion.
        if (command.action !== 'delete' || next.base.entries.some(row => row.id === key && !row.deletedAt)) this.append(next, command, new Date().toISOString());
        if (key === '*') {
          // A clear may be followed by new offline additions. Keeping the local
          // result preserves those additions too, with fresh remote CAS bases.
          for (const row of desired.entries) if (!row.deletedAt) this.append(next, { action: 'put', entry: cleanInput(row) }, new Date().toISOString());
          if (desired.settings.enabled !== next.base.settings.enabled) this.append(next, { action: 'settings', enabled: desired.settings.enabled }, new Date().toISOString());
        }
      }
      if (key !== '*') next.outbox.push(...tail);
      this.bumpChanged(next, before); await this.commit(next, signal);
    });
    this.schedule(0); return this.snapshot();
  }
  private bumpChanged(next: DiskState, before: RemoteSnapshot) {
    const after = this.projected(next), semantic = (row?: PreferenceEntry) => row && { ...cleanInput(row), deleted: !!row.deletedAt, version: row.version };
    if (!same(before.settings, after.settings)) next.versions.$settings = ++next.clock;
    const ids = new Set([...before.entries, ...after.entries].map(row => row.id));
    for (const id of ids) if (!same(semantic(before.entries.find(row => row.id === id)), semantic(after.entries.find(row => row.id === id)))) next.versions[id] = ++next.clock;
  }
  private async mergeHistory(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.history) || value.history.length > 100) throw new Error('偏好修改记录无效。');
    await this.enqueue(async () => {
      const next = copy(this.state), own = new Set(next.changes.filter(row => !row.remote).flatMap(row => row.mutationIds ?? []));
      const pending = new Set(next.outbox.map(row => keyOf(row.command)));
      const local = this.local(next), received: Change[] = [];
      for (const raw of value.history) {
        if (!isRecord(raw) || !uuid(raw.id) || !uuid(raw.mutationId) || !['put', 'delete', 'settings', 'clear'].includes(raw.operation)
          || !Number.isSafeInteger(raw.revision) || !Number.isFinite(Date.parse(raw.createdAt)) || !Array.isArray(raw.entries)) throw new Error('偏好修改记录无效。');
        if (own.has(raw.mutationId)) continue;
        const before: StatePart = {}, after: StatePart = {};
        if (raw.operation === 'settings') {
          const validate = (input: unknown) => readRemote({ revision: 0, settings: input, entries: [] }).settings;
          before.settings = validate(raw.settings?.before); const setting = validate(raw.settings?.after);
          after.settings = { ...setting, version: !pending.has('*') && !pending.has('$settings') && setting.version === next.base.settings.version ? local.settings.version : -1 };
        } else {
          const validate = (rows: unknown[]) => readRemote({ revision: 0, settings: { enabled: true, version: 0 }, entries: rows }).entries;
          before.entries = validate(raw.entries.filter((row: any) => row.before !== null).map((row: any) => row.before));
          after.entries = validate(raw.entries.map((row: any) => row.after)).map(row => ({ ...row,
            version: !pending.has('*') && !pending.has(row.id) && next.base.entries.find(entry => entry.id === row.id)?.version === row.version
              ? local.entries.find(entry => entry.id === row.id)?.version ?? -1 : -1 }));
        }
        received.push({ id: raw.id, kind: raw.operation, createdAt: raw.createdAt, before, after, remote: true, mutationIds: [raw.mutationId],
          revision: raw.revision === next.base.revision && !next.outbox.length ? next.clock : -1,
          undone: next.changes.find(row => row.id === raw.id)?.undone });
      }
      next.changes = [...next.changes.filter(row => !row.remote), ...received].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 50);
      await this.commit(next);
    });
  }
  private schedule(delay = this.options.retryMs ?? 30000) {
    if (!this.started || !this.active || !this.options.valid()) return;
    if (delay === 0 && this.syncing) { this.syncRequested = true; return; }
    clearTimeout(this.retry); this.retry = setTimeout(() => { void this.sync().catch(() => {}); }, delay); this.retry.unref?.();
  }
  start() { this.check(); this.started = true; this.schedule(0); }
  async sync(): Promise<void> {
    this.check(); if (this.syncing) { this.syncRequested = true; return this.syncing; }
    this.syncRequested = false;
    const task = this.performSync(); this.syncing = task;
    try { await task; } finally {
      if (this.syncing === task) this.syncing = null;
      const again = this.syncRequested; this.syncRequested = false;
      this.schedule(again ? 0 : this.options.retryMs ?? 30000);
    }
  }
  private async performSync() {
    this.syncStatus = 'syncing'; this.options.onChange?.();
    const request = (method: string, path: string, body?: unknown) => this.options.fetch(method, path, body, AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]));
    const push = async (sentOnly: boolean) => {
      for (let count = 0; count < 1000; count++) {
        const item = await this.enqueue(async () => {
          const blocked = new Set<string>();
          const found = this.state.outbox.find(row => {
            const key = keyOf(row.command);
            if (row.conflict) { blocked.add(key); return false; }
            if (sentOnly && !row.sent) { blocked.add(key); return false; }
            if (key === '*' && blocked.size) { blocked.add('*'); return false; }
            if (blocked.has('*') || blocked.has(key) || key === '*' && blocked.size) return false;
            return true;
          });
          if (!found) return undefined;
          const next = copy(this.state), chosen = next.outbox.find(row => row.mutationId === found.mutationId)!;
          chosen.sent = true; await this.commit(next); return copy(chosen);
        });
        if (!item) break;
        const { action, ...fields } = item.command;
        const payload = { mutationId: item.mutationId, operation: action, ...fields,
          ...(action === 'clear' ? { expectedRevision: item.expectedRevision } : { expectedVersion: item.expectedVersion }) };
        const result = await request('POST', '/preferences/mutations', payload); this.check();
        if (result.status === 200) {
          const body = result.body as any;
          if (body?.mutationId !== item.mutationId) throw new Error('偏好同步确认不匹配。');
          const snapshot = readRemote(body.snapshot);
          await this.enqueue(async () => {
            const next = copy(this.state), before = this.projected(next);
            next.outbox = next.outbox.filter(row => row.mutationId !== item.mutationId);
            if (snapshot.revision >= next.base.revision) next.base = snapshot;
            this.bumpChanged(next, before); await this.commit(next);
          });
        } else if ([400, 403, 404, 409, 422].includes(result.status)) {
          const body = result.body as any;
          await this.enqueue(async () => {
            const next = copy(this.state), before = this.projected(next), row = next.outbox.find(value => value.mutationId === item.mutationId);
            if (row) row.conflict = result.status === 409 ? 'VERSION_CONFLICT' : 'SERVER_REJECTED';
            if (body?.snapshot) { const cloud = readRemote(body.snapshot); if (cloud.revision >= next.base.revision) next.base = cloud; }
            this.bumpChanged(next, before); await this.commit(next);
          });
        } else throw new Error('无法同步工作偏好。');
      }
    };
    try {
      // A lost reply may already be in the server snapshot. Obtain its exact
      // idempotent receipt before pulling, or we would apply that write twice.
      await push(true);
      const response = await request('GET', '/preferences'); this.check();
      if (response.status !== 200) throw new Error('无法同步工作偏好。');
      const remote = readRemote(response.body);
      await this.enqueue(async () => {
        const next = copy(this.state), before = this.projected(next);
        if (remote.revision >= next.base.revision) next.base = remote;
        this.bumpChanged(next, before); await this.commit(next);
      });
      await push(false);
      // History is a background convenience; cache reads and local edits do
      // not wait for it. A history outage never rolls back acknowledged writes.
      try {
        const history = await request('GET', '/preferences/history?limit=50'); this.check();
        if (history.status === 200) await this.mergeHistory(history.body);
      } catch { /* Retain the last local/remote history on transient failure. */ }
      await this.enqueue(async () => { const next = copy(this.state); next.lastSyncedAt = new Date().toISOString(); await this.commit(next); });
      this.syncStatus = this.state.outbox.some(row => row.conflict) ? 'conflict' : this.state.outbox.length ? 'pending' : 'synced';
    } catch { this.syncStatus = 'offline'; }
    finally { if (this.active && this.options.valid()) this.options.onChange?.(); }
  }
  async close() { this.active = false; clearTimeout(this.retry); this.controller.abort(); await this.tail; await this.syncing; }
}
