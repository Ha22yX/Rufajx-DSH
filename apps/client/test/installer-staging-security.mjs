import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'This probe requires actual Windows ACL and junction semantics');
const client = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(process.env.LOCALAPPDATA, 'RufaDSH/Development/installer-tests');
await mkdir(base, { recursive: true });
const work = await mkdtemp(join(base, 'security-'));
const source = join(client, 'scripts/installer-upgrade-temp.cpp');
await copyFile(source, join(work, 'installer-upgrade-temp.cpp'));
await copyFile(join(client, 'test/fixtures/installer-staging-probe.cpp'), join(work, 'probe.cpp'));
const fixture = join(work, 'fixture');
for (const name of ['fresh', 'broad/.rufa', 'extra-trustee', 'container-link', 'outside', 'wrong-volume', 'canonical']) {
  await mkdir(join(fixture, name), { recursive: true });
}
await writeFile(join(fixture, 'broad/.rufa/keep.txt'), 'keep');
await writeFile(join(fixture, 'outside/keep.txt'), 'keep');
await symlink(join(fixture, 'outside'), join(fixture, 'container-link/.rufa'), 'junction');
await symlink(join(fixture, 'outside'), join(fixture, 'parent-link'), 'junction');
function run(executable, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd: work, windowsHide: true, shell: false, ...options });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', code => resolveResult({ code, output }));
  });
}
const visualStudio = process.env.RUFA_TEST_VISUAL_STUDIO || 'D:\\Program Files\\Microsoft Visual Studio\\18\\Community';
assert.doesNotMatch(visualStudio + work, /["\r\n%]/, 'Unsupported compiler path');
await writeFile(join(work, 'build.cmd'), `@echo off\r\ncall "${visualStudio}\\VC\\Auxiliary\\Build\\vcvars32.bat" >nul\r\nif errorlevel 1 exit /b 1\r\ncd /d "${work}"\r\ncl /nologo /std:c++17 /EHsc /O2 /MT /W4 probe.cpp /link /OUT:probe.exe advapi32.lib ole32.lib user32.lib\r\n`);
const build = await run(process.env.ComSpec, ['/d', '/c', join(work, 'build.cmd')]);
await writeFile(join(work, 'build.log'), build.output);
assert.equal(build.code, 0, build.output);
const result = await run(join(work, 'probe.exe'), [fixture]);
await writeFile(join(work, 'probe.log'), result.output);
assert.equal(result.code, 0, result.output);
const report = JSON.parse(result.output);
assert.equal(report.cases, 9);
report.sourceSHA256 = createHash('sha256').update(await readFile(source)).digest('hex');
report.work = work;
await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
