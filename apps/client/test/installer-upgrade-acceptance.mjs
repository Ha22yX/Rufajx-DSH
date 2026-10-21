import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, stat, access, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const client = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(client, 'package.json'));
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const compiler = resolve(option('--makensis'));
const builder = resolve(option('--builder') || dirname(require.resolve('app-builder-lib/package.json')));
const pluginDir = resolve(option('--plugin-dir') || join(client, 'preinstalled/installer/x86-unicode'));
const evidenceRoot = join(process.env.LOCALAPPDATA, 'RufaDSH/Development/installer-tests');
await mkdir(evidenceRoot, { recursive: true });
const work = await mkdtemp(join(evidenceRoot, 'upgrade-'));
const drive = option('--drive') || 'D:';
assert.match(drive, /^[A-Za-z]:$/);
const targetRoot = join(drive + '/', 'ProgramData/RufaDSH/Tests/NSIS', basename(work));
await mkdir(targetRoot, { recursive: true });
const rootBefore = new Set(await readdir(drive + '/'));
const q = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
const ps = value => `'${value.replaceAll("'", "''")}'`;
const exists = path => access(path).then(() => true, () => false);
const readUtf16 = async path => (await readFile(path)).toString('utf16le').replace(/^\ufeff/, '');
function launch(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timeout: ${command}`)); }, 60_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  return { child, done };
}
async function run(command, args, options) { return launch(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options }).done; }
async function waitForFile(path, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!(await exists(path))) {
    if (Date.now() > deadline) throw new Error(`File did not appear: ${path}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
const original = await readFile(join(builder, 'templates/nsis/uninstaller.nsh'), 'utf8');
const functions = original.slice(original.indexOf('Function un.atomicRMDir'), original.indexOf('!ifndef UNINSTALL_SECTION_NAME'));
assert.ok(functions.includes('Function un.restoreFiles'));
const nativeFunctions = join(work, 'native-functions.nsh');
await writeFile(nativeFunctions, functions);
const results = [];
async function caseTest(name, mode = 'success') {
  const evidence = join(work, name), shortSourceRoot = mode === 'root' || mode.startsWith('long') || mode === 'budget-native-temp';
  const parent = shortSourceRoot ? join(drive + '/', '.rufa') : join(targetRoot, name);
  const target = join(parent, shortSourceRoot ? 't-' + randomUUID().slice(0, 8) : '安装 目录');
  await mkdir(evidence, { recursive: true });
  await mkdir(target, { recursive: true });
  const beforeBytes = Buffer.from('original file bytes\n'.repeat(30000));
  await writeFile(join(target, 'a-first.txt'), beforeBytes);
  await writeFile(join(target, 'z-locked.txt'), 'locked original');
  // Exact longest relative path from the complete application (193 characters
  // including the leading separator), with isolated test content.
  const longestRelative = 'resources/harness/node_modules/@deepseek-ai/dsh-experimental-inspector/lib/devtools/models/issues_manager/descriptions/selectElementAccessibilityInteractiveContentAttributesSelectDescendant.md';
  if (mode.startsWith('long')) {
    assert.equal(longestRelative.length + 1, 193);
    assert.ok(join(target, longestRelative).length < 260, 'Original installed file must fit native MAX_PATH');
    await mkdir(dirname(join(target, longestRelative)), { recursive: true });
    await writeFile(join(target, longestRelative), 'long path original bytes');
  }
  const overBudgetRelative = 'r/' + 'x'.repeat(100) + '/' + 'y'.repeat(110) + '.txt';
  if (mode === 'budget-native-temp') {
    assert.ok(join(target, overBudgetRelative).length < 260);
    await mkdir(dirname(join(target, overBudgetRelative)), { recursive: true });
    await writeFile(join(target, overBudgetRelative), 'over budget preserved');
  }
  if (mode === 'reparse') await symlink(target, target + '-link', 'junction');
  if (mode === 'native-temp') {
    const empty = join(evidence, 'empty-link-target');
    await mkdir(empty);
    await symlink(empty, join(target, 'q-empty-link'), 'junction');
  }
  const before = await stat(join(target, 'a-first.txt'), { bigint: true });
  const childTrace = join(evidence, 'child.txt'), parentTrace = join(evidence, 'parent.txt');
  const ready = join(evidence, 'ready'), release = join(evidence, 'release');
  const legacy = join(evidence, 'old-uninstaller.exe');
  const generator = `Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Isolated old uninstaller"
OutFile "${q(join(evidence, 'generator.exe'))}"
!include LogicLib.nsh
!define UNINSTALL_FILENAME "old-uninstaller.exe"
!include "${q(nativeFunctions)}"
Section
  WriteUninstaller "${q(legacy)}"
SectionEnd
Section "Uninstall"
  InitPluginsDir
  FileOpen $R7 "${q(childTrace)}" w
  ReadEnvStr $R8 TEMP
  ReadEnvStr $R9 TMP
  FileWriteUTF16LE /BOM $R7 "$TEMP$\\r$\\n$PLUGINSDIR$\\r$\\n$INSTDIR$\\r$\\n$R8$\\r$\\n$R9$\\r$\\n"
  FileClose $R7
  ${mode === 'native-temp' ? '' : `CreateDirectory "$TEMP\\owned-leftover"
  FileOpen $R7 "$TEMP\\owned-leftover\\recovery.txt" w
  FileWrite $R7 "private recovery sentinel"
  FileClose $R7`}
  ${mode === 'retain' ? 'SetErrorLevel 7\n  Quit' : ''}
  CreateDirectory "$PLUGINSDIR\\old-install"
  Push ""
  Call un.atomicRMDir
  Pop $R0
  \${If} $R0 != 0
    FileOpen $R7 "${q(join(evidence, 'partial.txt'))}" w
    IfFileExists "$PLUGINSDIR\\old-install\\a-first.txt" 0 +2
      FileWrite $R7 "moved-before-failure"
    FileClose $R7
    Push ""
    Call un.restoreFiles
    Pop $R0
    SetErrorLevel 5
    Quit
  \${EndIf}
  FileOpen $R7 "${q(ready)}" w
  FileWrite $R7 "ready"
  FileClose $R7
  StrCpy $R6 0
  wait:
    IfFileExists "${q(release)}" go 0
    Sleep 30
    IntOp $R6 $R6 + 1
    IntCmp $R6 1000 go wait go
  go:
  SetOutPath $TEMP
  RMDir /r "$INSTDIR"
SectionEnd
`;
  await writeFile(join(evidence, 'legacy.nsi'), '\ufeff' + generator);
  let build = await run(compiler, ['/V2', join(evidence, 'legacy.nsi')]);
  assert.equal(build.code, 0, build.output);
  assert.equal((await run(join(evidence, 'generator.exe'), ['/S'])).code, 0);
  const command = `"${legacy}" /S --updated _?=${target}`;
  const host = `Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Isolated upgrade parent"
OutFile "${q(join(evidence, 'parent.exe'))}"
!define isUpdated '0 == 1'
!addplugindir /x86-unicode "${q(pluginDir)}"
!include "${q(join(client, 'scripts/installer-direct.nsh'))}"
!include "${q(join(client, 'scripts/installer-upgrade.nsh'))}"
Var installationDir
Section
  StrCpy $installationDir "${q(mode === 'missing' ? join(target, 'missing-directory') : mode === 'reparse' ? target + '-link' : target)}"
  ReadEnvStr $1 TEMP
  ReadEnvStr $2 TMP
  ${mode === 'fallback' ? `!insertmacro rufaExecWaitUninstaller '"${q(join(evidence, 'missing.exe'))}" /S'
  IfErrors 0 failed
  ClearErrors` : ''}
  !insertmacro rufaExecWaitUninstaller '${q(command)}'
  FileOpen $R7 "${q(parentTrace)}" w
  ReadEnvStr $3 TEMP
  ReadEnvStr $4 TMP
  FileWriteUTF16LE /BOM $R7 "$rufaUpgradeStatus$\\r$\\n$R0$\\r$\\n$rufaUpgradeRetained$\\r$\\n$1$\\r$\\n$2$\\r$\\n$3$\\r$\\n$4$\\r$\\n"
  FileClose $R7
  SetErrorLevel $R0
  Quit
  ${mode === 'fallback' ? 'failed:\n  SetErrorLevel 99' : ''}
SectionEnd
`;
  await writeFile(join(evidence, 'parent.nsi'), '\ufeff' + host);
  build = await run(compiler, ['/V2', join(evidence, 'parent.nsi')]);
  assert.equal(build.code, 0, build.output);
  let locker;
  if (mode === 'locked') {
    locker = launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$f=[IO.File]::Open(${ps(join(target, 'z-locked.txt'))},'Open','ReadWrite','None'); [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $f.Dispose()`]);
    await new Promise(resolve => locker.child.stdout.once('data', resolve));
  }
  let originalAcl;
  try {
    if (mode === 'denied') {
      const denied = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p=${ps(parent)}; $s=[Security.AccessControl.AccessControlSections]::Access; $a=[IO.Directory]::GetAccessControl($p,$s); [Console]::WriteLine($a.GetSecurityDescriptorSddlForm($s)); $u=[Security.Principal.WindowsIdentity]::GetCurrent().User; $r=New-Object Security.AccessControl.FileSystemAccessRule($u,[Security.AccessControl.FileSystemRights]::CreateDirectories,[Security.AccessControl.AccessControlType]::Deny); $a.AddAccessRule($r); [IO.Directory]::SetAccessControl($p,$a)`]);
      originalAcl = denied.output.trim();
      assert.equal(denied.code, 0, denied.output);
    }
    const child = launch(join(evidence, 'parent.exe'), ['/S']);
    if (mode === 'native-temp') {
      await waitForFile(ready);
      const trace = (await readUtf16(childTrace)).trim().split(/\r?\n/);
      const normalized = path => resolve(path).toLowerCase();
      assert.equal(normalized(trace[0]), normalized(tmpdir()));
      assert.deepEqual(await readFile(join(trace[1], 'old-install/a-first.txt')), beforeBytes);
      await writeFile(release, 'continue');
      const ended = await child.done;
      assert.equal(ended.code, 0, ended.output);
      const parentValues = (await readUtf16(parentTrace)).split(/\r?\n/);
      assert.equal(parentValues[0], 'native-temp');
      assert.equal(parentValues[2], '');
      assert.equal(parentValues[3], parentValues[5]);
      assert.equal(parentValues[4], parentValues[6]);
      assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(join(evidence, 'empty-link-target'))), []);
      results.push({ name, ok: true, nativeTempFallback: true, parentEnvironmentUnchanged: true, originalFileBytesPreserved: true });
    } else if (mode === 'budget-native-temp') {
      const ended = await child.done;
      assert.equal(ended.code, 5, ended.output);
      const parentValues = (await readUtf16(parentTrace)).split(/\r?\n/);
      assert.equal(parentValues[0], 'native-temp'); assert.equal(parentValues[2], '');
      assert.deepEqual(await readFile(join(target, 'a-first.txt')), beforeBytes);
      assert.equal(await readFile(join(target, overBudgetRelative), 'utf8'), 'over budget preserved');
      assert.equal(parentValues[3], parentValues[5]); assert.equal(parentValues[4], parentValues[6]);
      results.push({ name, ok: true, knownLengthFallback: true, originalFilesRestored: true });
    } else if (['success', 'fallback', 'root', 'denied', 'long'].includes(mode)) {
      await waitForFile(ready);
      const trace = (await readUtf16(childTrace)).trim().split(/\r?\n/);
      assert.equal(trace[0][0].toUpperCase(), drive[0].toUpperCase());
      assert.match(trace[0], /\.ru-[A-Za-z0-9_-]{22}$/);
      assert.equal(basename(dirname(trace[0])), '.rufa', 'Transaction must stay inside the managed container');
      assert.equal(trace[3], trace[0]);
      assert.equal(trace[4], trace[0]);
      const moved = await stat(join(trace[1], 'old-install/a-first.txt'), { bigint: true });
      assert.equal(moved.ino, before.ino, 'Same-volume rename must preserve file identity');
      assert.equal(moved.dev, before.dev);
      assert.deepEqual(await readFile(join(trace[1], 'old-install/a-first.txt')), beforeBytes);
      if (mode === 'long') {
        assert.equal(await readFile(join(trace[1], 'old-install', longestRelative), 'utf8'), 'long path original bytes');
        assert.ok(join(trace[1], 'old-install', longestRelative).length < 260);
      }
      // Cleanup must remove this link itself, never follow it to another directory.
      const outside = join(evidence, 'outside-sentinel');
      await mkdir(outside);
      await writeFile(join(outside, 'keep.txt'), 'outside must survive');
      await symlink(outside, join(trace[0], 'outside-link'), 'junction');
      await writeFile(release, 'continue');
      const ended = await child.done;
      assert.equal(ended.code, 0, ended.output);
      assert.equal(await exists(trace[0]), false, 'Successful child private directory must be cleaned');
      assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside must survive');
      const parentValues = (await readUtf16(parentTrace)).split(/\r?\n/);
      assert.equal(parentValues[3], parentValues[5]);
      assert.equal(parentValues[4], parentValues[6]);
      results.push({ name, ok: true, sameVolume: true, fileId: before.ino.toString(), parentEnvironmentUnchanged: true, cleanupWithoutFollowingLink: true, ...(mode === 'long' ? { longestRelativeChars: 193, backupChars: join(trace[1], 'old-install', longestRelative).length } : {}), ...(mode === 'denied' ? { unwritableParentAvoided: true } : {}) });
    } else {
      const ended = await child.done;
      assert.equal(ended.code, mode === 'retain' ? 7 : ['missing', 'reparse', 'denied'].includes(mode) ? 2 : 5, ended.output);
      assert.deepEqual(await readFile(join(target, 'a-first.txt')), beforeBytes);
      if (['missing', 'reparse', 'denied'].includes(mode)) {
        assert.equal(await exists(childTrace), false);
        results.push({ name, ok: true, rejectedBeforeChild: true });
      } else {
        const trace = (await readUtf16(childTrace)).trim().split(/\r?\n/);
        assert.equal(await readFile(join(trace[0], 'owned-leftover/recovery.txt'), 'utf8'), 'private recovery sentinel');
        const parentValues = (await readUtf16(parentTrace)).split(/\r?\n/);
        assert.equal(parentValues[2], trace[0]);
        assert.equal(parentValues[3], parentValues[5]);
        assert.equal(parentValues[4], parentValues[6]);
        const acl = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[IO.Directory]::GetAccessControl(${ps(trace[0])}).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)`]);
        assert.equal(acl.code, 0, acl.output);
        assert.match(acl.output, /D:P/);
        assert.doesNotMatch(acl.output, /;;;WD\)|;;;BU\)|;;;AU\)/);
        if (mode === 'locked' || mode === 'long-failure') {
          assert.equal(await readFile(join(evidence, 'partial.txt'), 'utf8'), 'moved-before-failure');
          assert.equal((await stat(join(target, 'a-first.txt'), { bigint: true })).ino, before.ino);
        }
        if (mode === 'long-failure') assert.equal(await readFile(join(target, longestRelative), 'utf8'), 'long path original bytes');
        results.push({ name, ok: true, exit: ended.code, retained: trace[0], restoredNativeFiles: mode === 'locked' || mode === 'long-failure', parentEnvironmentUnchanged: true, privateAcl: acl.output.trim() });
      }
    }
  } finally {
    if (locker) { locker.child.stdin.end('\n'); await locker.done; }
    if (originalAcl) {
      const restored = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$a=New-Object Security.AccessControl.DirectorySecurity; $a.SetSecurityDescriptorSddlForm(${ps(originalAcl)},[Security.AccessControl.AccessControlSections]::Access); [IO.Directory]::SetAccessControl(${ps(parent)},$a)`]);
      assert.equal(restored.code, 0, restored.output);
    }
  }
}
try {
  const cases = [['same-volume-success', 'success'], ['launch-fallback', 'fallback'], ['old-native-rollback', 'locked'], ['failed-child-retained', 'retain'], ['missing-target-rejected', 'missing'], ['reparse-target-rejected', 'reparse'], ['unwritable-parent-alternative', 'denied'], ['managed-short-parent', 'root'], ['longest-application-path', 'long'], ['native-temp-compatibility', 'native-temp'], ['known-length-compatibility', 'budget-native-temp']];
  if (option('--case') === 'legacy-long-path-failure') cases.push(['legacy-long-path-failure', 'long-failure']);
  if (option('--case') && !await exists(join(drive + '/', '.rufa'))) await caseTest('managed-container-bootstrap');
  for (const [name, mode] of cases) if (!option('--case') || option('--case') === name) await caseTest(name, mode);
  const scattered = (await readdir(drive + '/')).filter(name => !rootBefore.has(name) && /^(?:\.ru-|\.rufa-upgrade-|RufaUpgradeTests|rufa-upgrade-test-)/iu.test(name));
  assert.deepEqual(scattered, [], 'No new recovery/test directories may be scattered at the volume root');
  await writeFile(join(work, 'report.json'), JSON.stringify({ ok: true, noNewScatteredRootDirectories: true, nativeFunctionSHA256: createHash('sha256').update(functions).digest('hex'), results }, null, 2));
  console.log(JSON.stringify({ ok: true, cases: results.length, work, targetRoot }));
} catch (error) {
  await writeFile(join(work, 'report.json'), JSON.stringify({ ok: false, results, error: String(error) }, null, 2));
  console.error(JSON.stringify({ work, targetRoot, error: String(error) }));
  throw error;
}
