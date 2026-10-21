import { CompanyError } from './types.js';
import { normalizeServerUrl } from './company-api.js';
import { win32 } from 'node:path';

export const COMPANY_SERVER = 'https://dsh.example.com';

export function companyProfile(productionRoot: string, packaged: boolean, testProfile?: string): { userRoot: string; isolatedTestProfile?: string } {
  if (packaged || !testProfile) return { userRoot: productionRoot };
  if (!win32.isAbsolute(testProfile) || /^[/\\](?![/\\])/.test(testProfile)) throw new CompanyError('INVALID_TEST_PROFILE', '测试必须使用独立的绝对路径数据目录。');
  const candidate = win32.resolve(testProfile);
  const normalize = (value: string) => win32.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  const target = normalize(candidate), production = normalize(productionRoot);
  if (target === production || target.startsWith(`${production}\\`) || production.startsWith(`${target}\\`)) {
    throw new CompanyError('INVALID_TEST_PROFILE', '测试数据目录不能与正式登录数据目录重叠。');
  }
  return { userRoot: candidate, isolatedTestProfile: candidate };
}

export function companyEndpoint(packaged: boolean, isolatedTestProfile?: string, testEndpoint?: string): { server: string; allowLocalHttp: boolean } {
  if (!packaged && isolatedTestProfile && testEndpoint) {
    const server = normalizeServerUrl(testEndpoint, true);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(server).hostname)) throw new CompanyError('INVALID_TEST_SERVER', '隔离测试只能连接本机模拟服务。');
    return { server, allowLocalHttp: true };
  }
  return { server: COMPANY_SERVER, allowLocalHttp: false };
}
