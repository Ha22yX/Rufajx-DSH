export interface ModelConfig { id: string; displayName: string; inputModalities?: string[]; contextWindow?: number; maxOutputTokens?: number; reasoningEfforts?: string[] }
export interface ServerConfig {
  clientReleasesDir?: string;
  clientUpdatePublicKeyFile?: string;
  upstreamBaseUrl: string; upstreamKey?: string; secretFile?: string; allowInsecureUpstream?: boolean;
  models: ModelConfig[]; accessTtlMs: number; refreshTtlMs: number; leaseTtlMs: number;
  bodyLimitBytes: number; fileUploadLimitBytes: number; maxConcurrent: number; maxUserConcurrent: number; maxConcurrentUploads: number;
  upstreamTimeoutMs: number; maxOutputTokens: number; logger?: boolean;
  now?: () => number;
}

// Advertise the same company-enforced output budget that the gateway accepts.
// An omitted catalog value must not let a client inherit a larger SDK default.
export function normalizeModelCatalog(models: readonly ModelConfig[], maxOutputTokens: number): ModelConfig[] {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('Invalid server output token limit');
  if (!Array.isArray(models) || models.length === 0) throw new Error('Invalid model catalog');
  const ids = new Set<string>();
  return models.map(model => {
    if (!model || typeof model.id !== 'string' || !model.id || typeof model.displayName !== 'string' || ids.has(model.id)) throw new Error('Invalid model catalog');
    ids.add(model.id);
    if (model.maxOutputTokens !== undefined && (!Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1)) throw new Error('Invalid model output token limit');
    const { id, displayName, inputModalities, contextWindow, reasoningEfforts } = model;
    // Reconstruct public fields; never pass arbitrary server configuration through.
    return { id, displayName, inputModalities, contextWindow, reasoningEfforts,
      maxOutputTokens: Math.min(model.maxOutputTokens ?? maxOutputTokens, maxOutputTokens) };
  });
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const int = (name: string, fallback: number, min = 1) => {
    if (!env[name]) return fallback;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
    return value;
  };
  const ids = (env.RUFA_ALLOWED_MODELS ?? 'deepseek-flash').split(',').map(item => item.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error('RUFA_ALLOWED_MODELS must not be empty');
  const maxOutputTokens = int('RUFA_MAX_OUTPUT_TOKENS', 384000);
  let models: ModelConfig[] = ids.map(id => id === 'deepseek-flash' ? {
    id, displayName: 'DeepSeek V4.1 Flash', inputModalities: ['text', 'image'],
    contextWindow: 1000000, maxOutputTokens: 384000,
  } : { id, displayName: id });
  if (env.RUFA_MODELS_JSON) {
    models = JSON.parse(env.RUFA_MODELS_JSON);
  }
  models = normalizeModelCatalog(models, maxOutputTokens);
  return {
    clientReleasesDir: env.RUFA_CLIENT_RELEASES_DIR,
    clientUpdatePublicKeyFile: env.RUFA_CLIENT_UPDATE_PUBLIC_KEY_FILE,
    upstreamBaseUrl: env.RUFA_UPSTREAM_BASE_URL ?? 'https://api.deepseek.com',
    upstreamKey: env.RUFA_UPSTREAM_API_KEY,
    secretFile: env.RUFA_SECRET_FILE,
    models, accessTtlMs: int('RUFA_ACCESS_TTL_SECONDS', 900) * 1000,
    refreshTtlMs: int('RUFA_REFRESH_TTL_DAYS', 14) * 86400000,
    leaseTtlMs: int('RUFA_LEASE_TTL_SECONDS', 120) * 1000,
    bodyLimitBytes: int('RUFA_BODY_LIMIT_BYTES', 32 * 1024 * 1024),
    fileUploadLimitBytes: int('RUFA_FILE_UPLOAD_LIMIT_BYTES', 129 * 1024 * 1024),
    maxConcurrent: int('RUFA_MAX_CONCURRENT', 12), maxUserConcurrent: int('RUFA_MAX_USER_CONCURRENT', 4),
    maxConcurrentUploads: int('RUFA_MAX_CONCURRENT_UPLOADS', 1),
    upstreamTimeoutMs: int('RUFA_UPSTREAM_TIMEOUT_SECONDS', 600) * 1000,
    maxOutputTokens,
    logger: env.RUFA_LOG_REQUESTS === 'true',
  };
}
