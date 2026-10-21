import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, writeFile, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone opt-in native integration; no production identity, registry or app.
const client = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = name => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`Required option: ${name}`);
  return resolve(process.argv[i + 1]);
};
const makensis = option('--makensis');
const sevenZip = option('--seven-zip');
const work = await mkdtemp(join(tmpdir(), 'rufa-nsis-direct-test-'));
const q = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
const run = (file, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { windowsHide: true, ...options });
  let output = '';
  child.stdout?.on('data', bytes => { output += bytes; });
  child.stderr?.on('data', bytes => { output += bytes; });
  child.on('error', reject);
  const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${file}`)); }, 180_000);
  child.on('exit', code => { clearTimeout(timer); resolve({ code, output }); });
});
const exists = path => access(path).then(() => true, () => false);
const source = join(work, '输入 文件');
await mkdir(join(source, '目录'), { recursive: true });
await writeFile(join(source, '目录/内容.txt'), '保持全部文件字节\n'.repeat(10000));
const archive = join(work, 'valid.7z');
assert.equal((await run(sevenZip, ['a', '-t7z', '-mx=1', archive, '.'], { cwd: source })).code, 0);
const bytes = await readFile(archive);
await writeFile(join(work, 'truncated.7z'), bytes.subarray(0, Math.floor(bytes.length / 2)));
const damaged = Buffer.from(bytes);
damaged[Math.floor(damaged.length / 2)] ^= 0xff;
await writeFile(join(work, 'damaged.7z'), damaged);
const cases = [];

async function execute(name, input, setup, synthetic = false, runner) {
  const folder = join(work, name);
  const target = join(folder, '安装 目录');
  await mkdir(target, { recursive: true });
  const receipt = join(folder, 'success.txt');
  const trace = join(folder, 'progress.txt');
  if (setup) await setup(target);
  const script = `Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Rufa isolated extractor test"
OutFile "${q(join(folder, 'test.exe'))}"
!addplugindir /x86-unicode "${q(join(client, 'preinstalled/installer/x86-unicode'))}"
!macro rufaExtractionProgressObserved
  FileOpen $R7 "${q(trace)}" a
  FileSeek $R7 0 END
  FileWrite $R7 "$rufaExtractDone,$rufaExtractTotal,$rufaExtractPercent,$rufaExtractDoneMB,$rufaExtractTotalMB$\\r$\\n"
  FileClose $R7
!macroend
!include "${q(join(client, 'scripts/installer-direct.nsh'))}"
Section
  StrCpy $INSTDIR "${q(target)}"
  ${synthetic ? 'Push "5368709120"\n  Push "3221225472"\n  Call RufaExtractProgress' : `!insertmacro rufaExtractUsing7za "${q(input)}"`}
  FileOpen $R7 "${q(receipt)}" w
  FileWrite $R7 "completed"
  FileClose $R7
