// Rebrand only static UI dictionary values in the materialized runtime.
// Protocol identifiers, original source, licenses and user data are untouched.
import { readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function rebrandText(text) {
  return text.replace(/DSH (?:本地构建|Local Build)|DeepSeek Harness/g, 'Rufajx-DSH')
    .replace(/(?<!Rufajx-)\bDSH\b/g, 'Rufajx-DSH');
}

export function rebrandDictionarySource(source, ts) {
  const ast = ts.createSourceFile('client.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  function visit(node) {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        ts.isPropertyAssignment(node.parent) && node.parent.initializer === node) {
      const updated = rebrandText(node.text);
      if (updated !== node.text) edits.push({ start: node.getStart(ast), end: node.end, text: JSON.stringify(updated) });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return { source, replacements: edits.length };
}

export async function brandRuntime(runtimeRoot, workspaceRoot) {
  const runtime = resolve(runtimeRoot);
  const manifest = JSON.parse(await readFile(join(runtime, 'rufa-runtime.json'), 'utf8'));
  if (manifest.upstreamCommit !== '687f282e8625c6b8d11ff58211a90524be2e4317') throw new Error('Unsupported Harness runtime revision');
  const ts = createRequire(join(resolve(workspaceRoot), 'package.json'))('typescript');
  const packages = join(runtime, 'node_modules', '@deepseek-ai');
  const changed = [];
  for (const entry of await readdir(packages, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-client-')) continue;
    const path = join(packages, entry.name, 'lib', 'client.js');
    let original;
    try { original = await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const result = rebrandDictionarySource(original, ts);
    if (!result.replacements) continue;
    // The materializer may hardlink files to the pinned build cache. Replace
    // this runtime entry atomically instead of modifying the shared inode.
    const temporary = `${path}.rufa-${randomUUID()}.tmp`;
    try { await writeFile(temporary, result.source, { flag: 'wx' }); await rename(temporary, path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    changed.push({ package: entry.name, replacements: result.replacements });
  }
  return { brand: 'Rufajx-DSH', changed };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [runtime, workspace = resolve(fileURLToPath(new URL('../', import.meta.url)))] = process.argv.slice(2);
  if (!runtime) throw new Error('Usage: node brand-runtime.mjs <materialized-runtime> [workspace]');
  console.log(JSON.stringify(await brandRuntime(runtime, workspace)));
}
