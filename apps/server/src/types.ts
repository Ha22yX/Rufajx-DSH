export type Role = 'employee' | 'admin';
export type UserStatus = 'active' | 'disabled' | 'deleted';
export interface User {
  id: string; username: string; displayName: string; jobTitle: string; role: Role;
  status: UserStatus; createdAt: string; passwordHash: string;
  deletedAt: string | null; purgeAfter: string | null; purgedAt: string | null;
}
export type PublicUser = Pick<User, 'id' | 'username' | 'displayName' | 'jobTitle' | 'role'>;
export type ManagedUser = Omit<User, 'passwordHash'>;
export const publicUser = ({ id, username, displayName, jobTitle, role }: User): PublicUser => ({ id, username, displayName, jobTitle, role });
export const managedUser = ({ passwordHash: _, ...user }: User): ManagedUser => user;
export interface Login {
  id: string; userId: string; deviceId: string; deviceLabel: string;
  accessHash: string; refreshHash: string; accessExpiresAt: string;
  refreshExpiresAt: string; revokedAt: string | null; createdAt: string;
}
export interface AuthContext { user: User; login: Login }
export interface SessionSummary {
  id: string; ownerId: string; title: string; createdAt: string; updatedAt: string;
  nextSeq: number; workspaceRef?: string; upstreamHeader?: unknown;
  inheritedEventCount?: number;
}
export interface StoredEvent { seq: number; event: unknown }
export interface Lease { leaseId: string; expiresAt: string; nextSeq: number }
export interface Audit {
  id: string; actorId: string | null; action: string; targetId?: string;
  requestId?: string; createdAt: string;
}
export interface Usage {
  id: string; userId: string; loginId: string; model: string; requestId: string;
  status: 'completed' | 'failed' | 'cancelled'; createdAt: string;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
}
export interface UpstreamFile {
  id: string; ownerId: string; metadata: Record<string, unknown>; createdAt: string; deletedAt: string | null;
}
export interface TokenRotation { accessHash: string; refreshHash: string; accessExpiresAt: string; refreshExpiresAt: string }
export interface NewSession { id?: string; title?: string; workspaceRef?: string; upstreamHeader?: unknown; inheritedEventCount?: number }
export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export const unauthorized = () => new AppError(401, 'UNAUTHORIZED', '登录已失效，请重新登录');
export const notFound = () => new AppError(404, 'NOT_FOUND', '资源不存在或无权访问');
export const invalid = (message = '请求参数无效') => new AppError(400, 'INVALID_REQUEST', message);
