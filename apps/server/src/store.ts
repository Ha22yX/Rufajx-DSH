import type { Audit, AuthContext, Lease, Login, NewSession, Role, SessionSummary, StoredEvent, TokenRotation, UpstreamFile, Usage, User } from './types.js';
import type { PreferenceAccess, PreferenceHistoryPage, PreferenceHistoryQuery, PreferenceMutation, PreferenceResult, PreferenceSnapshot } from './preferences.js';
import type { AdminOverview, AdminRange, AdminSessionPage, AdminSessionQuery } from './admin-queries.js';

/** Authenticated snapshot, rechecked atomically with password replacement and audit. */
export interface PasswordChange {
  userId: string; loginId: string; accessHash: string; expectedPasswordHash: string;
  passwordHash: string; now: string; audit: Audit;
}
export interface ProfileChange {
  userId: string; loginId: string; accessHash: string; now: string;
  displayName: string; jobTitle: string; audit: Audit;
}
export interface AccountMutation {
  userId: string; loginId: string; accessHash: string; now: string; targetId: string; audit: Audit;
}

/** Trusted request identity. The clock must be sampled after transaction locks. */
export interface SessionAccess { userId: string; loginId: string; accessHash: string; now: () => string }
export interface SessionEventPage { events: StoredEvent[]; nextSeq: number }

export interface Store {
  getPreferences(access: PreferenceAccess): Promise<PreferenceSnapshot>;
  mutatePreferences(access: PreferenceAccess, mutation: PreferenceMutation): Promise<PreferenceResult>;
  getPreferenceHistory(access: PreferenceAccess, query: PreferenceHistoryQuery): Promise<PreferenceHistoryPage>;
  findUser(username: string): Promise<User | undefined>;
  listUsers(): Promise<User[]>;
  createUser(input: { username: string; displayName: string; jobTitle?: string; role: Role; passwordHash: string }, bootstrap?: boolean): Promise<User>;
  updateUser(id: string, patch: { displayName?: string; jobTitle?: string; role?: Role; status?: 'active' | 'disabled' | 'deleted' }): Promise<User>;
  resetPassword(id: string, passwordHash: string): Promise<void>;
  changePassword(change: PasswordChange): Promise<void>;
  updateProfile(change: ProfileChange): Promise<User>;
  deleteUser(change: AccountMutation): Promise<User>;
  /** Resample the server clock after acquiring write locks, so waiting cannot extend recovery. */
  restoreUser(change: AccountMutation, clock?: () => string): Promise<User>;
  purgeExpiredUsers(now: string): Promise<number>;
  createLogin(login: Login, expectedPasswordHash: string): Promise<AuthContext>;
  resolveAccess(accessHash: string, now: string): Promise<AuthContext | undefined>;
  resolveLogin(loginId: string, now: string): Promise<AuthContext | undefined>;
  rotateRefresh(refreshHash: string, rotation: TokenRotation, now: string): Promise<AuthContext | undefined>;
  revokeLogin(id: string): Promise<void>;
  createSession(ownerId: string, input: NewSession): Promise<SessionSummary>;
  listSessions(ownerId: string, limit: number, cursor?: string): Promise<SessionSummary[]>;
  queryAdminSessions(query: AdminSessionQuery): Promise<AdminSessionPage>;
  getAdminOverview(range: AdminRange, now: string): Promise<AdminOverview>;
  getSession(id: string): Promise<SessionSummary | undefined>;
  readEvents(id: string, afterSeq: number, limit: number): Promise<StoredEvent[]>;
  readEventPage(id: string, afterSeq: number, limit: number): Promise<SessionEventPage>;
  acquireLease(id: string, access: SessionAccess, ttlMs: number): Promise<Lease>;
  releaseLease(id: string, access: SessionAccess, leaseId: string): Promise<void>;
  appendEvents(id: string, access: SessionAccess, leaseId: string, expectedNextSeq: number, events: StoredEvent[]): Promise<number>;
  audit(entry: Audit): Promise<void>;
  recordUsage(entry: Usage): Promise<void>;
  saveFile(file: UpstreamFile, contents: Buffer): Promise<void>;
  getFile(id: string): Promise<UpstreamFile | undefined>;
  listFiles(ownerId: string, limit: number, afterId?: string): Promise<UpstreamFile[]>;
  markFileDeleted(id: string): Promise<void>;
  close(): Promise<void>;
}
