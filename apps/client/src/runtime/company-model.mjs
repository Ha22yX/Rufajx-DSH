import { importUpstream, bridgeConfig, companyRequest } from './import-upstream.mjs';
const { registerDeepSeekProvider, resolveAdapterOptions, catalogModelInfo } = await importUpstream('@deepseek-ai/dsh-llm-deepseek');
export const name = 'rufa-company-model';
export const inject = ['llm'];
export async function apply(ctx) {
  const { origin, token } = bridgeConfig();
  let catalog;
  const load = async () => {
    const result = await companyRequest('GET', '/models');
    if (!Array.isArray(result.models) || result.models.length === 0) throw new Error('公司服务器尚未配置可用模型。');
    const defaults = resolveAdapterOptions({ baseURL: `${origin}/deepseek/anthropic` }).models;
    catalog = result.models.map(model => ({
      ...defaults.find(entry => entry.id === model.id),
      id: model.id, name: model.displayName,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutputTokens ? { maxTokens: model.maxOutputTokens } : {}),
      inputModalities: model.inputModalities ?? defaults.find(entry => entry.id === model.id)?.inputModalities ?? ['text'],
    }));
  };
  await load();
  const options = () => resolveAdapterOptions({ baseURL: `${origin}/deepseek/anthropic`, models: catalog });
  registerDeepSeekProvider(ctx, 'deepseek-official', {
    providerName: '公司 DeepSeek', options,
    resolveAuth: async () => ({ headers: { 'x-api-key': token } }),
    discoverModels: async provider => { await load(); return catalog.map(model => catalogModelInfo(provider, model)); },
  });
  // No configurable-provider registration: employees cannot edit a managed route.
}
