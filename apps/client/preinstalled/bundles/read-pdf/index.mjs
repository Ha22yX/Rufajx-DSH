import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { executePdf, planPdf } from './execution.mjs';

export const name = 'pdf-reader';
export const inject = ['tools', 'workingDirectory', 'sandboxPolicy'];
export const Config = z.object({ dpi: z.number().step(1).min(72).max(300).default(200), timeoutMs: z.number().step(1).min(1000).max(300000).default(120000) });
const path = { type: 'string', required: true, description: 'PDF文件绝对路径，或相对当前会话工作目录的路径。' };
const pages = { type: 'string', description: '页码范围，如1-3,5。默认前50页，每次最多50页，后续可分批读取。' };
const dpi = { type: 'integer', description: '72到300之间的DPI，OCR默认200、渲染默认150。' };
const definitions = [
  ['info', '查看本机PDF页数和前几页文字量，不修改输入文件。', { path }],
  ['text', '提取本机PDF文字层，不修改文件；每次最多50页。', { path, pages }],
  ['ocr', '使用本机OCR识别扫描PDF，不调用云端OCR、不修改文件；每次最多50页。', { path, pages, dpi }],
  ['render', '把PDF页面写成PNG，输出到当前会话工作目录中新建的pdf-pages-*目录，不覆盖现有文件。此操作会写入文件；每次最多50页。', { path, pages, dpi }],
  ['find', '递归查找本机目录中的PDF文件名，默认当前会话工作目录，不修改文件。', {
    directory: { type: 'string', description: '查找目录，默认当前会话工作目录。' },
    keyword: { type: 'string', description: '可选文件名关键词。' },
    max_results: { type: 'integer', description: '最多返回1到100条，默认20。' },
  }],
];

export function apply(ctx, config) {
  const runtimeRoot = process.env.RUFA_RUNTIME_ROOT;
  if (!runtimeRoot) throw new Error('PDF插件仅用于已配置的公司客户端运行环境。');
  for (const [action, description, parameters] of definitions) ctx.tools.register(defineTool({
    name: `pdf_${action}`, description, parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => action !== 'render' && action !== 'ocr',
    async execute(args, exec) {
      if (!exec.agent) throw new Error('PDF工具必须从当前会话调用。');
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session });
      const plan = await planPdf(action, args, { cwd, policy, runtimeRoot, defaultDpi: config.dpi, signal: exec.signal });
      return executePdf(plan, { runtimeRoot, timeoutMs: config.timeoutMs, signal: exec.signal });
    },
    presentCall: args => ({ card: 'generic', title: `PDF ${action}`, kind: action === 'render' ? 'other' : 'read', rawInput: args }),
  }));
}
