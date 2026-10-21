import { CompanyError } from './types.js';

/** Fixed read-only endpoints; no renderer-controlled URL or filesystem path. */
export function adminReadQuery(kind: 'sessions' | 'overview', input: unknown): string {
  const value = input == null ? {} : input;
  if (typeof value !== 'object' || Array.isArray(value)) throw new CompanyError('INVALID_QUERY', '筛选条件无效。');
  const data = value as Record<string, unknown>, query = new URLSearchParams();
  const allowed = kind === 'sessions' ? ['ownerId', 'q', 'from', 'to', 'limit', 'cursor'] : ['from', 'to'];
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new CompanyError('INVALID_QUERY', '包含不支持的筛选条件。');
  for (const key of allowed) {
    const field = data[key];
    if (field == null || field === '') continue;
    if (key === 'limit') {
      if (!Number.isSafeInteger(field) || Number(field) < 1 || Number(field) > 1000) throw new CompanyError('INVALID_QUERY', '分页数量无效。');
    } else {
      if (typeof field !== 'string') throw new CompanyError('INVALID_QUERY', '筛选条件应为文字。');
      const limit = key === 'cursor' ? 8192 : key === 'q' ? 200 : 256;
      if (field.length > limit) throw new CompanyError('INVALID_QUERY', '筛选内容过长。');
      if ((key === 'from' || key === 'to') && (!/^\d{4}-\d{2}-\d{2}T/.test(field) || !Number.isFinite(Date.parse(field)))) throw new CompanyError('INVALID_QUERY', '请选择有效日期。');
    }
    query.set(key, String(field));
  }
  if (query.has('from') && query.has('to') && Date.parse(query.get('from')!) >= Date.parse(query.get('to')!)) throw new CompanyError('INVALID_QUERY', '结束日期不能早于开始日期。');
  if (kind === 'sessions' && !query.has('limit')) query.set('limit', '50');
  return `/admin/${kind}${query.size ? '?' + query : ''}`;
}
