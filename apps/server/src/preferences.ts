import { createHash, randomUUID } from 'node:crypto';
import { AppError, invalid } from './types.js';

export interface PreferenceSettings { enabled: boolean; version: number }
export interface PreferenceInput {
  id: string; scope: 'account' | 'project'; projectRef?: string; projectName?: string;
  category: 'communication' | 'spreadsheet' | 'presentation' | 'document' | 'delivery' | 'general';
  topic: string; text: string; enabled: boolean; source?: { sessionId: string; eventSeq?: number };
}
export interface PreferenceEntry extends PreferenceInput { version: number; createdAt: string; updatedAt: string; deletedAt: string | null }
export interface PreferenceSnapshot { revision: number; settings: PreferenceSettings; entries: PreferenceEntry[] }
export type PreferenceMutation = { mutationId: string } & (
  { operation: 'put'; expectedVersion: number; entry: PreferenceInput } |
  { operation: 'delete'; expectedVersion: number; id: string } |
  { operation: 'settings'; expectedVersion: number; enabled: boolean } |
  { operation: 'clear'; expectedRevision: number }
);
export interface PreferenceHistory {
  id: string; mutationId: string; operation: PreferenceMutation['operation']; revision: number; createdAt: string;
  entries: { id: string; before: PreferenceEntry | null; after: PreferenceEntry }[];
  settings: { before: PreferenceSettings; after: PreferenceSettings } | null;
}
export interface PreferenceResult { mutationId: string; historyId: string; snapshot: PreferenceSnapshot }
export interface PreferenceRecord { digest: string; history: PreferenceHistory }
export interface PreferenceReceipt extends PreferenceRecord { result: PreferenceResult }
export interface PreferenceHistoryQuery { limit: number; beforeRevision?: number }
export interface PreferenceHistoryPage { history: PreferenceHistory[]; nextBeforeRevision?: number }
/** Auth snapshot from the route; clock is sampled after storage locks are held. */
export interface PreferenceAccess { userId: string; loginId: string; accessHash: string; now: () => string; requestId?: string }

