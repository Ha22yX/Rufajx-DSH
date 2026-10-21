import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, readdir, symlink, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pageSelection, pdfEnvironment, planPdf, executePdf } from '../preinstalled/bundles/read-pdf/execution.mjs';

const runtime = process.env.RUFA_RUNTIME_ROOT;
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'rufa-office-test-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  return root;
}
test('PDF arguments bound pages and remove credentials and executable hooks from child environment', () => {
  assert.equal(pageSelection(), '1-50'); assert.equal(pageSelection('5,1-3,2'), '1,2,3,5');
  for (const pages of ['0', '-1', '1-51', '3-1', '1-50,100', '1; whoami', '1000001', '1e3']) assert.throws(() => pageSelection(pages));
  assert.deepEqual(pdfEnvironment({ PATH: 'tools', SYSTEMROOT: 'Windows', RUFA_BRIDGE_TOKEN: 'synthetic-secret', DEEPSEEK_API_KEY: 'synthetic-key', PYTHONPATH: 'evil', PYTHONSTARTUP: 'evil', NODE_OPTIONS: 'evil', HTTP_PROXY: 'evil', DSH_HOME: 'other-account' }), { PATH: 'tools', SYSTEMROOT: 'Windows' });
});
test('PDF plans use the current workspace and confine render output before creating files', async t => {
  const root = await temporary(t), workspace = join(root, 'workspace'), installation = join(root, 'runtime'), outside = join(root, 'outside');
  await Promise.all([workspace, installation, outside].map(path => mkdir(path)));
  await writeFile(join(workspace, 'space 文档.pdf'), 'synthetic fixture');
  await writeFile(join(installation, 'installed.pdf'), 'synthetic fixture');
  const base = { cwd: workspace, runtimeRoot: installation, policy: { mode: 'workspace-write', workspaceRoot: workspace } };
  const find = await planPdf('find', { keyword: '--help' }, base);
  assert.deepEqual(find.args, ['find', '--dir', await realpath(workspace), '--top', '20', '--', '--help']);
  assert.equal((await planPdf('text', { path: 'space 文档.pdf' }, base)).args[1], await realpath(join(workspace, 'space 文档.pdf')));
  const before = await readdir(workspace);
  await assert.rejects(planPdf('render', { path: 'space 文档.pdf' }, { ...base, policy: { mode: 'read-only' } }), /只读/);
  await assert.rejects(planPdf('render', { path: 'space 文档.pdf' }, { ...base, policy: { mode: 'workspace-write', workspaceRoot: outside } }), /超出/);
  await assert.rejects(planPdf('render', { path: 'installed.pdf' }, { ...base, cwd: installation, policy: { mode: 'danger-full-access' } }), /安装目录/);
  await assert.rejects(planPdf('ocr', { path: 'space 文档.pdf', dpi: 999 }, base), /DPI/);
  assert.deepEqual(await readdir(workspace), before);
  const output = await planPdf('render', { path: 'space 文档.pdf', pages: '2-3' }, base);
  assert.equal(dirname(output.outputDirectory), await realpath(workspace));
  assert.equal(output.args.at(-1), output.outputDirectory);
  assert.equal(await readFile(join(workspace, 'space 文档.pdf'), 'utf8'), 'synthetic fixture');
  const alias = join(root, 'runtime-alias'); await symlink(installation, alias, 'junction');
  await assert.rejects(planPdf('render', { path: 'installed.pdf' }, { ...base, cwd: alias, policy: { mode: 'danger-full-access' } }), /安装目录/);
});
test('PDF process launch uses fixed executables, literal arguments, abort, bounded output and hidden windows', async t => {
  const root = await temporary(t), signal = new AbortController().signal;
  let seen;
  const output = await executePdf({ cwd: root, args: ['text', 'document $(whoami).pdf'] }, { runtimeRoot: root, signal }, (file, args, options, done) => {
    seen = { file, args, options }; done(null, 'synthetic text', '');
  });
  assert.equal(output, 'synthetic text'); assert.equal(seen.file, join(root, 'company-python/python.exe'));
  assert.deepEqual(seen.args, ['-I', '-B', '-X', 'utf8', join(root, 'company-tools/dsh-read-pdf/pdf_tools.py'), 'text', 'document $(whoami).pdf']);
  assert.equal(seen.options.cwd, root); assert.equal(seen.options.signal, signal);
  assert.equal(seen.options.windowsHide, true); assert.equal(seen.options.shell, undefined); assert.equal(seen.options.maxBuffer, 2 * 1024 * 1024);
  const cancel = new AbortController(); cancel.abort(new Error('cancelled'));
  await assert.rejects(executePdf({ cwd: root, args: [] }, { runtimeRoot: root, signal: cancel.signal }, () => assert.fail('aborted operation must not spawn')), /cancelled/);
});
test('native registry admits five PDF tools and a denied tool never reaches filesystem or subprocess execution', { skip: !runtime }, async t => {
  const root = await temporary(t), install = join(root, 'node_modules/@rufa/dsh-read-pdf-bundle');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(await realpath(join(runtime, 'node_modules/@deepseek-ai')), join(root, 'node_modules/@deepseek-ai'), 'junction');
  await cp(fileURLToPath(new URL('../preinstalled/bundles/read-pdf', import.meta.url)), install, { recursive: true });
  const require = createRequire(join(runtime, 'package.json'));
  const native = async name => import(pathToFileURL(require.resolve(name)).href);
  const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime }, pdf] = await Promise.all([
    native('@deepseek-ai/cordis'), native('@deepseek-ai/dsh-system-prompt'), native('@deepseek-ai/dsh-tools'), import(pathToFileURL(join(install, 'index.mjs')).href),
  ]);
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime);
    // Required service seams stay unused: the native gate must reject first.
    ctx.provide('workingDirectory', { ensure() { assert.fail('denied tools must not resolve cwd'); } });
    ctx.provide('sandboxPolicy', { resolve() { assert.fail('denied tools must not resolve policy'); } });
    const fork = ctx.plugin(pdf); await fork;
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), ['pdf_find', 'pdf_info', 'pdf_ocr', 'pdf_render', 'pdf_text']);
    ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'synthetic policy rejection' }));
    for (const action of ['find', 'info', 'text', 'ocr', 'render']) {
      const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: `pdf-${action}`, name: `pdf_${action}`, arguments: action === 'find' ? {} : { path: 'missing.pdf' } });
      assert.equal(result.isError, true); assert.match(result.content[0].text, /synthetic policy rejection/);
    }
    await fork.dispose(); assert.equal(ctx.tools.schemas().some(tool => tool.name.startsWith('pdf_')), false);
  } finally { await ctx.fiber.dispose(); }
});
test('bundled Python and original PDF script extract and render a synthetic document without model requests', { skip: !runtime }, async t => {
  const root = await temporary(t), document = join(root, 'synthetic.pdf');
  const python = join(runtime, 'company-python/python.exe');
  await promisify(execFile)(python, ['-I', '-X', 'utf8', '-c', 'import pymupdf,sys; d=pymupdf.open(); p=d.new_page(); p.insert_text((72,72), "Synthetic company PDF 42"); d.save(sys.argv[1]); d.close()', document], { env: pdfEnvironment(), windowsHide: true });
  const before = await readFile(document);
  const options = { cwd: root, runtimeRoot: runtime, policy: { mode: 'workspace-write', workspaceRoot: root } };
  const info = await executePdf(await planPdf('info', { path: document }, options), { runtimeRoot: runtime }); assert.match(info, /页数: 1/);
  const text = await executePdf(await planPdf('text', { path: document, pages: '1' }, options), { runtimeRoot: runtime }); assert.match(text, /Synthetic company PDF 42/);
  const found = await executePdf(await planPdf('find', { keyword: 'synthetic' }, options), { runtimeRoot: runtime }); assert.match(found, /synthetic\.pdf/);
  const render = await planPdf('render', { path: document, pages: '1', dpi: 72 }, options);
  await executePdf(render, { runtimeRoot: runtime });
  assert.equal((await readdir(render.outputDirectory)).length, 1);
  assert.deepEqual(await readFile(document), before);
});

test('an in-flight bundled Python process is cancelled and oversized output fails explicitly', { skip: !runtime }, async t => {
  const root = await temporary(t), installation = join(root, 'runtime'), toolDirectory = join(installation, 'company-tools/dsh-read-pdf');
  await mkdir(toolDirectory, { recursive: true });
  await symlink(await realpath(join(runtime, 'company-python')), join(installation, 'company-python'), 'junction');
  await writeFile(join(toolDirectory, 'pdf_tools.py'), 'import sys,time\nif sys.argv[1] == "slow": time.sleep(15)\nelse: print("x" * (3 * 1024 * 1024))\n');
  const cancel = new AbortController();
  const pending = executePdf({ cwd: root, args: ['slow'] }, { runtimeRoot: installation, signal: cancel.signal });
  const timer = setTimeout(() => cancel.abort(new Error('synthetic cancellation')), 150);
  const started = Date.now();
  try { await assert.rejects(pending, /synthetic cancellation/); assert.ok(Date.now() - started < 5000); }
  finally { clearTimeout(timer); }
  await assert.rejects(executePdf({ cwd: root, args: ['large'] }, { runtimeRoot: installation }), /2MiB/);
});
