import { EventEmitter } from 'node:events';
import { CompanyError, type CredentialStore, type LoginResponse, type PublicAuthState } from './types.js';

export function normalizeServerUrl(input: string, allowLocalHttp = false): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new CompanyError('INVALID_SERVER', '请输入有效的公司服务器地址。'); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new CompanyError('INVALID_SERVER', '服务器地址只能包含协议、域名和端口。');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:')) {
    throw new CompanyError('HTTPS_REQUIRED', '公司服务器必须使用 HTTPS。');
  }
  return url.origin;
}

function decodeLogin(value: unknown): LoginResponse {
  const x = value as LoginResponse;
  if (!x || typeof x.accessToken !== 'string' || !x.accessToken || typeof x.refreshToken !== 'string' || !x.refreshToken ||
      typeof x.deviceId !== 'string' || !x.deviceId || typeof x.expiresAt !== 'string' || !Number.isFinite(Date.parse(x.expiresAt)) ||
      !x.user || typeof x.user.id !== 'string' || typeof x.user.username !== 'string' || typeof x.user.displayName !== 'string' ||
      !['employee', 'admin'].includes(x.user.role)) throw new CompanyError('BAD_RESPONSE', '服务器登录响应不符合协议。');
  return { ...x, user: { id: x.user.id, username: x.user.username, displayName: x.user.displayName,
    jobTitle: typeof x.user.jobTitle === 'string' ? x.user.jobTitle : '', role: x.user.role } };
}

export class CompanyApi extends EventEmitter {
  #login: LoginResponse | null = null;
  #server: string | null = null;
  #refreshing: { generation: number; promise: Promise<void> } | null = null;
  #vaultTail: Promise<unknown> = Promise.resolve();
  #generation = 0;
  #loginLifecycle = 0;
  constructor(private readonly vault: CredentialStore, private readonly allowLocalHttp = false, private readonly request = fetch, private readonly trustedServer?: string) { super(); }

