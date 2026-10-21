import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const computerUseBundle = 'dsh-computer-use-win';
export const remotionSkillBundle = '@rufa/dsh-remotion-bundle';
export const computerUseTools = Object.freeze(['health', 'snapshot', 'accessibility_tree', 'list_windows', 'find', 'element_info',
  'click', 'double_click', 'move', 'drag', 'scroll', 'type_text', 'keypress', 'focus', 'invoke', 'set_value', 'activate_window',
  'wait', 'ocr', 'screenshot', 'wait_for', 'close_window', 'move_window', 'tools']);
export const computerUseDefaults = Object.freeze({ mode: 'full', toolPreset: 'full', enabledTools: computerUseTools,
  indicatorEnabled: true, cursorIndicatorEnabled: false, remoteIndicatorVisible: true,
  indicatorText: 'Rufa智能体正在控制电脑', indicatorPosition: 'top', indicatorIdleMs: 800, stopShortcut: '' });
const pending = new Map<string, Promise<void>>();

async function markerExists(file: string) {
  try {
    if ((await readFile(file, 'utf8')).trim() !== '1') throw new Error('电脑操作或视频技能的迁移标记损坏，请修复后重试。');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function replace(file: string, contents: string) {
  const temporary = `${file}.${randomUUID()}.pending`;
  try { await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Two independent, editable account defaults, applied after the fixed administrator preset. */
export function initializeDesktopVideoDefaults(companyHome: string, runtimeRoot: string): Promise<void> {
  const existing = pending.get(companyHome);
  if (existing) return existing;
  const task = migrate(companyHome, runtimeRoot).finally(() => { if (pending.get(companyHome) === task) pending.delete(companyHome); });
  pending.set(companyHome, task); return task;
}

async function migrate(companyHome: string, runtimeRoot: string): Promise<void> {
  const directory = join(companyHome, 'profiles/web'), manifestFile = join(directory, 'package.json'), patchFile = join(directory, 'cordis.patch.yml');
  const markers = [join(directory, '.rufa-computer-use-defaults-v1'), join(directory, '.rufa-remotion-defaults-v1')];
  const seeded = await Promise.all(markers.map(markerExists));
  const [manifestText, patchText] = await Promise.all([readFile(manifestFile, 'utf8'), readFile(patchFile, 'utf8')]);
  const manifest = JSON.parse(manifestText), bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.some((value: unknown) => typeof value !== 'string')) throw new Error('现有插件清单无效，未迁移电脑操作或视频技能。');
  const runtimeManifest = join(runtimeRoot, 'package.json'), require = createRequire(runtimeManifest), yaml = require('yaml');
  const document = yaml.parseDocument(patchText, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] });
  if (document.errors.length || !yaml.isSeq(document.contents)) throw new Error('现有插件配置无效，未迁移电脑操作或视频技能。');
  let patchChanged = false;
  if (!seeded[0]) {
    const rows = document.contents.items.filter((row: any) => yaml.isMap(row) && row.get('id') === 'mcp-dsh-computer-use-win');
    if (rows.length > 1) throw new Error('电脑操作插件存在重复配置，请修复后重试。');
    if (!rows.length) {
      document.contents.items.push(document.createNode({ id: 'mcp-dsh-computer-use-win', config: computerUseDefaults }));
      patchChanged = true;
    } else {
      // Respect a pre-existing installation's choices, including disabled and unknown fields.
      const row = rows[0]; let config = row.get('config');
      if (config === undefined || config === null) { row.set('config', document.createNode({})); config = row.get('config'); }
      if (!yaml.isMap(config)) throw new Error('电脑操作插件配置需要是普通映射，原有动态配置已保留。');
      for (const [key, value] of Object.entries(computerUseDefaults)) if (!config.has(key)) { config.set(key, document.createNode(value)); patchChanged = true; }
    }
  }
  const features = [computerUseBundle, remotionSkillBundle];
  const additions = features.filter((bundle, index) => !seeded[index] && !bundles.includes(bundle));
  const expected = features.filter((bundle, index) => !seeded[index] || bundles.includes(bundle));
  // Verify installation before changing the account. The native parser below checks actual bundle layers.
  for (const bundle of expected) {
    const installed = JSON.parse(await readFile(require.resolve(`${bundle}/package.json`), 'utf8'));
    if (installed.name !== bundle || !installed.dsh?.bundle?.patch) throw new Error(`预装组件未完整安装：${bundle}`);
    if (bundle === computerUseBundle && installed.version !== '0.4.3') throw new Error('电脑操作插件需要已验证的0.4.3版本。');
  }
  if (additions.length) await replace(manifestFile, JSON.stringify({ ...manifest,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: [...bundles, ...additions] } } }, null, 2) + '\n');
  if (patchChanged) { document.contents.flow = false; await replace(patchFile, String(document)); }
  const { loadProfile } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
  const loaded = loadProfile('dsh', 'web', runtimeManifest, companyHome, { userLayer: false });
  const available = new Set(loaded.layers.map((layer: { packageName: string }) => layer.packageName));
  if (expected.some(bundle => !available.has(bundle))) throw new Error('预装电脑操作或视频技能未完整加载，请修复客户端后重试。');
  for (let index = 0; index < markers.length; index++) if (!seeded[index]) await replace(markers[index], '1\n');
}
