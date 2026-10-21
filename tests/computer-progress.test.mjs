import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { patchProgressSource, patchComputerProgressRuntime } from '../scripts/computer-progress-runtime.mjs';
import { normalizeProgress, stepForTool } from '../preinstalled/desktop-video/progress/presentation.mjs';
const runtime = process.env.RUFA_TEST_RUNTIME_ROOT;
const upstream = process.env.RUFA_COMPUTER_PLUGIN_SOURCE;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(50); }
  throw new Error('Progress event did not arrive');
};

test('progress presentation is bounded and does not derive text from raw arguments', () => {
  assert.equal(stepForTool('mcp__wincu__windows_computer_use_type_text'), '输入内容');
  assert.equal(stepForTool('mcp__wincu__windows_computer_use_wait_for'), '等待界面就绪');
  assert.equal(normalizeProgress(null), null);
  const result = normalizeProgress({ task: '打开浏览器\u202e\n', currentStep: 'password:secret Bearer abc', description: '查看当前窗口', completedSteps: ['1', '2', '3', '4'], status: 'invented', completedCount: -1, raw: 'never copy' });
  assert.equal(result.task, '打开浏览器');
  assert.equal(result.currentStep, 'password:… …');
  assert.deepEqual(result.completedSteps, ['2', '3', '4']);
  assert.equal(result.status, 'working');
  assert.equal(result.description, '查看当前窗口');
  assert.equal(result.raw, undefined);
});
test('computer progress replay only accepts pinned originals or intact company output', { skip: !upstream }, async () => {
  const extension = await readFile(new URL('../preinstalled/desktop-video/progress/Progress.cs', import.meta.url), 'utf8') + '\n' +
    await readFile(new URL('../preinstalled/desktop-video/progress/BlurBackdrop.cs', import.meta.url), 'utf8');
  for (const file of ['mcp/activity.mjs', 'mcp/takeover.mjs', 'mcp/dsh-plugin.mjs', 'scripts/windows-takeover.cs']) {
    const source = await readFile(join(upstream, file), 'utf8');
    const patched = patchProgressSource(source, file, extension);
    assert.notEqual(patched, source);
    assert.equal(patchProgressSource(patched, file, extension), patched);
    assert.equal(patchProgressSource(source.replaceAll('\n', '\r\n'), file, extension), patched);
    assert.throws(() => patchProgressSource(source + '// unknown', file, extension), /Unsupported/);
    assert.throws(() => patchProgressSource('// unexpected edit\n' + patched, file, extension), /integrity/);
  }
});
test('native activity bridge keeps trusted child progress during planning and forwards desktop stop', { skip: !runtime }, async t => {
  await patchComputerProgressRuntime(runtime, { checkOnly: true });
  const root = await mkdtemp(join(tmpdir(), 'rufa-task-progress-'));
  const activity = join(root, 'activity.json'), state = join(root, 'state.json');
  const { installActivity } = await import(pathToFileURL(join(runtime, 'node_modules/dsh-computer-use-win/mcp/activity.mjs')).href);
  let receipt;
  let task = { sessionId: 'synthetic-child', turn: 7, progress: { task: '查找并下载文件', currentStep: '检查浏览器是否打开', completedSteps: [], status: 'waiting' } };
  const handlers = {}, dispose = [], stopped = [], errors = [];
  let acknowledged = false;
  const service = { activeTask: () => task, presentationTask: () => receipt, progressFor: id => task?.sessionId === id ? task.progress : undefined, stopFromDesktop: value => { if (!acknowledged) return false; stopped.push(value); receipt = { ...task, expiresAt: Date.now() + 2000, progress: { ...task.progress, status: 'stopped' } }; task = undefined; return true; } };
  installActivity({ get: name => name === 'rufaComputerTasks' ? service : undefined, on: (event, cb) => { handlers[event] = cb; }, effect: cb => dispose.push(cb()), logger: { error: error => errors.push(error) } }, activity, { idleMs: 20, stateFile: state });
  t.after(() => dispose.forEach(fn => fn()));
  const snapshot = async () => JSON.parse(await readFile(activity, 'utf8'));
  await until(async () => (await snapshot()).active);
  assert.equal((await snapshot()).progress.currentStep, '检查浏览器是否打开');
  await pause(350);
  assert.equal((await snapshot()).active, true, 'planning does not expire a live dedicated task');
  task.progress = { ...task.progress, currentStep: '搜索需要的内容', completedSteps: ['查看已打开的窗口'], completedCount: 1, status: 'working' };
  await handlers['tools/execute']({ name: 'mcp__wincu__windows_computer_use_type_text', signal: new AbortController().signal, agent: { session: { id: task.sessionId }, phase: { kind: 'running', turn: 7 } }, arguments: { text: 'PRIVATE INPUT SHOULD NOT BE COPIED' } }, async () => ({}));
  assert.equal((await snapshot()).progress.currentStep, '搜索需要的内容');
  assert.equal((await readFile(activity, 'utf8')).includes('PRIVATE INPUT'), false);
  await writeFile(state, JSON.stringify({ paused: true, stoppedSeriesKey: JSON.stringify(['synthetic-child', 7]) }));
  await pause(350);
  assert.equal(stopped.length, 0);
  acknowledged = true;
  await until(() => stopped.length === 1);
  await until(async () => !(await snapshot()).active);
  await pause(350);
  assert.deepEqual(stopped, [{ sessionId: 'synthetic-child', turn: 7 }]);
  assert.equal((await snapshot()).progress, null);
  assert.equal((await snapshot()).presentation.progress.status, 'stopped');
  assert.equal((await snapshot()).active, false, 'terminal receipt does not hold input');
  assert.deepEqual(errors, []);
});
test('native progress text stays on physical pixels across DPI and odd/even monitor widths', {skip: !runtime || process.platform !== 'win32'}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rufa-progress-text-'));
  const executable = join(directory, 'text.exe');
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll',
    `/out:${executable}`, resolve(runtime, 'node_modules/dsh-computer-use-win/scripts/windows-takeover.cs'),
    resolve('tests/fixtures/desktop-progress-text.cs')], {windowsHide: true});
  execFileSync(executable, [directory], {windowsHide: true, timeout: 20000});
  const rows = JSON.parse(await readFile(join(directory, 'text-report.json'), 'utf8'));
  assert.deepEqual(rows.map(row => row.scale), [1, 1.25, 1.5, 1.75, 2, 2.5, 3]);
  for (const row of rows) {
    assert.ok(row.sampledGlyphPixels > 100, `visible step glyphs sampled at ${row.scale}`);
    assert.equal(row.shiftedGlyphPixels, 0, `same highlighted step glyph mask at ${row.scale} despite fractional card centering`);
  }
  t.diagnostic(`Actual native offscreen raster; not a physical multi-monitor test: ${directory}`);
});

