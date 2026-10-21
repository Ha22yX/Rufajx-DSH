import { importUpstream, bridgeConfig, companyRequest } from './import-upstream.mjs';
const { DeepSeekSearchProvider, DEEPSEEK_DEFAULT_API_VERSION, DEEPSEEK_DEFAULT_MAX_TOKENS, DEEPSEEK_DEFAULT_MAX_USES } = await importUpstream('@deepseek-ai/dsh-web-search-deepseek');
const { DeepSeekSearchApiProvider, DeepSeekFetchApiProvider } = await importUpstream('@deepseek-ai/dsh-web-deepseek-api');
export const name = 'rufa-company-web';
export const inject = ['web'];
export async function apply(ctx) {
  const { origin, token } = bridgeConfig();
  const { models } = await companyRequest('GET', '/models');
  if (!models?.length) throw new Error('Company model catalog is empty');
  ctx.web.registerSearchProvider(new DeepSeekSearchProvider(() => ({
    baseURL: `${origin}/deepseek/anthropic/v1`, apiKey: token, model: models[0].id,
    apiVersion: DEEPSEEK_DEFAULT_API_VERSION, maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS, maxUses: DEEPSEEK_DEFAULT_MAX_USES,
    recordRequest: request => ctx.get('agents')?.currentInitiator()?.session.append('web/deepseek-search-llm-request', request),
  })));
  ctx.web.registerSearchProvider(new DeepSeekSearchApiProvider(() => ({ baseURL: `${origin}/deepseek`, apiKey: token, count: 10 })));
  ctx.web.registerFetchProvider(new DeepSeekFetchApiProvider(() => ({ baseURL: `${origin}/deepseek`, apiKey: token })));
}
