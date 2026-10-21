// Opt-in native COM acceptance, independent runtime/workdir. No model API calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runSolidworksProcess } from '../apps/client/src/runtime/solidworks-process.mjs';
const runtime = resolve(process.argv[2]), root = resolve(process.argv[3]);
if (!process.argv[2] || !process.argv[3]) throw new Error('Pass an isolated runtime and synthetic output directory');
await mkdir(join(root, 'work'), { recursive: true }); await mkdir(join(root, 'state'), { recursive: true });
const config = { pythonPath: join(runtime, 'company-python/python.exe'), helperPath: join(runtime, 'company-tools/solidworks/solidworks_runner.py'), stateRoot: join(root, 'state'), cwd: join(root, 'work'), signal: new AbortController().signal };
const detect = await runSolidworksProcess({ ...config, operation: 'detect', timeoutSeconds: 30 });
assert.equal(detect.installed, true); assert.match(detect.notice, /未启动/);
const result = await runSolidworksProcess({ ...config, timeoutSeconds: 300, code: `
doc = cad.new("part")
cad.sketch(doc, lambda s: s.CreateCornerRectangle(0., 0., 0., .05, .03, 0.), name="矩形轮廓")
cad.extrude(doc, 10, name="测试拉伸")
cad.check("volume_15000mm3", abs(cad.volume(doc) - 15000) < .001)
saved = cad.save(doc, "预装验收长方体.SLDPRT")
doc = cad.reopen(doc, saved)
cad.check("reopened_volume", abs(cad.volume(doc) - 15000) < .001)
cad.preview(doc, "预装验收长方体.bmp")
print("几何、保存、重新打开已完成核对")
` });
await writeFile(join(root, 'live-report.json'), JSON.stringify({ detect, result }, null, 2));
console.log(JSON.stringify(result));
assert.equal(result.status, 'completed'); assert.equal(result.cleanup, true);
assert.equal(result.registryRestored, true);
assert.deepEqual(result.preexistingPids, result.preexistingPidsStillRunning);
assert.ok(result.checks.every(row => row.passed));