test('real Windows overlay renders live progress without taking focus and preserves Esc stop', { skip: !runtime || process.platform !== 'win32', timeout: 40000 }, async t => {
  const { TakeoverControl } = await import(pathToFileURL(join(runtime, 'node_modules/dsh-computer-use-win/mcp/takeover.mjs')).href);
  const directory = await mkdtemp(join(tmpdir(), 'rufa-progress-native-'));
  const control = new TakeoverControl({ testMode: true, config: { cursorIndicatorEnabled: false } });
  t.after(() => control.close());
  const baseline = await control.command('status');
  const progress = { task: '查找并下载产品说明书', currentStep: '打开官方网站', description: '确认来源，查找对应的产品说明书', completedSteps: ['查看已打开的窗口', '打开浏览器', '搜索需要的内容'], completedCount: 3, status: 'working' };
  await control.command('test_render', { path: join(directory, 'progress.png'), indicatorText: 'Rufa智能体正在控制电脑', progress });
  for (const scale of [1, 1.25, 1.5, 2]) await control.command('test_render', { path: join(directory, `progress-${scale}.png`), progress, scale });
  const samples = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    Add-Type -AssemblyName System.Drawing
    $image=[System.Drawing.Bitmap]::FromFile($env:RUFA_PROGRESS_TEST_IMAGE)
    try { @{ lower=$image.GetPixel(600,150).A; header=$image.GetPixel(600,35).A; outside=$image.GetPixel(600,200).A } | ConvertTo-Json -Compress } finally { $image.Dispose() }
  `], { env: { ...process.env, RUFA_PROGRESS_TEST_IMAGE: join(directory, 'progress.png') }, windowsHide: true, encoding: 'utf8' }));
  assert.deepEqual(samples, { lower: 160, header: 255, outside: 0 }, 'readable translucent tint only, no opaque plate');
  const labels = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    Add-Type -AssemblyName System.Drawing
    $labels=@(1,1.25,1.5,2) | ForEach-Object {
      $scale=$_
      $image=[System.Drawing.Bitmap]::FromFile((Join-Path $env:RUFA_PROGRESS_TEST_DIR "progress-$scale.png"))
      try {
        $left=[int](600+152*$scale);$top=[int](32*$scale)
        $minX=10000;$maxX=-1;$minY=10000;$maxY=-1
        for($x=$left;$x -lt $left+32*$scale;$x++){for($y=$top;$y -lt $top+20*$scale;$y++){
          $p=$image.GetPixel($x,$y)
          if($p.R -gt 130 -and $p.G -gt 140 -and $p.B -gt 150){$minX=[Math]::Min($minX,$x);$maxX=[Math]::Max($maxX,$x);$minY=[Math]::Min($minY,$y);$maxY=[Math]::Max($maxY,$y)}
        }}
        @{scale=$scale;width=$maxX-$minX+1;height=$maxY-$minY+1}
      } finally {$image.Dispose()}
    }
    ConvertTo-Json -InputObject @($labels) -Compress
  `], { env: { ...process.env, RUFA_PROGRESS_TEST_DIR: directory }, windowsHide: true, encoding: 'utf8' }));
  for (const label of labels) {
    assert.ok(label.width >= 16 * label.scale, `both stop glyphs at ${label.scale}: ${JSON.stringify(label)}`);
    assert.ok(label.height <= 15 * label.scale, `stop is one unclipped line at ${label.scale}: ${JSON.stringify(label)}`);
  }
  const shown = await control.command('begin', { indicatorText: '界面验收（不会操作电脑）', cursorIndicatorEnabled: false, indicatorEnabled: true, remoteIndicatorVisible: true, progress });
  assert.equal(shown.progressVisible, true);
  assert.equal(shown.overlayClickThrough, true);
  if (process.env.RUFA_EXPECT_NATIVE_BLUR === '1') assert.equal(shown.backdropWindows, shown.windows, 'real limited DWM backdrops applied');
  assert.equal(shown.foreground, baseline.foreground);
  const updated = await control.command('begin', { cursorIndicatorEnabled: false, progress: { ...progress, currentStep: '核对下载结果', completedSteps: [...progress.completedSteps, '点击下载'], completedCount: 4 } });
  assert.equal(updated.progressVisible, true);
  assert.equal(updated.foreground, baseline.foreground);
  const stop = await control.command('test_key', { vk: 27, down: true, injected: false });
  assert.equal(stop.cancelled, true);
  assert.equal(stop.consumed, true);
  assert.equal(stop.windows, 0);
  assert.equal(stop.progressVisible, false);
  await control.command('test_key', { vk: 27, down: false, injected: false });
  const result = await control.command('task_result', { displayMs: 500, progress: { ...progress, status: 'stopped' } });
  assert.equal(result.armed, false);
  assert.equal(result.paused, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.resultVisible, true);
  if (process.env.RUFA_EXPECT_NATIVE_BLUR === '1') assert.equal(result.backdropWindows, result.windows);
  assert.equal(result.foreground, baseline.foreground);
  const idleKey = await control.command('test_key', { vk: 27, down: true, injected: false });
  assert.equal(idleKey.consumed, false, 'receipt does not capture keyboard after control released');
  await control.command('test_key', { vk: 27, down: false, injected: false });
  await until(async () => (await control.command('status')).windows === 0);
  t.diagnostic(`Real native overlay render, click-through, foreground preservation and test-seam Esc: ${directory}. No desktop input or model calls.`);
});

