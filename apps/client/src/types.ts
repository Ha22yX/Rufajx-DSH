export type Role = 'employee' | 'admin';
export interface CompanyUser { id: string; username: string; displayName: string; jobTitle: string; role: Role }
export interface LoginResponse {
  accessToken: string; refreshToken: string; expiresAt: string; deviceId: string; user: CompanyUser;
}
export interface PublicAuthState { user: CompanyUser | null; serverUrl: string | null; deviceId?: string }
export interface ModelInfo {
  id: string; displayName: string; inputModalities?: string[]; contextWindow?: number;
  maxOutputTokens?: number; reasoningEfforts?: string[];
}
export interface ModelCatalog { models: ModelInfo[]; gatewayBasePath: string }
export interface ManagedUser extends CompanyUser { status: 'active' | 'disabled' | 'deleted'; createdAt: string; deletedAt: string | null; purgeAfter: string | null; purgedAt: string | null }
export interface SessionSummary {
  id: string; ownerId: string; title: string; createdAt: string; updatedAt: string; nextSeq: number;
  workspaceRef?: string; upstreamHeader?: Record<string, unknown>; inheritedEventCount?: number;
}
export interface StoredEvent { seq: number; event: Record<string, unknown> }
export interface SavedLogin { serverUrl: string; refreshToken: string }
export interface CredentialStore { read(): Promise<SavedLogin | null>; write(value: SavedLogin): Promise<void>; clear(): Promise<void> }

export class CompanyError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message); this.name = 'CompanyError';
  }
}