SectionEnd
`;
  const scriptFile = join(folder, 'test.nsi');
  await writeFile(scriptFile, '\ufeff' + script);
  const compile = await run(makensis, ['/V2', scriptFile]);
  await writeFile(join(folder, 'compile.log'), compile.output);
  assert.equal(compile.code, 0, compile.output);
  const started = Date.now();
  const result = runner ? await runner(join(folder, 'test.exe'), target) : await run(join(folder, 'test.exe'), ['/S']);
  const progress = await readFile(trace, 'utf8').catch(() => '');
  return { name, exit: result.code, receipt: await exists(receipt), elapsedMs: Date.now() - started, progress: progress.trim().split(/\r?\n/).filter(Boolean), target };
}

try {
  const good = await execute('valid-chinese-spaces', archive);
  assert.equal(good.exit, 0);
  assert.equal(good.receipt, true);
  assert.deepEqual(await readFile(join(good.target, '目录/内容.txt')), await readFile(join(source, '目录/内容.txt')));
  assert.ok(good.progress.length > 0);
  cases.push(good);
  for (const name of ['truncated', 'damaged', 'missing']) {
    const failed = await execute(name, join(work, `${name}.7z`));
    assert.notEqual(failed.exit, 0, name);
    assert.equal(failed.receipt, false, name);
    cases.push(failed);
  }
  const denied = await execute('blocked-directory', archive, target => writeFile(join(target, '目录'), 'pre-existing sentinel'));
  assert.notEqual(denied.exit, 0);
  assert.equal(denied.receipt, false);
  assert.equal(await readFile(join(denied.target, '目录'), 'utf8'), 'pre-existing sentinel');
  cases.push(denied);
  const locked = await execute('locked-file', archive, async target => {
    await mkdir(join(target, '目录'));
    await writeFile(join(target, '目录/内容.txt'), 'locked sentinel');
  }, false, (exe, target) => {
    const ps = value => `'${value.replaceAll("'", "''")}'`;
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$f=[IO.File]::Open(${ps(join(target, '目录/内容.txt'))},'Open','ReadWrite','None'); try { $p=Start-Process -FilePath ${ps(exe)} -ArgumentList '/S' -WindowStyle Hidden -PassThru; $p.WaitForExit(); exit $p.ExitCode } finally { $f.Dispose() }`]);
  });
  assert.notEqual(locked.exit, 0);
  assert.equal(locked.receipt, false);
  assert.equal(await readFile(join(locked.target, '目录/内容.txt'), 'utf8'), 'locked sentinel');
  cases.push(locked);
  const wide = await execute('64-bit-progress', archive, null, true);
  assert.equal(wide.exit, 0);
  assert.deepEqual(wide.progress, ['3221225472,5368709120,60,3072,5120']);
  cases.push({ ...wide, simulatedCounter: true });
  if (process.argv.includes('--arm64-source')) {
    const arm64Source = option('--arm64-source');
    const inputs = join(work, 'arm64-inputs');
    await mkdir(inputs);
    const names = ['conpty.dll', 'OpenConsole.exe'];
    const originalHashes = {};
    for (const name of names) {
      const data = await readFile(join(arm64Source, name));
      await writeFile(join(inputs, name), data);
      originalHashes[name] = createHash('sha256').update(data).digest('hex');
    }
    for (const compatible of [false, true]) {
      const output = join(work, compatible ? 'arm64-bcj.7z' : 'arm64-default.7z');
      const args = ['a', '-t7z', '-mx=9', '-mmt=2', ...(compatible ? ['-mf=BCJ'] : []), output, '.'];
      assert.equal((await run(sevenZip, args, { cwd: inputs })).code, 0);
      const listing = await run(sevenZip, ['l', '-slt', output]);
      const methods = listing.output.split(/\r?\n/).filter(line => line.startsWith('Method = '));
      assert.ok(compatible ? methods.every(line => !line.includes('ARM64')) : methods.some(line => line.includes('ARM64')));
      const result = await execute(compatible ? 'arm64-bcj-compatible' : 'arm64-unsupported-filter', output);
      if (compatible) {
        assert.equal(result.exit, 0);
        assert.equal(result.receipt, true);
        for (const name of names) assert.equal(createHash('sha256').update(await readFile(join(result.target, name))).digest('hex'), originalHashes[name]);
      } else {
        assert.notEqual(result.exit, 0);
        assert.equal(result.receipt, false);
      }
      cases.push({ ...result, archiveMethods: methods, sourceSHA256: originalHashes });
    }
  }
  if (process.argv.includes('--large')) {
    const reused = process.argv.includes('--large-archive');
    const largeArchive = reused ? option('--large-archive') : join(work, 'large.7z');
    const largeSource = join(reused ? dirname(largeArchive) : work, 'large-source');
    if (!reused) {
      await mkdir(largeSource);
      const handle = await open(join(largeSource, '5GiB.bin'), 'wx');
      await handle.truncate(5 * 1024 ** 3);
      await handle.close();
      assert.equal((await run(sevenZip, ['a', '-t7z', '-mx=1', '-mmt=2', largeArchive, '.'], { cwd: largeSource })).code, 0);
    }
    const large = await execute('actual-5GiB', largeArchive);
    assert.equal(large.exit, 0);
    assert.equal(large.receipt, true);
    assert.equal((await stat(join(large.target, '5GiB.bin'))).size, 5 * 1024 ** 3);
    const hashFile = async path => { const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex'); };
    large.sourceSHA256 = await hashFile(join(largeSource, '5GiB.bin'));
    large.extractedSHA256 = await hashFile(join(large.target, '5GiB.bin'));
    assert.equal(large.sourceSHA256, large.extractedSHA256);
    assert.ok(large.progress.some(row => BigInt(row.split(',')[0]) > 4n * 1024n ** 3n));
    assert.ok(large.progress.every(row => row.split(',')[1] === '5368709120'));
    assert.ok(large.progress.length > 10, 'Continuous progress must occur before decoder completion');
    assert.ok(large.progress.some(row => Number(row.split(',')[2]) > 0 && Number(row.split(',')[2]) < 90));
    cases.push({ ...large, actualLargeFile: true });
  }
  for (const item of cases) assert.ok(item.progress.every(row => Number(row.split(',')[2]) < 100), 'No completion percentage before successful decoder return');
  await writeFile(join(work, 'report.json'), JSON.stringify({ ok: true, cases }, null, 2));
  console.log(JSON.stringify({ ok: true, cases: cases.length, work }));
} catch (error) {
  await writeFile(join(work, 'report.json'), JSON.stringify({ ok: false, cases, error: String(error) }, null, 2));
  console.error(JSON.stringify({ ok: false, work, error: String(error) }));
  throw error;
}