  get state(): PublicAuthState {
    return { user: this.#login ? { ...this.#login.user } : null, serverUrl: this.#server, deviceId: this.#login?.deviceId };
  }
  /** Main-process approval binding; never included in renderer state. */
  get authorizationEpoch(): number { return this.#generation; }
  /** Distinguish revocation of the same login from a new login/restore/logout attempt. Never public state. */
  get loginLifecycleEpoch(): number { return this.#loginLifecycle; }
  private changed() { this.emit('change', this.state); }
  private persist(generation: number, value: { serverUrl: string; refreshToken: string } | null): Promise<boolean> {
    const operation = this.#vaultTail.then(async () => {
      if (generation !== this.#generation) return false;
      if (value) await this.vault.write(value); else await this.vault.clear();
      return generation === this.#generation;
    });
    this.#vaultTail = operation.catch(() => {});
    return operation;
  }
  private async check(response: Response): Promise<Response> {
    if (response.ok) return response;
    let code = `HTTP_${response.status}`;
    let message = response.status === 401 ? '登录已失效，请重新登录。' : response.status === 403 ? '没有此操作的权限。' : '公司服务请求失败，请稍后重试。';
    try {
      const data = await response.json() as { error?: { code?: string; message?: string } };
      if (data.error?.code && /^[A-Z0-9_]{1,80}$/.test(data.error.code)) code = data.error.code;
      // Never echo arbitrary upstream/server text: it can contain credentials or local stack traces.
    } catch { /* Keep safe, local error text. */ }
    throw new CompanyError(code, message, response.status);
  }
  private async authRequest(server: string, path: string, body: unknown): Promise<LoginResponse> {
    const response = await this.request(`${server}/api/v1${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    return decodeLogin(await (await this.check(response)).json());
  }
  async login(serverInput: string, username: string, password: string, deviceLabel?: string): Promise<PublicAuthState> {
    const server = normalizeServerUrl(serverInput, this.allowLocalHttp);
    if (this.trustedServer && server !== this.trustedServer) throw new CompanyError('SERVER_NOT_ALLOWED', '此安装包只能连接指定的公司服务器。');
    if (!username.trim() || !password) throw new CompanyError('MISSING_LOGIN', '请输入账号和密码。');
    ++this.#loginLifecycle;
    const generation = ++this.#generation;
    const result = await this.authRequest(server, '/auth/login', { username: username.trim(), password, deviceLabel });
    if (generation !== this.#generation) throw new CompanyError('LOGIN_CANCELLED', '登录已取消。');
    let persisted;
    try { persisted = await this.persist(generation, { serverUrl: server, refreshToken: result.refreshToken }); }
    catch { throw new CompanyError('CREDENTIAL_STORE_FAILED', '无法安全保存登录凭据，请检查系统凭据存储。'); }
    if (!persisted) throw new CompanyError('LOGIN_CANCELLED', '登录已取消。');
    this.#server = server; this.#login = result; this.changed();
    return this.state;
  }
  async restore(): Promise<PublicAuthState> {
    ++this.#loginLifecycle;
    const generation = ++this.#generation;
    const saved = await this.vault.read();
    if (generation !== this.#generation) return this.state;
    if (!saved) return this.state;
    const server = normalizeServerUrl(saved.serverUrl, this.allowLocalHttp);
    if (this.trustedServer && server !== this.trustedServer) { await this.persist(generation, null); throw new CompanyError('SERVER_NOT_ALLOWED', '保存的登录不属于当前公司服务器。'); }
    try {
      const result = await this.authRequest(server, '/auth/refresh', { refreshToken: saved.refreshToken });
      if (generation !== this.#generation) return this.state;
      if (!await this.persist(generation, { serverUrl: server, refreshToken: result.refreshToken })) return this.state;
      this.#server = server; this.#login = result; this.changed();
    } catch (error) {
      if (error instanceof CompanyError && [401, 403].includes(error.status ?? 0)) await this.persist(generation, null);
      throw error;
    }
    return this.state;
  }
  async refresh(): Promise<void> {
    if (this.#refreshing?.generation === this.#generation) return this.#refreshing.promise;
    if (!this.#login || !this.#server) throw new CompanyError('LOGIN_REQUIRED', '请先登录公司账号。', 401);
    const generation = this.#generation;
    const server = this.#server;
    const refreshToken = this.#login.refreshToken;
    const promise = (async () => {
      try {
        const result = await this.authRequest(server, '/auth/refresh', { refreshToken });
        if (generation !== this.#generation) throw new CompanyError('LOGIN_CANCELLED', '登录已结束。', 401);
        if (!await this.persist(generation, { serverUrl: server, refreshToken: result.refreshToken })) throw new CompanyError('LOGIN_CANCELLED', '登录已结束。', 401);
        this.#login = result; this.changed();
      } catch (error) {
        if (error instanceof CompanyError && [401, 403].includes(error.status ?? 0) && generation === this.#generation) {
          this.#login = null; await this.persist(generation, null); this.changed();
        }
        throw error;
      } finally { if (this.#refreshing?.generation === generation) this.#refreshing = null; }
    })();
    this.#refreshing = { generation, promise };
    return promise;
  }
  async authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!/^\/[a-z][a-z0-9/?=&._%-]*$/i.test(path) || path.includes('..') || path.includes('//')) throw new CompanyError('INVALID_PATH', '无效的服务路径。');
    if (!this.#login || !this.#server) throw new CompanyError('LOGIN_REQUIRED', '请先登录公司账号。', 401);
    const generation = this.#generation;
    if (Date.parse(this.#login.expiresAt) < Date.now() + 30_000) await this.refresh();
    const send = () => {
      if (generation !== this.#generation) throw new CompanyError('LOGIN_CANCELLED', '请求所属的登录已结束。', 401);
      if (!this.#login || !this.#server) throw new CompanyError('LOGIN_REQUIRED', '请先登录公司账号。', 401);
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${this.#login.accessToken}`);
      return this.request(`${this.#server}/api/v1${path}`, { ...init, headers, redirect: 'error' });
    };
    let response = await send();
    if (generation !== this.#generation) { await response.body?.cancel(); throw new CompanyError('LOGIN_CANCELLED', '请求所属的登录已结束。', 401); }
    if (response.status === 401) { await response.body?.cancel(); await this.refresh(); response = await send(); }
    if (generation !== this.#generation) { await response.body?.cancel(); throw new CompanyError('LOGIN_CANCELLED', '请求所属的登录已结束。', 401); }
    return response;
  }
  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.check(await this.authorizedFetch(path, {
      method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }));
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
  async verify(): Promise<PublicAuthState> {
    const generation = this.#generation;
    try {
      const result = await this.json<{ user: LoginResponse['user'] }>('GET', '/auth/me');
      if (generation === this.#generation && this.#login) {
        this.#login.user = { id: result.user.id, username: result.user.username, displayName: result.user.displayName,
          jobTitle: typeof result.user.jobTitle === 'string' ? result.user.jobTitle : '', role: result.user.role };
        this.changed();
      }
      return this.state;
    } catch (error) {
      if (generation === this.#generation && error instanceof CompanyError && [401, 403].includes(error.status ?? 0)) {
        const revoked = ++this.#generation; this.#login = null; await this.persist(revoked, null); this.changed();
      }
      throw error;
    }
  }
  async changePassword(currentPassword: string, newPassword: string): Promise<{ userId: string; serverUrl: string; loginLifecycleEpoch: number }> {
    if (!this.#login || !this.#server) throw new CompanyError('LOGIN_REQUIRED', '请先登录公司账号。', 401);
    const receipt = { userId: this.#login.user.id, serverUrl: this.#server, loginLifecycleEpoch: this.#loginLifecycle };
    const generation = this.#generation;
    try {
      if (Date.parse(this.#login.expiresAt) < Date.now() + 30_000) await this.refresh();
      if (generation !== this.#generation || !this.#login || receipt.loginLifecycleEpoch !== this.#loginLifecycle) throw new CompanyError('LOGIN_CANCELLED', '修改请求所属的登录已结束。', 401);
      // A committed 204 remains authoritative when another in-flight request observes the resulting revocation.
      // Do not use authorizedFetch's general late-response rejection for this one mutation, and never retry it.
      const response = await this.request(`${receipt.serverUrl}/api/v1/auth/change-password`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#login.accessToken}` },
        body: JSON.stringify({ currentPassword, newPassword }), redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 204) return receipt;
      await this.check(response);
      throw new CompanyError('BAD_RESPONSE', '密码修改响应不符合协议，请确认后再登录。');
    }
    catch (error) {
      if (error instanceof CompanyError && [401, 403].includes(error.status ?? 0) && generation === this.#generation) {
        const revoked = ++this.#generation; this.#login = null;
        try { await this.persist(revoked, null); } finally { this.changed(); }
      }
      if (error instanceof CompanyError && error.status === 400 && error.code === 'INVALID_CURRENT_PASSWORD') {
        throw new CompanyError('INVALID_CURRENT_PASSWORD', '原密码不正确，请重新输入。', 400);
      }
      throw error;
    }
  }
  async updateProfile(displayName: string, jobTitle: string): Promise<PublicAuthState> {
    const generation = this.#generation, userId = this.#login?.user.id;
    const result = await this.json<{ user: LoginResponse['user'] }>('PATCH', '/auth/profile', { displayName, jobTitle });
    if (generation !== this.#generation || !this.#login) throw new CompanyError('LOGIN_CANCELLED', '资料修改所属的登录已结束。', 401);
    if (!result.user || result.user.id !== userId || typeof result.user.username !== 'string'
      || typeof result.user.displayName !== 'string' || typeof result.user.jobTitle !== 'string'
      || !['employee', 'admin'].includes(result.user.role)) throw new CompanyError('BAD_RESPONSE', '服务器账号资料响应不符合协议。');
    this.#login.user = { id: result.user.id, username: result.user.username, displayName: result.user.displayName,
      jobTitle: result.user.jobTitle, role: result.user.role };
    this.changed(); return this.state;
  }
  /** The server has already revoked this session; do not send a redundant logout request. */
  async clearLocalLogin(): Promise<void> {
    ++this.#loginLifecycle;
    const generation = ++this.#generation; this.#login = null;
    try { await this.persist(generation, null); }
    finally { this.changed(); }
  }
  async logout(): Promise<void> {
    ++this.#loginLifecycle;
    const old = this.#login; const server = this.#server;
    const generation = ++this.#generation; this.#login = null;
    await this.persist(generation, null); this.changed();
    if (old && server) {
      try { await this.request(`${server}/api/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${old.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(5_000) }); }
      catch { /* The local credential is always removed; remote expiry still applies. */ }
    }
  }
}
