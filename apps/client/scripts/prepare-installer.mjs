import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const client = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = data => createHash('sha256').update(data).digest('hex');
const templateHashes = {
  'extractAppPackage.nsh': 'e4174388a0f7a1df0b85a0742aa1ea7a4b2b18f9f29dccd6ef10a66212f68148',
  'installer.nsh': '0e319437dd01dcbf911f3f48f664fde0cefbaef704f1cdb1739f63d563f5d4a0',
  'installUtil.nsh': '97bd546b5cd2aaf16b77bc9e2be8a18962dd74ab5c4d23b35b163ca89bf4dd2a',
};

export async function prepareInstaller({ clientDir = client, builderDir } = {}) {
  const filterLines = (await readFile(join(clientDir, 'electron-builder.env'), 'utf8'))
    .split(/\r?\n/).map(line => line.trim()).filter(line => /^ELECTRON_BUILDER_7Z_FILTER\s*=/.test(line));
  if (filterLines.length !== 1 || filterLines[0] !== 'ELECTRON_BUILDER_7Z_FILTER=BCJ' ||
      (process.env.ELECTRON_BUILDER_7Z_FILTER && process.env.ELECTRON_BUILDER_7Z_FILTER !== 'BCJ')) {
    throw new Error('Installer requires the reviewed BCJ compression filter; refuse incompatible archive settings');
  }
  const require = createRequire(join(clientDir, 'package.json'));
  builderDir ??= dirname(require.resolve('app-builder-lib/package.json'));
  const pkg = JSON.parse(await readFile(join(builderDir, 'package.json'), 'utf8'));
  if (pkg.version !== '26.15.3') throw new Error('Installer templates require reviewed electron-builder 26.15.3');
  const native = join(builderDir, 'templates/nsis');
  const sources = {};
  for (const [name, expected] of Object.entries(templateHashes)) {
    const bytes = await readFile(join(native, 'include', name));
    if (hash(bytes) !== expected) throw new Error(`Installer template checksum mismatch: ${name}`);
    sources[name] = bytes.toString('utf8').replaceAll('\r\n', '\n');
  }
  const assistedBytes = await readFile(join(native, 'assistedInstaller.nsh'));
  if (hash(assistedBytes) !== '8aa1230e9717b428664d613fcc5c6a060883410b34cb7853b517fe11b4ee0a76') throw new Error('Installer assisted template checksum mismatch');
  const pluginDir = join(clientDir, 'preinstalled/installer');
  const lock = JSON.parse(await readFile(join(pluginDir, 'installer.lock.json'), 'utf8'));
  for (const [name, expected] of Object.entries(lock.files)) {
    if (hash(await readFile(join(pluginDir, name))) !== expected) throw new Error(`Installer dependency checksum mismatch: ${name}`);
  }
  const output = join(clientDir, 'build/rufa-nsis');
  await mkdir(output, { recursive: true });
  // Keep native templates intact. Current-directory lookup selects this isolated
  // copy before builder's include directories. The main installer stays native,
  // including the separate signed-uninstaller build.
  for (const dir of [native, join(native, 'include')]) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile()) await cp(join(dir, entry.name), join(output, entry.name));
    }
  }
  const assistedPath = join(output, 'assistedInstaller.nsh');
  const assisted = assistedBytes.toString('utf8').replaceAll('\r\n', '\n');
  const directoryPre = 'Function instFilesPre\n';
  if (assisted.split(directoryPre).length !== 2) throw new Error('Unexpected assisted directory hook');
  // Visible --updated must not reinterpret the established custom install path.
  await writeFile(assistedPath, assisted.replace(directoryPre, directoryPre + '      ${If} ${isUpdated}\n        Return\n      ${EndIf}\n'));
  const extraction = sources['extractAppPackage.nsh'];
  const offset = extraction.indexOf('!macro extractUsing7za FILE\n');
  if (offset < 0 || !extraction.slice(offset).trimEnd().endsWith('!macroend')) throw new Error('Unexpected extraction template layout');
  await writeFile(join(output, 'extractAppPackage.nsh'), extraction.slice(0, offset) + '!macro extractUsing7za FILE\n  !insertmacro rufaExtractUsing7za "${FILE}"\n!macroend\n');
  const cache = '!insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"';
  if (sources['installer.nsh'].split(cache).length !== 2) throw new Error('Unexpected installer cache layout');
  await writeFile(join(output, 'installer.nsh'), sources['installer.nsh'].replace(cache, '!insertmacro rufaCacheInstaller'));
  let uninstall = sources['installUtil.nsh'];
  for (const name of ['$uninstallerFileNameTemp', '$uninstallerFileName']) {
    const command = `"${name}" /S /KEEP_APP_DATA $0 _?=$installationDir`;
    const before = `ExecWait '${command}' $R0`;
    if (uninstall.split(before).length !== 2) throw new Error('Unexpected old-uninstaller invocation layout');
    uninstall = uninstall.replace(before, `!insertmacro rufaExecWaitUninstaller '${command}'`);
  }
  await writeFile(join(output, 'installUtil.nsh'), uninstall);
  await writeFile(join(output, 'rufa-ready.nsh'), '; Generated from verified sources by prepare-installer.mjs\n!define RUFA_DIRECT_INSTALLER_READY\n');
  return { output, builder: pkg.version, pluginSha256: lock.files['x86-unicode/RufaNsis7z.dll'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const builderIndex = process.argv.indexOf('--builder');
  console.log(JSON.stringify(await prepareInstaller({ builderDir: builderIndex < 0 ? undefined : resolve(process.argv[builderIndex + 1]) })));
}
