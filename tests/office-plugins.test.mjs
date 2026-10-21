import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { checkPreinstalledRuntime, patchOcrHostSource, patchOcrClientSource, patchAttachmentExportsSource } from '../scripts/preinstalled-runtime.mjs';

const run = promisify(execFile);
test('bundled Office/PDF/OCR work locally with real documents and scanned Chinese text', { skip: !process.env.RUFA_RUNTIME_ROOT, timeout: 180000 }, async t => {
  const root = process.env.RUFA_RUNTIME_ROOT;
  await checkPreinstalledRuntime(root, { syncWrappers: true });
  const temporary = await mkdtemp(join(tmpdir(), 'rufa-office-plugins-'));
  const python = join(root, 'company-python/python.exe');
  await run(python, ['-X', 'utf8', fileURLToPath(new URL('./fixtures/create-office-samples.py', import.meta.url)), temporary], { windowsHide: true, timeout: 30000 });
  const ocr = await import(pathToFileURL(join(root, 'node_modules/dsh-file-upload-ocr-plugin/lib/index.js')).href);
  let handler;
  ocr.apply({ effect: callback => callback(), webServer: { register: route => { handler = route.handler; return () => {}; } } },
    ocr.Config({ pythonCommand: python, timeoutMs: 60000, maxPages: 5 }));
  const server = createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await t.test('Word, Excel, PowerPoint, PDF and UTF-8 text preserve extracted Chinese content', async () => {
      for (const [file, kind] of [['sample.docx', 'word'], ['sample.xlsx', 'excel'], ['sample.pptx', 'powerpoint'], ['sample.pdf', 'pdf'], ['sample.txt', 'text']]) {
        const response = await fetch(origin, { method: 'POST', headers: { origin, 'x-dsh-file-name': encodeURIComponent(file) }, body: await readFile(join(temporary, file)) });
        assert.equal(response.status, 200, file);
        const value = await response.json(); assert.equal(value.kind, kind); assert.match(value.text, /Rufa office test 2026/); assert.match(value.text, /如发机械/);
      }
    });
    await t.test('scanned PDF and image use bundled OCR models without a cloud service', async () => {
      for (const file of ['scan.png', 'scanned.pdf']) {
        const response = await fetch(origin, { method: 'POST', headers: { origin, 'x-dsh-file-name': file }, body: await readFile(join(temporary, file)) });
        const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); assert.match(value.text, /Rufa.*2026/i); assert.match(value.text, /如发机械/);
      }
    });
    await t.test('local extraction rejects foreign origins, path-like names and invalid PDFs without crashing', async () => {
      for (const [name, from, status] of [['sample.txt', 'https://foreign.invalid', 403], ['../sample.txt', origin, 400], ['broken.pdf', origin, 400]]) {
        const response = await fetch(origin, { method: 'POST', headers: { origin: from, 'x-dsh-file-name': encodeURIComponent(name) }, body: Buffer.from('not-a-pdf') });
        assert.equal(response.status, status);
      }
    });
    await t.test('PDF CLI reads and renders using the portable interpreter', async () => {
      const script = join(root, 'company-tools/dsh-read-pdf/pdf_tools.py');
      const options = { cwd: temporary, windowsHide: true, timeout: 60000, encoding: 'utf8' };
      const text = await run(python, ['-X', 'utf8', script, 'text', 'sample.pdf', '--pages', '1'], options);
      assert.match(text.stdout, /如发机械/);
      await run(python, ['-X', 'utf8', script, 'render', 'sample.pdf', '--pages', '1', '--out', join(temporary, 'rendered')], options);
      await access(join(temporary, 'rendered/sample_p001.png'));
    });
    await t.test('native LibreOffice exports a document and recalculates a workbook', async () => {
      const cli = join(root, 'node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js');
      const options = { windowsHide: true, timeout: 90000, encoding: 'utf8' };
      await run(process.execPath, [cli, 'convert', '--input', join(temporary, 'sample.docx'), '--output', join(temporary, 'converted.pdf')], options);
      assert.equal((await readFile(join(temporary, 'converted.pdf'))).subarray(0, 4).toString(), '%PDF');
      await run(process.execPath, [cli, 'recalculate', '--input', join(temporary, 'sample.xlsx'), '--output', join(temporary, 'calculated.xlsx')], options);
      const result = await run(python, ['-c', 'import openpyxl,sys; print(openpyxl.load_workbook(sys.argv[1],data_only=True).active["A4"].value)', join(temporary, 'calculated.xlsx')], options);
      assert.equal(result.stdout.trim(), '30');
    });
    await t.test('compatibility patches are repeatable and retain the native attachment components', async () => {
      for (const [file, patch] of [['dsh-file-upload-ocr-plugin/lib/index.js', patchOcrHostSource], ['dsh-file-upload-ocr-plugin/lib/client.js', patchOcrClientSource], ['@deepseek-ai/dsh-client-ui-attachment/lib/client.js', patchAttachmentExportsSource]]) {
        const source = await readFile(join(root, 'node_modules', file), 'utf8'); assert.equal(patch(source), source); assert.throws(() => patch('unknown-version'));
      }
    });
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  t.diagnostic(`Real local Python, OCR models and LibreOffice engines; synthetic fixtures: ${temporary}`);
});
