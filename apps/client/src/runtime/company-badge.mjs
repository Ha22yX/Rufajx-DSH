import { extname } from 'node:path';
import { importUpstream, companyRequest } from './import-upstream.mjs';
import { parseCompanyBadgeArguments } from './company-badge-paths.mjs';
import { runBadgeHelper } from './company-badge-process.mjs';

const { defineTool } = await importUpstream('@deepseek-ai/dsh-tools');
export const name = 'rufa-company-badge';

export async function executeCompanyBadge(args, execution, { versions, pythonPath, helperPath, lifetime,
  account = signal => companyRequest('GET', '/account', undefined, signal), run = runBadgeHelper }) {
  parseCompanyBadgeArguments(args);
  const signal = AbortSignal.any([execution.signal, lifetime]);
  const checked = { ...execution, signal };
  signal.throwIfAborted();
  const identity = async () => {
    const value = await account(signal); signal.throwIfAborted();
    const user = value?.user;
    if (!user || typeof user.id !== 'string' || !user.id || typeof user.username !== 'string' || !user.username.trim()
      || user.username.length > 128 || /[\0-\x1f\x7f]/.test(user.username)) throw new Error('无法确认当前公司登录账号。');
    return { id: user.id, username: user.username };
  };
  const user = await identity();
  const path = await versions.validateToolPath(checked, args.path);
  const sources = [];
  for (const source of args.sources ?? []) sources.push(await versions.validateToolPath(checked, source));
  signal.throwIfAborted();
  const result = await run({ pythonPath, helperPath, signal,
    request: { operation: args.operation, path, ...(args.operation === 'stamp' ? { username: user.username, sources } : {}) },
    beforePublish: async publishSignal => {
      const current = await account(publishSignal); publishSignal.throwIfAborted();
      if (current?.user?.id !== user.id || current?.user?.username !== user.username) throw new Error('公司登录账号已变化，徽章署名已取消。');
      for (const target of [path, ...sources]) await versions.validateToolPath({ ...checked, signal: publishSignal }, target);
      publishSignal.throwIfAborted();
    },
  });
  if (result.format !== extname(path).slice(1).toLowerCase()) throw new Error('徽章署名结果格式不一致，请核对文件。');
  return JSON.stringify(result);
}

export function apply(ctx, config) {
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  const receive = message => { if (message?.type === 'rufa:shutdown') stop(); };
  process.on('message', receive); process.on('disconnect', stop);
  ctx.effect(() => () => { stop(); process.off('message', receive); process.off('disconnect', stop); });
  ctx.provide('rufaCompanyBadgeTools', {
    register(badgeCtx) {
      // This child scope belongs to the native badge provider, so disabling the
      // ordinary skill unregisters the tool and cancels any pending publication.
      badgeCtx.inject(['tools', 'workingDirectory', 'rufaFileVersions'], scoped => {
        const enabled = new AbortController();
        scoped.effect(() => () => enabled.abort());
        scoped.tools.register(defineTool({
          name: 'company_badge',
          description: '读取或追加公司成果文件的隐藏作者署名，保持页面和徽章外观不变。stamp保留目标已有作者，可通过sources继承来源文件作者，自动追加当前公司登录用户名；不得自行提供用户名。read只读取。仅支持现有PNG、SVG、DOCX、XLSX、PPTX、PDF、HTML、MD文件，写入纳入文件历史版本。',
          parameters: {
            operation: { type: 'string', enum: ['read', 'stamp'], required: true },
            path: { type: 'string', description: '当前任务中需读取或署名的文件路径。', required: true },
            sources: { type: 'array', items: { type: 'string' }, description: 'stamp可选：最多16个来源文件，继承其已有署名。' },
          },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: (args, execution) => executeCompanyBadge(args, execution, { ...config, versions: scoped.rufaFileVersions,
            lifetime: AbortSignal.any([lifetime.signal, enabled.signal]) }),
          presentCall: args => ({ card: 'generic', title: args.operation === 'read' ? '读取公司署名' : '保存公司署名', kind: 'other', rawInput: args }),
        }));
      });
    },
  });
}
