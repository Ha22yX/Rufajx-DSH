import { access, cp, mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, join, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readdirSync, lstatSync, mkdirSync, linkSync, copyFileSync, realpathSync, readFileSync, globSync, existsSync } from 'node:fs';
import { normalizeServerUrl } from '../dist/company-api.js';
import { applyRuntimeSlim } from './runtime-slim.mjs';

// First run pnpm deploy in the separately built, pinned upstream checkout. This
// script only materializes that deployment; it never edits the upstream source.
const [stageInput, upstreamInput, serverInput, mode = 'production'] = process.argv.slice(2);
if (!stageInput || !upstreamInput || !serverInput || !['development', 'production'].includes(mode)) throw new Error('Usage: node prepare-runtime.mjs <pnpm-deploy-dir> <pinned-upstream-dir> <server-origin> [development|production]');
const stage = resolve(stageInput); const upstream = resolve(upstreamInput);
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const target = join(appRoot, 'runtime');
try { await lstat(target); throw new Error(`Refusing to overwrite an existing runtime: ${target}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const lock = JSON.parse(await readFile(new URL('../../../upstream.lock.json', import.meta.url), 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8', windowsHide: true }).trim();
const expected = lock.commit ?? lock.upstreamCommit;
if (commit !== expected) throw new Error(`Upstream commit must match upstream.lock.json (${expected})`);
const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
if (manifest.name !== '@deepseek-ai/dsh') throw new Error('Stage must be the pnpm deploy of @deepseek-ai/dsh');
await access(join(stage, 'lib/bin.js'));
const serverUrl = normalizeServerUrl(serverInput, mode === 'development');
console.log('Materializing complete hoisted production runtime (no junctions or external links)…');
await mkdir(target, { recursive: true });
let files = 0;
const upstreamReal = realpathSync.native(upstream);
const omittedDevelopmentPackages = [];
const nonRuntimePackages = new Set(['dsh-python-runtime-closure', '@deepseek-ai/dsh-benchmarks', '@deepseek-ai/dsh-desktop', '@deepseek-ai/dsh-plugin-market-generator', '@deepseek-ai/node-addon-system-workspace', '@deepseek-ai/website']);
function materialize(from, to) {
  const info = lstatSync(from);
  if (info.isSymbolicLink()) {
    const real = realpathSync.native(from);
    if (!real.startsWith(upstreamReal + sep)) throw new Error(`Unexpected package link outside pinned source: ${from}`);
    const pkg = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
    if (nonRuntimePackages.has(pkg.name)) { omittedDevelopmentPackages.push(pkg.name); return; }
    if (!Array.isArray(pkg.files)) throw new Error(`Workspace package has no explicit published file list: ${pkg.name}`);
    mkdirSync(to, { recursive: true });
    for (const pattern of ['package.json', 'LICENSE*', 'README*', ...pkg.files]) {
      if (pattern.startsWith('!') || pattern.includes('..') || pattern.includes('node_modules')) throw new Error(`Unsupported package file pattern: ${pkg.name} ${pattern}`);
      for (const file of globSync(pattern, { cwd: real })) materialize(join(real, file), join(to, file));
    }
    return;
  }
  if (info.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      if (['node_modules'].includes(name) && from.startsWith(upstreamReal + sep)) continue;
      if (['.bin', '.pnpm', '.cache', '.modules.yaml', '.pnpm-workspace-state-v1.json', '.git', '.env'].includes(name)) continue;
      materialize(join(from, name), join(to, name));
    }
  } else {
    if (existsSync(to)) return;
    mkdirSync(dirname(to), { recursive: true });
    // Build cache only: immutable files may share NTFS storage. The resulting
    // installer embeds bytes and has no dependency on this cache path.
    try { linkSync(from, to); } catch { copyFileSync(from, to); }
    files++;
  }
}
materialize(stage, target);
await writeFile(join(target, 'rufa-runtime.json'), JSON.stringify({ upstreamCommit: commit, version: manifest.version, cli: 'lib/bin.js', platform: 'win32-x64', omittedDevelopmentPackages, preparedAt: new Date().toISOString() }, null, 2));
await (await import('../../../scripts/history-runtime.mjs')).patchHistoryRuntime(target);
await (await import('./continuation-runtime.mjs')).patchContinuationRuntime(target);
await (await import('./projects-runtime.mjs')).patchProjectsRuntime(target);
await (await import('../../../scripts/badge-runtime.mjs')).patchBadgeRuntime(target);
await cp(join(upstream, 'LICENSE'), join(target, 'UPSTREAM-LICENSE.txt'));
await writeFile(join(appRoot, 'company-config.json'), JSON.stringify({ mode, serverUrl }, null, 2));
await applyRuntimeSlim(await realpath(target));
console.log(`Prepared ${manifest.version} (${commit}), ${files} files at ${target}; ${mode} server ${serverUrl}`);
