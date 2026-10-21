import { importUpstream, bridgeConfig } from './import-upstream.mjs';
const { CredentialProvider } = await importUpstream('@deepseek-ai/dsh-credentials');
export const name = 'rufa-managed-credentials';
class ManagedCredentials extends CredentialProvider {
  browserSession = undefined;
  async resolve(ref) { return ref === 'RUFA_GATEWAY_CAPABILITY' || ref === 'DEEPSEEK_API_KEY' ? { value: bridgeConfig().token, source: 'company' } : undefined; }
  async describe(ref) { return { configured: ref === 'RUFA_GATEWAY_CAPABILITY' || ref === 'DEEPSEEK_API_KEY', source: 'company', writable: false }; }
  async set() { throw new Error('模型凭据由公司服务端统一管理。'); }
  async unset() { throw new Error('模型凭据由公司服务端统一管理。'); }
  async readRecord(key) { return key === 'client-connection/browser-session' ? this.browserSession : undefined; }
  async describeRecord(key) { return { configured: key === 'client-connection/browser-session' && !!this.browserSession, writable: key === 'client-connection/browser-session' }; }
  async listRecords() { return []; }
  async modifyRecord(key, mutate) {
    if (key !== 'client-connection/browser-session') throw new Error('公司版不接受本地模型账号或密钥。');
    const next = await mutate(this.browserSession);
    if (next !== undefined) this.browserSession = next;
    return this.browserSession;
  }
  async deleteRecord() { throw new Error('公司版不接受本地模型账号或密钥。'); }
}
export function apply(ctx) { new ManagedCredentials(ctx); }
