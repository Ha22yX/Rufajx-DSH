// Read-only gate after Electron Builder copies resources, and after extraction.
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchComputerProgressRuntime } from './computer-progress-runtime.mjs';
import { checkSolidworksRuntime } from './solidworks-runtime.mjs';

const packages = {
  '@deepseek-ai/dsh-base': '0.2.1-rc.2',
  '@deepseek-ai/dsh-web-app': '0.2.1-rc.2',
  '@deepseek-ai/dsh-experimental-auto-review': '0.2.1-rc.2',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle': '0.2.1-rc.2',
  '@deepseek-ai/dsh-experimental-session-search': '0.2.1-rc.2',
  '@deepseek-ai/dsh-experimental-session-titles-bundle': '0.2.1-rc.2',
  '@deepseek-ai/dsh-experimental-agent-team-profile': '0.2.1-rc.2',
  '@deepseek-ai/dsh-skill-office': '0.2.1-rc.2',
  '@rufa/dsh-office-bundle': '1.0.0',
  '@rufa/dsh-read-pdf-bundle': '1.0.0',
  'dsh-file-upload-ocr-plugin': '2.0.0',
  'dsh-better-sidebar': '0.28.0',
  'dsh-video-preview': '0.1.4',
  '@huanlin/dsh-plugin-better-sidebar-plugin-audio': '0.1.0',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle': '0.2.1-rc.2',
  'dsh-computer-use-win': '0.4.3',
  '@rufa/dsh-remotion-bundle': '1.0.0',
};
export async function verifyBootstrap(appRoot) {
  const client = fileURLToPath(new URL('../apps/client/', import.meta.url));
  await access(join(appRoot, 'Rufajx-DSH-App.exe'));
  for (const name of ['Rufajx-DSH.exe', 'Rufajx-DSH.exe.config']) {
    assert.deepEqual(await readFile(join(appRoot, name)), await readFile(join(client, 'build/updater', name)), `Stale native updater: ${name}`);
  }
}
export async function verifyPackagedPreinstalled(resources, { requireUpdateFeed = true, requireBootstrap = true } = {}) {
  resources = resolve(resources);
  if (requireBootstrap) await verifyBootstrap(resolve(resources, '..'));
  const harness = join(resources, 'harness');
  await checkSolidworksRuntime(harness);
  await patchComputerProgressRuntime(harness, { checkOnly: true });
  for (const [name, version] of Object.entries(packages)) {
    const directory = join(harness, 'node_modules', name);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, version, `Packaged plugin version: ${name}`);
    const patches = manifest.dsh?.bundle?.patch;
    for (const patch of patches ? Array.isArray(patches) ? patches : [patches] : []) await access(join(directory, patch));
  }
  for (const file of [
    'node/node.exe', 'node/LICENSE', 'company-config.json',
    'harness/company-python/python.exe', 'harness/company-python/rufa-dependencies.json',
    'harness/company-tools/dsh-read-pdf/pdf_tools.py',
    'harness/company-tools/media-player/avplayer.js',
    'harness/company-tools/remotion/runner.mjs',
    'harness/company-tools/remotion/remotion-motion-graphics/SKILL.md',
    'harness/company-tools/remotion/remotion-motion-graphics/references/design-rules.md',
    'harness/company-tools/remotion/remotion-motion-graphics/references/motion-patterns.md',
    'harness/company-tools/remotion/remotion-motion-graphics/assets/theme.ts',
    'harness/company-tools/remotion/browser/chrome-headless-shell-win64/chrome-headless-shell.exe',
    'harness/company-tools/remotion/node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe',
    'harness/company-tools/remotion/node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe',
    'harness/company-tools/remotion/node_modules/remotion/LICENSE.md',
    'harness/node_modules/dsh-computer-use-win/mcp/client.js',
    'harness/node_modules/dsh-computer-use-win/scripts/windows-takeover.cs',
    'company-plugins/company-model.mjs', 'company-plugins/company-web.mjs',
    'company-plugins/computer-tasks.mjs', 'company-plugins/computer-task-controller.mjs',
    'company-plugins/solidworks-tools.mjs', 'company-plugins/solidworks-intent.mjs',
    'company-plugins/solidworks-catalog.mjs', 'company-plugins/solidworks-process.mjs',
  ]) await access(join(resources, file));
  const require = createRequire(join(harness, 'company-tools/remotion/runner.mjs'));
  for (const name of ['remotion', '@remotion/renderer', '@remotion/bundler', '@remotion/cli', '@remotion/transitions', '@remotion/motion-blur', '@remotion/google-fonts', 'react', 'react-dom']) {
    const manifest = require.resolve(`${name}/package.json`);
    assert.ok(manifest.startsWith(join(harness, 'company-tools/remotion/node_modules')), `Missing private renderer dependency: ${name}`);
    await access(manifest);
  }
  // Compiled account defaults must ship inside the application as well as assets.
  const { createRequire: requireModule } = await import('node:module');
  const buildRequire = requireModule(new URL('../apps/client/package.json', import.meta.url));
  const asar = buildRequire('@electron/asar');
  const files = new Set(asar.listPackage(join(resources, 'app.asar')).map(name => name.replaceAll('\\', '/')));
  for (const name of ['company-preset-data.js', 'company-preset.js', 'desktop-video-defaults.js', 'runtime-configuration.js']) {
    assert.ok(files.has(`/dist/${name}`), `Missing packaged default configuration: ${name}`);
  }
  for (const name of ['startup-update.js', 'electron-update.js', 'startup-installer.js', 'incremental-update.js', 'incremental-update-protocol.js', 'update-trust.js']) {
    assert.ok(files.has(`/dist/${name}`), `Missing packaged startup update module: ${name}`);
  }
  const appManifest = JSON.parse(asar.extractFile(join(resources, 'app.asar'), 'package.json').toString());
  const compiled = fileURLToPath(new URL('../apps/client/dist/', import.meta.url));
  let compiledFiles = 0;
  for (const name of files) {
    if (!name.startsWith('/dist/')) continue;
    const archivePath = join(...name.slice(1).split('/'));
    if (asar.statFile(join(resources, 'app.asar'), archivePath).files) continue;
    assert.deepEqual(asar.extractFile(join(resources, 'app.asar'), archivePath),
      await readFile(join(compiled, name.slice('/dist/'.length))), `Stale packaged client file: ${name}`);
    compiledFiles++;
  }
  async function verifyPlugins(folder, parts = []) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const next = [...parts, item.name], source = join(folder, item.name);
      if (item.isDirectory()) await verifyPlugins(source, next);
      else if (item.isFile()) {
        assert.deepEqual(await readFile(join(resources, 'company-plugins', ...next)), await readFile(source),
          `Stale packaged company plugin: ${next.join('/')}`);
        compiledFiles++;
      } else throw new Error('Unexpected compiled plugin link');
    }
  }
  await verifyPlugins(join(compiled, 'runtime'));
  assert.match(appManifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Packaged release must have a stable version');
  assert.equal(appManifest.dependencies?.['electron-updater'], '6.8.9');
  assert.equal(JSON.parse(asar.extractFile(join(resources, 'app.asar'), join('node_modules', 'electron-updater', 'package.json')).toString()).version, '6.8.9');
  if (requireUpdateFeed) {
    const yaml = createRequire(join(harness, 'package.json'))('yaml');
    const update = yaml.parse(await readFile(join(resources, 'app-update.yml'), 'utf8'));
    assert.equal(update.provider, 'generic');
    assert.equal(update.url, 'https://dsh.example.com/api/v1/client-updates/windows/x64/');
  }
  const company = JSON.parse(await readFile(join(resources, 'company-config.json'), 'utf8'));
  assert.deepEqual(company, { mode: 'production', serverUrl: 'https://dsh.example.com' });
  return { pluginPackages: Object.keys(packages).length, defaultConfiguration: true, offlineVideoDependencies: true,
    startupUpdater: '6.8.9', updateFeedChecked: requireUpdateFeed, version: appManifest.version, compiledFiles };
}
export default async function afterPack(context) {
  // Builder only emits app-update.yml for NSIS targets, not --dir-only previews.
  // The explicit post-build/extraction check always requires the production feed.
  const result = await verifyPackagedPreinstalled(join(context.appOutDir, 'resources'),
    { requireUpdateFeed: context.targets.some(target => target.name === 'nsis'), requireBootstrap: false });
  console.log(`Packaged presets verified: ${JSON.stringify(result)}`);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(JSON.stringify(await verifyPackagedPreinstalled(process.argv[2])));
}