export const emptyPreferences = (): PreferenceSnapshot => ({ revision: 0, settings: { enabled: true, version: 0 }, entries: [] });
export class PreferenceConflict extends AppError {
  constructor(code: 'PREFERENCE_CONFLICT' | 'PREFERENCE_MUTATION_REUSED' | 'PREFERENCE_LIMIT', message: string, public readonly snapshot: PreferenceSnapshot) {
    super(409, code, message);
  }
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('偏好参数必须为对象');
  return value as Record<string, unknown>;
};
function keys(value: Record<string, unknown>, allowed: string[], required = allowed) {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw invalid('偏好参数缺失或包含不允许的字段');
}
function text(value: unknown, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`偏好文字须为1至${max}个字符`);
  return value.trim();
}
function id(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw invalid('偏好ID必须为UUID');
  return value.toLowerCase();
}
function boolean(value: unknown) { if (typeof value !== 'boolean') throw invalid('偏好开关须为布尔值'); return value; }
function version(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw invalid('偏好版本无效');
  return value;
}
export function parsePreferenceMutation(value: unknown): PreferenceMutation {
  const body = object(value), mutationId = id(body.mutationId);
  switch (body.operation) {
    case 'put': {
      keys(body, ['mutationId', 'operation', 'expectedVersion', 'entry']);
      const raw = object(body.entry);
      keys(raw, ['id', 'scope', 'projectRef', 'projectName', 'category', 'topic', 'text', 'enabled', 'source'], ['id', 'scope', 'category', 'topic', 'text', 'enabled']);
      if (raw.scope !== 'account' && raw.scope !== 'project') throw invalid('偏好范围无效');
      if (!['communication', 'spreadsheet', 'presentation', 'document', 'delivery', 'general'].includes(raw.category as string)) throw invalid('偏好类别无效');
      const entry: PreferenceInput = { id: id(raw.id), scope: raw.scope, category: raw.category as PreferenceInput['category'], topic: text(raw.topic, 80), text: text(raw.text, 400), enabled: boolean(raw.enabled) };
      if (raw.scope === 'project') { entry.projectRef = id(raw.projectRef); if (Object.hasOwn(raw, 'projectName')) entry.projectName = text(raw.projectName, 100); }
      else if (Object.hasOwn(raw, 'projectRef') || Object.hasOwn(raw, 'projectName')) throw invalid('账号偏好不接受项目字段');
      if (Object.hasOwn(raw, 'source')) {
        const source = object(raw.source); keys(source, ['sessionId', 'eventSeq'], ['sessionId']);
        if (typeof source.sessionId !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(source.sessionId)) throw invalid('偏好来源会话ID无效');
        entry.source = { sessionId: source.sessionId, ...(Object.hasOwn(source, 'eventSeq') ? { eventSeq: version(source.eventSeq) } : {}) };
      }
      return { mutationId, operation: 'put', expectedVersion: version(body.expectedVersion), entry };
    }
    case 'delete': keys(body, ['mutationId', 'operation', 'expectedVersion', 'id']); return { mutationId, operation: 'delete', expectedVersion: version(body.expectedVersion), id: id(body.id) };
    case 'settings': keys(body, ['mutationId', 'operation', 'expectedVersion', 'enabled']); return { mutationId, operation: 'settings', expectedVersion: version(body.expectedVersion), enabled: boolean(body.enabled) };
    case 'clear': keys(body, ['mutationId', 'operation', 'expectedRevision']); return { mutationId, operation: 'clear', expectedRevision: version(body.expectedRevision) };
    default: throw invalid('偏好操作无效');
  }
}
export function parsePreferenceHistoryQuery(value: unknown): PreferenceHistoryQuery {
  const query = object(value); keys(query, ['limit', 'beforeRevision'], []);
  const number = (raw: unknown) => { if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw invalid('偏好历史分页无效'); return version(Number(raw)); };
  const limit = query.limit === undefined ? 50 : number(query.limit);
  if (limit < 1 || limit > 100) throw invalid('偏好历史每页1至100条');
  return { limit, ...(query.beforeRevision === undefined ? {} : { beforeRevision: number(query.beforeRevision) }) };
}
export function assertPreferenceQueryEmpty(value: unknown) { keys(object(value), [], []); }
export const preferenceDigest = (mutation: PreferenceMutation) => createHash('sha256').update(JSON.stringify(mutation)).digest('hex');
export function replayPreference(receipt: PreferenceRecord, mutation: PreferenceMutation, snapshot: PreferenceSnapshot, history: PreferenceHistory[]): PreferenceResult {
  if (receipt.digest !== preferenceDigest(mutation)) throw new PreferenceConflict('PREFERENCE_MUTATION_REUSED', '操作编号已被另一项偏好修改使用', snapshot);
  // Persist deltas, not a copy of every account entry for every mutation. Reconstruct
  // the exact first response on retry without including subsequent modifications.
  const original = emptyPreferences(), entries = new Map<string, PreferenceEntry>();
  for (const change of history) {
    if (change.revision !== original.revision + 1 || change.revision > receipt.history.revision) throw new Error('Incomplete preference history');
    for (const entry of change.entries) entries.set(entry.id, entry.after);
    if (change.settings) original.settings = change.settings.after;
    original.revision = change.revision;
  }
  if (original.revision !== receipt.history.revision || history.at(-1)?.id !== receipt.history.id) throw new Error('Incomplete preference history');
  original.entries = [...entries.values()];
  return { mutationId: mutation.mutationId, historyId: receipt.history.id, snapshot: original };
}
export const preferenceRecord = ({ digest, history }: PreferenceReceipt): PreferenceRecord => ({ digest, history });
/** Pure transition; storage commits snapshot, receipt, history and redacted audit together. */
export function applyPreference(snapshot: PreferenceSnapshot, mutation: PreferenceMutation, now: string): PreferenceReceipt {
  const next = structuredClone(snapshot);
  const history: PreferenceHistory = { id: randomUUID(), mutationId: mutation.mutationId, operation: mutation.operation, revision: snapshot.revision + 1, createdAt: now, entries: [], settings: null };
  const conflict = () => { throw new PreferenceConflict('PREFERENCE_CONFLICT', '偏好已变化，请核对当前版本后再保存', snapshot); };
  if (snapshot.revision >= Number.MAX_SAFE_INTEGER - 1) conflict();
  if (mutation.operation === 'settings') {
    if (mutation.expectedVersion !== snapshot.settings.version) conflict();
    next.settings = { enabled: mutation.enabled, version: snapshot.settings.version + 1 };
    history.settings = { before: snapshot.settings, after: next.settings };
  } else if (mutation.operation === 'clear') {
    if (mutation.expectedRevision !== snapshot.revision) conflict();
    next.entries = next.entries.map(before => {
      if (before.deletedAt !== null) return before;
      const after = { ...before, version: before.version + 1, updatedAt: now, deletedAt: now };
      history.entries.push({ id: before.id, before, after }); return after;
    });
  } else {
    const key = mutation.operation === 'put' ? mutation.entry.id : mutation.id;
    const index = next.entries.findIndex(entry => entry.id === key), before = next.entries[index] ?? null;
    if (mutation.expectedVersion !== (before?.version ?? 0)) conflict();
    if (mutation.operation === 'delete' && (!before || before.deletedAt !== null)) conflict();
    if (mutation.operation === 'put' && (!before || before.deletedAt !== null) && next.entries.filter(entry => entry.deletedAt === null).length >= 200) throw new PreferenceConflict('PREFERENCE_LIMIT', '每个账号最多保存200条未删除偏好', snapshot);
    const after: PreferenceEntry = mutation.operation === 'put'
      ? { ...mutation.entry, version: (before?.version ?? 0) + 1, createdAt: before?.createdAt ?? now, updatedAt: now, deletedAt: null }
      : { ...before!, version: before!.version + 1, updatedAt: now, deletedAt: now };
    if (index < 0) next.entries.push(after); else next.entries[index] = after;
    history.entries.push({ id: key, before, after });
  }
  next.revision = history.revision;
  return { digest: preferenceDigest(mutation), result: { mutationId: mutation.mutationId, historyId: history.id, snapshot: next }, history };
}
export function preferenceHistoryPage(history: PreferenceHistory[], limit: number): PreferenceHistoryPage {
  const page = history.slice(0, limit); return { history: page, ...(history.length > limit ? { nextBeforeRevision: page.at(-1)!.revision } : {}) };
}