test('real DWM backdrop stays inside the rounded card without bright edge seams', {
  skip: !runtime || process.platform !== 'win32' || process.env.RUFA_EXPECT_NATIVE_BLUR !== '1', timeout: 30000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rufa-progress-edges-'));
  const executable = join(directory, 'preview.exe');
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/target:winexe', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll',
    `/out:${executable}`, resolve(runtime, 'node_modules/dsh-computer-use-win/scripts/windows-takeover.cs'),
    resolve('tests/fixtures/desktop-progress-preview.cs')], { windowsHide: true });
  execFileSync(executable, [directory], { windowsHide: true, timeout: 20000 });
  const rows = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
  assert.equal(rows.find(row => row.error), undefined);
  assert.equal(rows.find(row => 'applied' in row)?.applied, true);
  assert.equal(rows.find(row => 'clickThrough' in row)?.clickThrough, true);
  for (const name of ['light', 'dark']) {
    const result = rows.find(row => row.name === name);
    assert.ok(result.outsideJump <= 6, `${name}: no rectangular blur edge outside the rounded card (soft system shadow is allowed): ${result.outsideJump}`);
    assert.equal(result.brightSeams, 0, `${name}: native backdrop must not draw a separate bright edge`);
  }
  const baseline = rows.find(row => row.name === 'baseline');
  const working = rows.find(row => row.name === 'working');
  const changed = rows.find(row => row.name === 'live-background');
  const released = rows.find(row => row.name === 'released');
  assert.ok(working.variation < baseline.variation / 4, 'actual desktop pattern is blurred');
  assert.notEqual(working.left, changed.left, 'live background remains visible through the card');
  assert.ok(released.variation > baseline.variation / 2, 'disposing the card removes the native blur');
  t.diagnostic(`Owned synthetic light/dark/checkered desktop captures: ${directory}. No real desktop input or user-content capture.`);
});
test('private activity file drives native progress during planning and clears on release', { skip: !runtime || process.platform !== 'win32', timeout: 20000 }, async t => {
  const { TakeoverControl, atomicJson } = await import(pathToFileURL(join(runtime, 'node_modules/dsh-computer-use-win/mcp/takeover.mjs')).href);
  const directory = await mkdtemp(join(tmpdir(), 'rufa-progress-wire-'));
  const file = join(directory, 'activity.json');
  // The real publisher retries on its next tick when Windows briefly denies
  // atomic replacement while another process has the file open.
  const publish = async value => {
    for (let attempt = 0; ; attempt++) {
      try { atomicJson(file, value); return; }
      catch (error) { if (attempt >= 10 || !['EPERM', 'EBUSY'].includes(error.code)) throw error; await pause(25); }
    }
  };
  await publish({ active: false, expiresAt: 0 });
  const control = new TakeoverControl({ activityFile: file, stateFile: join(directory, 'state.json'), testMode: true, config: { indicatorText: '界面验收（不会操作电脑）', cursorIndicatorEnabled: false, indicatorIdleMs: 200 } });
  t.after(() => control.close());
  const progress = { task: '电脑操作', currentStep: '检查浏览器', status: 'waiting', completedSteps: [] };
  await publish({ active: true, sessionId: 'native-child', turn: 1, expiresAt: Date.now() + 5000, progress });
  await control.sync();
  assert.equal(control.active, 0, 'task planning alone owns the series, no input is executed');
  assert.equal((await control.command('status')).progressVisible, true);
  assert.equal(control.progress.currentStep, '检查浏览器');
  await publish({ active: true, sessionId: 'native-child', turn: 1, expiresAt: Date.now() + 5000, progress: { ...progress, currentStep: '搜索内容', completedSteps: ['检查浏览器'], completedCount: 1 } });
  await control.sync();
  assert.equal(control.progress.currentStep, '搜索内容');
  assert.equal((await control.command('status')).progressVisible, true);
  await publish({ active: false, expiresAt: 0, progress: null });
  await control.sync();
  await until(async () => (await control.command('status')).windows === 0);
  assert.equal(control.progress, null);
  assert.equal(control.seriesHeld, false);
  const receipt = { sessionId: 'native-child', turn: 1, expiresAt: Date.now() + 800,
    progress: { ...progress, status: 'completed', description: '本次操作已结束，详细结果请查看主会话。' } };
  await publish({ active: false, expiresAt: 0, progress: null, presentation: receipt });
  await control.sync();
  const terminal = await control.command('status');
  assert.equal(terminal.resultVisible, true);
  assert.equal(terminal.armed, false);
  assert.equal(control.seriesHeld, false);
  await until(async () => (await control.command('status')).windows === 0);
  await control.sync();
  assert.equal((await control.command('status')).windows, 0, 'repeated stale receipt never reopens overlay');
});

