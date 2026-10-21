// Company customization of the pinned optional badge skill. Never edit upstream
// sources or write through materializer hardlinks to the build cache.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const badgeBundle = '@deepseek-ai/dsh-experimental-badge-skill-bundle';
export const badgeTitle = '如发机械有限公司徽章';
export const badgeDescription = '为文档、页面、PR 等产出添加“如发机械有限公司”署名标签。';
export const skillDescription = 'Add the 如发机械有限公司 attribution badge to documents, pull requests, merge requests, and other company outputs. Use whenever creating a pull request or merge request. Also use when the user asks for a company badge, company attribution, or a reusable company badge asset or snippet.';
const upstreamDescription = 'Add the official “powered by dsh” badge to documents, pull requests, merge requests, and other content produced with DeepSeek Harness. Use whenever creating a pull request or merge request. Also use when the user asks for a dsh badge, powered-by-dsh attribution, or a reusable dsh badge asset or snippet.';
const resources = fileURLToPath(new URL('./assets/company-badge/', import.meta.url));

export function patchBadgeProvider(source) {
  if (!source.includes(JSON.stringify(skillDescription))) {
    const needle = JSON.stringify(upstreamDescription);
    if (source.split(needle).length !== 2) throw new Error('Unsupported badge skill provider: description anchor changed');
    source = source.replace(needle, JSON.stringify(skillDescription));
  }
  const hook = 'ctx.inject(["rufaCompanyBadgeTools"], scoped => scoped.rufaCompanyBadgeTools.register(scoped));';
  if (!source.includes(hook)) {
    const anchor = 'ctx.skills.registerProvider(() => provider);';
    if (source.split(anchor).length !== 2) throw new Error('Unsupported badge skill provider: lifecycle anchor changed');
    source = source.replace(anchor, `${anchor}\n\t${hook}`);
  }
  return source;
}

export function patchBadgePreviews(source, preview) {
  const uri = `data:image/svg+xml;base64,${Buffer.from(preview).toString('base64')}`;
  for (const name of ['badge_skill_preview_default', 'badge_skill_preview_zh_default']) {
    const expression = new RegExp(`(var ${name} = )"data:image/svg\\+xml;base64,[A-Za-z0-9+/=]+";`, 'g');
    if ([...source.matchAll(expression)].length !== 1) throw new Error(`Unsupported badge preview anchor: ${name}`);
    source = source.replace(expression, (_match, prefix) => `${prefix}${JSON.stringify(uri)};`);
  }
  return source;
}

export async function patchBadgeRuntime(runtimeRoot) {
  const root = resolve(runtimeRoot);
  const manifest = JSON.parse(await readFile(join(root, 'rufa-runtime.json'), 'utf8'));
  if (manifest.upstreamCommit !== '687f282e8625c6b8d11ff58211a90524be2e4317') throw new Error('Unsupported Harness badge runtime revision');
  const bundle = join(root, 'node_modules', badgeBundle);
  const provider = join(root, 'node_modules/@deepseek-ai/dsh-skill-badge');
  const ui = join(root, 'node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js');
  const changes = [];
  const plan = async (path, content) => {
    const next = Buffer.from(content);
    let before;
    try { before = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!before?.equals(next)) changes.push({ path, content: next });
  };
  // Validate every expected package/anchor before replacing any file.
  for (const directory of [bundle, provider]) {
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (pkg.version !== '0.2.1-rc.2') throw new Error('Unsupported badge package version');
    await plan(join(directory, 'package.json'), `${JSON.stringify({ ...pkg, description: badgeDescription }, null, 2)}\n`);
    for (const language of ['en', 'zh']) {
      const path = join(directory, 'locale', `${language}.json`);
      const locale = JSON.parse(await readFile(path, 'utf8'));
      await plan(path, `${JSON.stringify({ ...locale, meta: { ...locale.meta, title: badgeTitle, description: badgeDescription } }, null, 2)}\n`);
    }
    await plan(join(directory, 'icon.svg'), await readFile(join(resources, 'icon.svg')));
  }
  await plan(join(provider, 'lib/index.js'), patchBadgeProvider(await readFile(join(provider, 'lib/index.js'), 'utf8')));
  await plan(join(provider, 'assets/dsh-badge.md'), await readFile(join(resources, 'badge.md')));
  for (const file of ['rufa-badge.png', 'rufa-badge.svg', 'badge_metadata.py']) await plan(join(provider, 'assets', file), await readFile(join(resources, file)));
  // Preserve old resource references while ensuring they also carry the company label.
  await plan(join(provider, 'assets/dsh-badge.png'), await readFile(join(resources, 'rufa-badge.png')));
  await plan(ui, patchBadgePreviews(await readFile(ui, 'utf8'), await readFile(join(resources, 'preview.svg'), 'utf8')));
  for (const { path, content } of changes) {
    const temporary = `${path}.rufa-badge-${randomUUID()}.tmp`;
    try { await writeFile(temporary, content, { flag: 'wx' }); await rename(temporary, path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { changed: changes.map(({ path }) => path) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node badge-runtime.mjs <materialized-runtime>');
  console.log(JSON.stringify(await patchBadgeRuntime(process.argv[2])));
}
