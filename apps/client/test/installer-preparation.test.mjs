import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareInstaller } from '../scripts/prepare-installer.mjs';

const client = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(client, 'package.json'));
const builder = process.env.RUFA_NSIS_BUILDER_ROOT || dirname(require.resolve('app-builder-lib/package.json'));
const sha = data => createHash('sha256').update(data).digest('hex');
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'rufa-installer-preparation-'));
  await writeFile(join(dir, 'package.json'), '{"name":"isolated-test"}');
  await cp(join(client, 'electron-builder.env'), join(dir, 'electron-builder.env'));
  await cp(join(client, 'preinstalled/installer'), join(dir, 'preinstalled/installer'), { recursive: true });
  return dir;
}

test('preparation selects direct extraction and retains native cache/signing templates without changing builder', async () => {
  const dir = await fixture();
  const original = join(builder, 'templates/nsis/include/extractAppPackage.nsh');
  const before = sha(await readFile(original));
  const result = await prepareInstaller({ clientDir: dir, builderDir: builder });
  const extraction = await readFile(join(result.output, 'extractAppPackage.nsh'), 'utf8');
  assert.match(extraction, /!insertmacro rufaExtractUsing7za/);
  assert.doesNotMatch(extraction, /7z-out|CopyFiles|Nsis7z::Extract/);
  const installation = await readFile(join(result.output, 'installer.nsh'), 'utf8');
  assert.match(installation, /!insertmacro rufaCacheInstaller/);
  assert.match(installation, /UNINSTALLER_OUT_FILE/);
  const oldUninstaller = await readFile(join(result.output, 'installUtil.nsh'), 'utf8');
  assert.equal(oldUninstaller.match(/!insertmacro rufaExecWaitUninstaller/g).length, 2);
  const assisted = await readFile(join(result.output, 'assistedInstaller.nsh'), 'utf8');
  assert.match(assisted, /Function instFilesPre\s+\$\{If\} \$\{isUpdated\}\s+Return/);
  assert.deepEqual(await readFile(join(result.output, 'uninstaller.nsh')), await readFile(join(builder, 'templates/nsis/uninstaller.nsh')));
  assert.deepEqual(await readFile(join(result.output, 'installer.nsi')), await readFile(join(builder, 'templates/nsis/installer.nsi')));
  assert.equal(sha(await readFile(original)), before);
  await prepareInstaller({ clientDir: dir, builderDir: builder });
  assert.equal(await readFile(join(result.output, 'extractAppPackage.nsh'), 'utf8'), extraction);
});

test('modified DLL is rejected before producing a ready template', async () => {
  const dir = await fixture();
  await writeFile(join(dir, 'preinstalled/installer/x86-unicode/RufaNsis7z.dll'), 'tampered');
  await assert.rejects(prepareInstaller({ clientDir: dir, builderDir: builder }), /dependency checksum mismatch/);
  await assert.rejects(access(join(dir, 'build/rufa-nsis/rufa-ready.nsh')));
});

test('modified old-uninstaller helper is rejected before preparing templates', async () => {
  const dir = await fixture();
  await writeFile(join(dir, 'preinstalled/installer/x86-unicode/RufaUpgradeTemp.dll'), 'tampered');
  await assert.rejects(prepareInstaller({ clientDir: dir, builderDir: builder }), /dependency checksum mismatch/);
});

test('incompatible or duplicate compression configuration fails before preparing templates', async () => {
  const dir = await fixture();
  await writeFile(join(dir, 'electron-builder.env'), 'ELECTRON_BUILDER_7Z_FILTER=BCJ\nELECTRON_BUILDER_7Z_FILTER=ARM64\n');
  await assert.rejects(prepareInstaller({ clientDir: dir, builderDir: builder }), /reviewed BCJ compression filter/);
});

test('unknown builder release and modified native template fail closed', async () => {
  const dir = await fixture();
  const fake = join(dir, 'builder');
  await mkdir(join(fake, 'templates/nsis/include'), { recursive: true });
  await writeFile(join(fake, 'package.json'), '{"version":"27.0.0"}');
  await assert.rejects(prepareInstaller({ clientDir: dir, builderDir: fake }), /reviewed electron-builder/);
  await writeFile(join(fake, 'package.json'), '{"version":"26.15.3"}');
  await writeFile(join(fake, 'templates/nsis/include/extractAppPackage.nsh'), 'changed template');
  await assert.rejects(prepareInstaller({ clientDir: dir, builderDir: fake }), /template checksum mismatch/);
});
