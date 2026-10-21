import { execFile } from 'node:child_process';
import { mkdtemp, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_PAGES = 50;
export function pdfEnvironment(source = process.env) {
  const env = {};
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|LC_ALL)$/i;
  for (const [key, value] of Object.entries(source)) if (allowed.test(key)) env[key.toUpperCase()] = value;
  return env;
}
export function pageSelection(value) {
  if (value === undefined || value === '') return `1-${MAX_PAGES}`;
  if (typeof value !== 'string' || value.length > 1000 || !/^\s*\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*\s*$/.test(value)) throw new Error('页码格式应为 1-3,5。');
  const pages = new Set();
  for (const part of value.split(',')) {
    const [first, end = first] = part.split('-').map(value => Number(value.trim()));
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(end) || first < 1 || end > 1000000 || end < first || end - first + 1 > MAX_PAGES) throw new Error('每次最多处理50页，页码须为正整数。');
    for (let page = first; page <= end; page++) pages.add(page);
    if (pages.size > MAX_PAGES) throw new Error('每次最多处理50页，请分批调用。');
  }
  return [...pages].sort((a, b) => a - b).join(',');
}
function integer(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label}须在${minimum}到${maximum}之间。`);
  return value;
}
function inside(root, path) {
  const local = relative(root, path);
  return local === '' || (!local.startsWith(`..${sep}`) && local !== '..' && !isAbsolute(local));
}
async function target(cwd, input, directory) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error('请提供有效的文件或目录路径。');
  const path = await realpath(resolve(cwd, input));
  const info = await stat(path);
  if (directory ? !info.isDirectory() : !info.isFile() || !path.toLowerCase().endsWith('.pdf')) throw new Error(directory ? '查找路径必须是目录。' : '输入必须是PDF文件。');
  return path;
}

/** Uses the original repository CLI. This is a bounded local adapter, not an OS sandbox. */
export async function planPdf(action, args, { cwd, policy, runtimeRoot, defaultDpi = 200, signal }) {
  signal?.throwIfAborted();
  if (!isAbsolute(cwd)) throw new Error('PDF工具需要当前会话的绝对工作目录。');
  const canonicalCwd = await realpath(cwd);
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode)) throw new Error('无法确认当前会话文件权限。');
  if (action === 'find') {
    const directory = await target(canonicalCwd, args.directory ?? canonicalCwd, true);
    const keyword = args.keyword ?? '';
    if (typeof keyword !== 'string' || keyword.length > 200 || keyword.includes('\0')) throw new Error('文件名关键词过长或无效。');
    return { cwd: canonicalCwd, args: ['find', '--dir', directory, '--top', String(integer(args.max_results ?? 20, 1, 100, '结果数量')), '--', keyword] };
  }
  if (!['info', 'text', 'ocr', 'render'].includes(action)) throw new Error('不支持的PDF操作。');
  const path = await target(canonicalCwd, args.path, false);
  const command = [action, path];
  if (action !== 'info') command.push('--pages', pageSelection(args.pages));
  if (action === 'ocr' || action === 'render') command.push('--dpi', String(integer(args.dpi ?? (action === 'render' ? 150 : defaultDpi), 72, 300, 'DPI')));
  let outputDirectory;
  if (action === 'render') {
    if (policy.mode === 'read-only') throw new Error('当前会话为只读，不能生成PDF页面图片。');
    const installation = await realpath(runtimeRoot);
    if (inside(installation, canonicalCwd)) throw new Error('不能向客户端安装目录写入PDF页面图片，请切换工作目录。');
    if (policy.mode === 'workspace-write') {
      const workspace = await realpath(policy.workspaceRoot);
      if (!inside(workspace, canonicalCwd)) throw new Error('PDF输出目录超出当前会话允许写入的工作区。');
    }
    signal?.throwIfAborted();
    // A new owned directory avoids overwriting existing documents or following a
    // pre-existing output-directory symlink. No arbitrary --out argument is exposed.
    outputDirectory = await mkdtemp(join(canonicalCwd, 'pdf-pages-'));
    command.push('--out', outputDirectory);
  }
  return { cwd: canonicalCwd, args: command, outputDirectory };
}

export async function executePdf(plan, { runtimeRoot, timeoutMs = 120000, signal }, launch = execFile) {
  signal?.throwIfAborted();
  if (!isAbsolute(runtimeRoot)) throw new Error('预装PDF运行环境路径无效。');
  integer(timeoutMs, 1000, 300000, '超时毫秒数');
  const python = join(runtimeRoot, 'company-python', 'python.exe');
  const script = join(runtimeRoot, 'company-tools', 'dsh-read-pdf', 'pdf_tools.py');
  return new Promise((resolveResult, reject) => {
    launch(python, ['-I', '-B', '-X', 'utf8', script, ...plan.args], {
      cwd: plan.cwd, env: pdfEnvironment(), encoding: 'utf8', windowsHide: true,
      timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, signal,
    }, (error, stdout, stderr) => {
      if (error) {
        if (signal?.aborted) { reject(signal.reason); return; }
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { reject(new Error('PDF输出超过2MiB，请缩小页码范围后重试。')); return; }
        if (error.killed) { reject(new Error('PDF处理超时，请缩小页码范围后重试。')); return; }
        reject(new Error(`PDF处理失败：${String(stderr || error.message).trim().slice(0, 2000)}`)); return;
      }
      resolveResult(String(stdout || '(没有可返回的内容)'));
    });
  });
}
