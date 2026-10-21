import { lstat } from 'node:fs/promises';
import { extname, isAbsolute, parse, resolve } from 'node:path';

export const badgeFormats = new Set(['png', 'svg', 'docx', 'xlsx', 'pptx', 'pdf', 'html', 'htm', 'md', 'markdown']);
export function parseCompanyBadgeArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['operation', 'path', 'sources'].includes(key))
    || !['read', 'stamp'].includes(args.operation) || typeof args.path !== 'string'
    || args.sources !== undefined && (!Array.isArray(args.sources) || args.sources.length > 16 || args.sources.some(path => typeof path !== 'string'))
    || args.operation === 'read' && args.sources?.length) throw new Error('徽章工具参数无效；账号署名由公司登录自动提供。');
  return args;
}

export async function validateBadgePath(value, cwd, validateScope) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32768 || /[\0-\x1f]/.test(value)
    || /^(?:\\\\[?.]\\|\\\?\?\\)/.test(value) || !isAbsolute(cwd ?? '')) throw new Error('徽章文件路径无效。');
  const path = resolve(cwd, value), rest = path.slice(parse(path).root.length);
  if (rest.split(/[\\/]/).some(part => !part || part.includes(':') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    || process.platform === 'win32' && /[. ]$/.test(part))) throw new Error('不支持设备、数据流或不明确的文件路径。');
  if (!badgeFormats.has(extname(path).slice(1).toLowerCase())) throw new Error('徽章署名暂不支持这种文件格式。');
  await validateScope(path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 256 * 1024 * 1024) throw new Error('仅支持不超过 256 MB、没有链接的现有普通文件。');
  return path;
}
