// Offline CLI for the company-bundled Remotion runtime. Execute through the
// native reviewed command tool, in the current account's working directory.
import { readFile, writeFile, mkdir, readdir, access, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const modules = join(root, 'node_modules');
const browserExecutable = join(root, 'browser/chrome-headless-shell-win64/chrome-headless-shell.exe');
const compositor = join(modules, '@remotion/compositor-win32-x64-msvc');
const [action, ...argv] = process.argv.slice(2);
const positional = [], flags = {};
for (let index = 0; index < argv.length; index++) {
  if (!argv[index].startsWith('--')) positional.push(argv[index]);
  else {
    const [key, inline] = argv[index].slice(2).split(/=(.*)/s);
    flags[key] = inline ?? (key === 'overwrite' ? true : argv[++index]);
  }
}
const help = 'init <project> | compositions <entry> | render <entry> <id> <output> [--codec h264 --crf 17 --props props.json --overwrite] | still <entry> <id> <output> --frame 15 | probe <media> | frame <media> <png> --time 1.5';
async function run(exe, args) {
  await new Promise((done, fail) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: 'inherit', shell: false });
    child.once('error', fail);
    child.once('exit', (code, signal) => code === 0 ? done() : fail(new Error(`Media command failed (${signal ?? code})`)));
  });
}
async function outputPath(value) {
  if (!value) throw new Error(help);
  const path = resolve(value);
  if (!flags.overwrite) {
    try { await access(path); throw new Error('Output already exists; choose another name or explicitly use --overwrite.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(dirname(path), { recursive: true });
  return path;
}
async function main() {
  if (action === 'init') {
    if (!positional[0]) throw new Error(help);
    const project = resolve(positional[0]);
    const existing = await readdir(project).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (existing.length) throw new Error('Create a new empty project directory; existing files are never replaced by init.');
    await mkdir(join(project, 'src'), { recursive: true });
    await mkdir(join(project, 'public'), { recursive: true });
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'rufa-video-project', private: true, version: '1.0.0', dependencies: { remotion: '4.0.537', react: '19.2.0', 'react-dom': '19.2.0' } }, null, 2));
    await copyFile(join(root, 'remotion-motion-graphics/assets/theme.ts'), join(project, 'src/theme.ts'));
    await writeFile(join(project, 'src/index.ts'), "import {registerRoot} from 'remotion';\nimport {Root} from './Root';\nregisterRoot(Root);\n");
    await writeFile(join(project, 'README.md'), 'Create src/Root.tsx with your compositions. Use the Rufajx-DSH bundled runner to render and inspect frames; no npm install is required.\n');
    console.log(JSON.stringify({ project, entry: join(project, 'src/index.ts') }));
    return;
  }
  if (action === 'probe') {
    if (!positional[0]) throw new Error(help);
    await run(join(compositor, 'ffprobe.exe'), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', resolve(positional[0])]);
    return;
  }
  if (action === 'frame') {
    const output = await outputPath(positional[1]);
    const seconds = Number(flags.time ?? 0);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid frame time');
    await run(join(compositor, 'ffmpeg.exe'), ['-v', 'error', flags.overwrite ? '-y' : '-n', '-ss', String(seconds), '-i', resolve(positional[0]), '-frames:v', '1', output]);
    return;
  }
  if (!['render', 'still', 'compositions'].includes(action) || !positional[0]) throw new Error(help);
  await access(browserExecutable); // No implicit browser/network installation.
  const { bundle } = await import('@remotion/bundler');
  const { selectComposition, getCompositions, renderMedia, renderStill } = await import('@remotion/renderer');
  const entryPoint = resolve(positional[0]);
  // Locate the user's project, never write dependencies into its directory.
  let project = dirname(entryPoint);
  while (project !== dirname(project)) {
    try { await access(join(project, 'package.json')); break; } catch { project = dirname(project); }
  }
  if (project === dirname(project)) project = dirname(entryPoint);
  const temp = await mkdtemp(join(tmpdir(), 'rufa-remotion-render-'));
  try {
    const serveUrl = await bundle({ entryPoint, rootDir: project, outDir: join(temp, 'bundle'), enableCaching: false,
      publicDir: join(project, 'public'), gitSource: null,
      webpackOverride: config => ({ ...config, resolve: { ...config.resolve,
        modules: [modules, ...(config.resolve?.modules ?? ['node_modules'])],
        alias: { ...config.resolve?.alias, react: join(modules, 'react'), 'react-dom': join(modules, 'react-dom'), remotion: join(modules, 'remotion') } } }) });
    const inputProps = flags.props ? JSON.parse(await readFile(resolve(flags.props), 'utf8')) : {};
    const common = { serveUrl, browserExecutable, inputProps, logLevel: 'warn' };
    if (action === 'compositions') { console.log(JSON.stringify(await getCompositions(serveUrl, common))); return; }
    const composition = await selectComposition({ ...common, id: positional[1] });
    const output = await outputPath(positional[2]);
    if (action === 'still') {
      const frame = Number(flags.frame ?? 0);
      if (!Number.isInteger(frame) || frame < 0 || frame >= composition.durationInFrames) throw new Error('Invalid still frame');
      await renderStill({ ...common, composition, output, frame });
    } else {
      const concurrency = Number(flags.concurrency ?? 2);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Invalid concurrency');
      await renderMedia({ ...common, composition, outputLocation: output, codec: flags.codec ?? 'h264',
        crf: Number(flags.crf ?? 17), concurrency });
    }
    console.log(JSON.stringify({ output, composition: composition.id, durationInFrames: composition.durationInFrames, fps: composition.fps }));
  } finally {
    const inside = relative(tmpdir(), temp);
    if (!inside.startsWith('rufa-remotion-render-') || inside.includes('..') || isAbsolute(inside)) throw new Error('Unsafe render cleanup path');
    await rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
