import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { previewFileVersions } from '../apps/client/src/runtime/file-version-preview.mjs';

test('file history explains real Word, Excel and PPT changes without modifying originals',
  { skip: !process.env.RUFA_TEST_PYTHON, timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rufa-version-previews-'));
  const pythonPath = process.env.RUFA_TEST_PYTHON;
  execFileSync(pythonPath, ['-I', '-B', fileURLToPath(new URL('./fixtures/file-version-documents.py', import.meta.url)), directory], { windowsHide: true });
  const originals = new Map(await Promise.all((await readdir(directory)).map(async name => [name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex')])));
  const preview = (type, name) => previewFileVersions({ beforePath: join(directory, `${type}-1.blob`), afterPath: join(directory, `${type}-2.blob`), name, pythonPath });
  const word = await preview('word', '合同.docx');
  assert.equal(word.kind, 'office');
  assert.ok(word.changes.some(row => row.before.includes('11月1日') && row.after.includes('11月8日')));
  assert.ok(word.changes.some(row => row.before.includes('1000') && row.after.includes('1200')), 'Word table cell text is included');
  const excel = await preview('excel', '报价.xlsx');
  assert.equal(excel.kind, 'office');
  assert.ok(excel.changes.some(row => row.location === '工作表「销售」· B2' && row.before === '1000' && row.after === '1200'));
  assert.ok(excel.changes.some(row => row.location.endsWith('C2') && row.after === '=B2*1.2'));
  assert.equal(excel.changes.some(row => row.location.endsWith('D2')), false);
  const slides = await preview('slides', '汇报.pptx');
  assert.equal(slides.kind, 'office');
  assert.ok(slides.changes.some(row => row.location === '第 1 页' && row.before.includes('3 项') && row.after.includes('5 项')));
  assert.ok([word, excel, slides].every(result => result.notice.includes('版式') && result.notice.includes('完整原文件')));
  for (const unsafe of ['untrusted', 'oversized']) {
    const value = await previewFileVersions({ beforePath: null, afterPath: join(directory, `${unsafe}.blob`), name: '合同.docx', pythonPath });
    assert.equal(value.kind, 'binary');
    assert.deepEqual(value.changes, []);
  }
  const added = await previewFileVersions({ beforePath: null, afterPath: join(directory, 'excel-2.blob'), name: '新增.xlsx', pythonPath });
  assert.ok(added.changes.every(row => row.before === ''));
  const left = join(directory, 'left'), right = join(directory, 'right');
  await writeFile(left, Buffer.concat([Buffer.from([255,254]), Buffer.from('第一行\r\n原内容\r\n','utf16le')]));
  await writeFile(right, '第一行\n新内容\n');
  const text = await previewFileVersions({ beforePath: left, afterPath: right, name: '说明.txt', pythonPath });
  assert.equal(text.kind, 'text');
  assert.deepEqual(text.changes.map(row => [row.before, row.after]), [['原内容', '新内容']]);
  await writeFile(right, 'x'.repeat(2*1024*1024+1));
  assert.equal((await previewFileVersions({ beforePath: left, afterPath: right, name: '大文本.txt', pythonPath })).kind, 'binary');
  for (const [name, hash] of originals) assert.equal(createHash('sha256').update(await readFile(join(directory, name))).digest('hex'), hash, `${name} remains byte-for-byte unchanged`);
  t.diagnostic(`Office parser fixtures and bounded fallback verified: ${directory}`);
});