test('native series replacement cannot erase an unacknowledged desktop stop', { skip: !runtime }, async t => {
  const { TakeoverControl, atomicJson, STOPPED } = await import(pathToFileURL(join(runtime, 'node_modules/dsh-computer-use-win/mcp/takeover.mjs')).href);
  const { installActivity } = await import(pathToFileURL(join(runtime, 'node_modules/dsh-computer-use-win/mcp/activity.mjs')).href);
  const directory = await mkdtemp(join(tmpdir(), 'rufa-progress-late-stop-'));
  const file = join(directory, 'activity.json'), stateFile = join(directory, 'state.json');
  const control = new TakeoverControl({ activityFile: file, stateFile, testMode: true });
  control.disabledForTest = true; clearInterval(control.poll);
  t.after(() => control.close());
  const progress = { task: '电脑任务', currentStep: '查看浏览器', status: 'working' };
  atomicJson(file, { active: true, sessionId: 'old-child', turn: 1, expiresAt: Date.now() + 5000, progress });
  await control.sync();
  control.fail(new Error(STOPPED));
  atomicJson(file, { active: true, sessionId: 'replacement-child', turn: 2, expiresAt: Date.now() + 5000, progress });
  await control.sync();
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(saved.paused, false);
  assert.equal(saved.stoppedSeriesKey, null);
  assert.ok(saved.blockedSeries[JSON.stringify(['old-child', 1])]);
  const stopped = [], effects = [];
  const service = { activeTask: () => undefined, progressFor: () => undefined,
    stopFromDesktop: value => { stopped.push(value); return true; } };
  installActivity({ get: () => service, on() {}, effect: cb => effects.push(cb()), logger: { error: error => { throw error; } } }, file, { stateFile });
  t.after(() => effects.forEach(dispose => dispose()));
  await until(() => stopped.length > 0);
  await pause(300);
  assert.deepEqual(stopped, [{ sessionId: 'old-child', turn: 1 }]);
});
