import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, lstat, mkdir, copyFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));

test('real packaging matcher and ASAR preserve the main-process empty-session dependency only', async t => {
  const { getMainFileMatchers } = require('app-builder-lib/out/fileMatcher.js');
  const asar = require('@electron/asar'), ts = require('typescript');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rufa-packaging-test-')));
  t.after(async () => {
    assert.equal(dirname(root), await realpath(tmpdir())); assert.ok(basename(root).startsWith('rufa-packaging-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const stage = join(root, 'app'), archive = join(root, 'app.asar');
  const config = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8')).build;
  const packager = { info: { config, projectDir: appDir, buildResourcesDir: 'assets', isPrepackedAppAsar: false,
    debugLogger: { isEnabled: false } } };
  const [matcher] = getMainFileMatchers(appDir.replace(/[\\/]$/, ''), stage, value => value, {}, packager, join(root, 'out'), false);
  const filter = matcher.createFilter(), selected = [];
  async function copySelected(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), stat = await lstat(path);
      if (!filter(path, stat)) continue;
      if (entry.isDirectory()) { await copySelected(path); continue; }
      assert.equal(stat.isSymbolicLink(), false);
      const name = relative(appDir, path).replaceAll('\\', '/'); selected.push(name);
      await mkdir(dirname(join(stage, name)), { recursive: true }); await copyFile(path, join(stage, name));
    }
  }
  // Match real compiled resources while avoiding generated runtime and release trees.
  await copySelected(join(appDir, 'dist'));
  await copyFile(join(appDir, 'package.json'), join(stage, 'package.json')); selected.push('package.json');
  assert.deepEqual(selected.filter(name => name.startsWith('dist/runtime/')), ['dist/runtime/empty-session-policy.mjs']);
  assert.ok(selected.includes('dist/main.js')); assert.ok(selected.includes('dist/account-preload.cjs'));
  assert.ok(selected.includes('dist/renderer/index.html'));
  await asar.createPackage(stage, archive);
  const archived = new Set(asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, '')));
  const visited = new Set();
  async function resolveImports(name) {
    if (visited.has(name)) return; visited.add(name);
    assert.ok(archived.has(name), `main-process import missing from ASAR: ${name}`);
    const source = asar.extractFile(archive, join(...name.split('/'))).toString('utf8');
    assert.equal(source, await readFile(join(appDir, name), 'utf8'));
    const syntax = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), imports = [];
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(syntax);
    for (const specifier of imports.filter(value => value.startsWith('.'))) {
      const dependency = relative(stage, resolve(stage, dirname(name), specifier)).replaceAll('\\', '/');
      assert.ok(!dependency.startsWith('../')); await resolveImports(dependency);
    }
  }
  await resolveImports('dist/main.js');
  assert.ok(visited.has('dist/runtime/empty-session-policy.mjs'));
  const electron = require('electron');
  const result = execFileSync(electron, ['--input-type=module', '-e',
    `import {pathToFileURL} from 'node:url';const p=await import(pathToFileURL(process.argv[1]).href);console.log(JSON.stringify({loaded:typeof p.emptyConversationState==='function'}));`,
    join(archive, 'dist/runtime/empty-session-policy.mjs')], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.deepEqual(JSON.parse(result.trim()), { loaded: true });
});
