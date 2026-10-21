import { mkdir, readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const autoReviewBundle = '@deepseek-ai/dsh-experimental-auto-review';
const defaultFeatureBundles = [
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
];
export const officeFeatureBundles = ['@rufa/dsh-office-bundle', '@rufa/dsh-read-pdf-bundle', 'dsh-file-upload-ocr-plugin'];
export const sidebarFeatureBundle = 'dsh-better-sidebar';
export const mediaPreviewFeatureBundles = ['dsh-video-preview', '@huanlin/dsh-plugin-better-sidebar-plugin-audio'];
export const agentTeamFeatureBundle = '@deepseek-ai/dsh-experimental-agent-team-profile';
export const badgeSkillFeatureBundle = '@deepseek-ai/dsh-experimental-badge-skill-bundle';

async function atomicWrite(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.pending`;
  try { await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function hasMarker(file: string): Promise<boolean> {
  try { return (await readFile(file, 'utf8')).trim() === '1'; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false; }
}

export function accountRuntimePaths(userRoot: string, serverUrl: string, userId: string) {
  const scope = createHash('sha256').update(`${serverUrl}:${userId}`).digest('hex');
  const companyHome = join(userRoot, scope);
  return { companyHome, skillsRoot: join(companyHome, 'skills'), agentsHome: join(companyHome, 'agent-context'),
    workspaceRoot: join(companyHome, 'workspaces', 'default'), profileRoot: join(companyHome, 'profiles', 'web') };
}

/** Validate existing account ancestors before any profile/default/overlay write. */
export async function prepareAccountDirectories(userRoot: string, paths: ReturnType<typeof accountRuntimePaths>) {
  const root = resolve(userRoot), same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same(await realpath(root), root)) throw new Error('账号数据根目录已被重定向。');
  const directories = new Set<string>();
  for (const target of [paths.companyHome, paths.skillsRoot, paths.agentsHome, paths.workspaceRoot, paths.profileRoot]) {
    const suffix = relative(root, target);
    if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw new Error('账号目录不属于当前数据根目录。');
    let cursor = root;
    for (const segment of suffix.split(sep)) { cursor = join(cursor, segment); directories.add(cursor); }
  }
  const check = async (path: string, optional: boolean) => {
    try { if (!same(await realpath(path), path)) throw new Error('账号目录已被重定向，请修复后重试。'); }
    catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  };
  for (const path of directories) await check(path, true);
  for (const path of directories) {
    try { await mkdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await check(path, false);
  }
}

export async function writeAccountOverlay(companyHome: string, overlay: object[]) {
  const file = join(companyHome, 'enterprise-overlay.json');
  await atomicWrite(file, JSON.stringify(overlay, null, 2));
  return file;
}

/** Native asynchronous realpath resolves Windows MSIX aliases; realpathSync without .native does not. */
export async function canonicalRuntimePaths(config: { runtimeRoot: string; pluginRoot: string; execPath: string; userRoot: string }) {
  await mkdir(config.userRoot, { recursive: true });
  const [runtimeRoot, pluginRoot, execPath, userRoot] = await Promise.all([
    realpath(resolve(config.runtimeRoot)), realpath(resolve(config.pluginRoot)), realpath(resolve(config.execPath)), realpath(resolve(config.userRoot)),
  ]);
  return { runtimeRoot, pluginRoot, execPath, userRoot };
}

/** Seed editable defaults once; the company-required review bundle is enabled on every launch. */
export async function initializeProfileDefaults(companyHome: string, runtimeRoot: string, modelId: string): Promise<void> {
  const directory = join(companyHome, 'profiles/web');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'cordis.patch.yml');
  const marker = join(directory, '.rufa-defaults-v1');
  const featureMarker = join(directory, '.rufa-feature-defaults-v1');
  const officeMarker = join(directory, '.rufa-office-defaults-v1');
  const sidebarMarker = join(directory, '.rufa-better-sidebar-defaults-v1');
  const mediaPreviewMarker = join(directory, '.rufa-media-preview-defaults-v1');
  const agentTeamMarker = join(directory, '.rufa-agent-team-defaults-v1');
  const badgeSkillMarker = join(directory, '.rufa-badge-skill-defaults-v1');
  const seeded = await hasMarker(marker), featuresSeeded = await hasMarker(featureMarker);
  const officeSeeded = await hasMarker(officeMarker);
  const sidebarSeeded = await hasMarker(sidebarMarker);
  const mediaPreviewSeeded = await hasMarker(mediaPreviewMarker);
  const agentTeamSeeded = await hasMarker(agentTeamMarker);
  const badgeSkillSeeded = await hasMarker(badgeSkillMarker);
  let source = '[]\n';
  try { source = await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const runtimeManifest = join(runtimeRoot, 'package.json');
  const runtimeRequire = createRequire(runtimeManifest);
  const yaml = runtimeRequire('yaml');
  const document = yaml.parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] });
  if (document.errors.length || !yaml.isSeq(document.contents)) throw new Error('The existing profile patch must remain a valid YAML sequence');
  const has = (id: string) => document.contents.items.some((item: unknown) => yaml.isMap(item) && (item as { get(key: string): unknown }).get('id') === id);
  let changed = false;
  for (const row of [{ id: 'ui-theme', config: { preference: 'dark' } }, { id: 'agent-default-model', config: { provider: 'deepseek-official', model: modelId } }]) {
    if (!seeded && !has(row.id)) { document.contents.items.unshift(document.createNode(row)); changed = true; }
  }
  // The official bundle also defaults these fields. Keep an existing user row intact,
  // including partial settings, comments and custom YAML tags; native defaults fill gaps.
  if (!featuresSeeded && !has('cot-translation')) {
    document.contents.items.unshift(document.createNode({ id: 'cot-translation', config: { provider: 'bing', targetLanguage: 'auto' } }));
    changed = true;
  }
  // Resolve through the packaged runtime so profile templates and bundle migrations
  // stay native. Avoid parsing/evaluating the user layer here; it was checked above.
  const { loadProfile } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
  loadProfile('dsh', 'web', runtimeManifest, companyHome, { userLayer: false });
  const manifestFile = join(directory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  if (!Array.isArray(bundles) || bundles.some((bundle: unknown) => typeof bundle !== 'string')) throw new Error('The existing profile bundle list must contain package names');
  const additions = [autoReviewBundle, ...featuresSeeded ? [] : defaultFeatureBundles,
    ...officeSeeded ? [] : officeFeatureBundles,
    ...sidebarSeeded ? [] : [sidebarFeatureBundle],
    ...mediaPreviewSeeded ? [] : mediaPreviewFeatureBundles,
    ...agentTeamSeeded ? [] : [agentTeamFeatureBundle],
    ...badgeSkillSeeded ? [] : [badgeSkillFeatureBundle]].filter(bundle => !bundles.includes(bundle));
  if (additions.length) {
    await atomicWrite(manifestFile, `${JSON.stringify({ ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, ...additions] } } }, null, 2)}\n`);
  }
  if (changed) {
    document.contents.flow = false;
    await atomicWrite(file, String(document));
  }
  // Native profile loading reports unavailable bundles instead of throwing. Do
  // not mark an account migrated when the requested shipped plugins were skipped.
  const enabledOffice = officeFeatureBundles.filter(bundle => !officeSeeded || bundles.includes(bundle));
  const loaded = loadProfile('dsh', 'web', runtimeManifest, companyHome, { userLayer: false });
  const available = new Set(loaded.layers.map((layer: { packageName: string }) => layer.packageName));
  if (enabledOffice.some(bundle => !available.has(bundle))) throw new Error('预装办公插件未完整安装，请修复客户端运行环境后重试。');
  if ((!sidebarSeeded || bundles.includes(sidebarFeatureBundle)) && !available.has(sidebarFeatureBundle)) throw new Error('预装侧栏插件未完整安装，请修复客户端运行环境后重试。');
  const enabledMediaPreview = mediaPreviewFeatureBundles.filter(bundle => !mediaPreviewSeeded || bundles.includes(bundle));
  if (enabledMediaPreview.some(bundle => !available.has(bundle))) throw new Error('预装音视频预览插件未完整安装，请修复客户端运行环境后重试。');
  if ((!agentTeamSeeded || bundles.includes(agentTeamFeatureBundle)) && !available.has(agentTeamFeatureBundle)) throw new Error('预装智能体团队插件未完整安装，请修复客户端运行环境后重试。');
  if ((!badgeSkillSeeded || bundles.includes(badgeSkillFeatureBundle)) && !available.has(badgeSkillFeatureBundle)) throw new Error('预装公司徽章插件未完整安装，请修复客户端运行环境后重试。');
  // Commit markers last. A failed write retries idempotently at the next launch.
  if (!seeded) await atomicWrite(marker, '1\n');
  if (!featuresSeeded) await atomicWrite(featureMarker, '1\n');
  if (!officeSeeded) await atomicWrite(officeMarker, '1\n');
  if (!sidebarSeeded) await atomicWrite(sidebarMarker, '1\n');
  if (!mediaPreviewSeeded) await atomicWrite(mediaPreviewMarker, '1\n');
  if (!agentTeamSeeded) await atomicWrite(agentTeamMarker, '1\n');
  if (!badgeSkillSeeded) await atomicWrite(badgeSkillMarker, '1\n');
}
