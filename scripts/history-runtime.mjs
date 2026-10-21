// Replayable extensions on the materialized pinned runtime only.
// A remotely active turn is not a crashed local turn: read-only views must
// preserve its exact cursor. Native write-owned crash recovery stays unchanged.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const before = 'events: [...events, ...interruptedTurnClosers(events)]';
const after = 'events: persistence.rufaExactHistory === true ? [...events] : [...events, ...interruptedTurnClosers(events)]';

export function patchHistorySource(source) {
  if (source.includes(after)) {
    if (source.split(after).length !== 2) throw new Error('Ambiguous company history extension');
    return source;
  }
  if (source.split(before).length !== 2 || !source.includes('async function readColdSessionLog(persistence, sessionId, signal)')) {
    throw new Error('Pinned Harness cold-history implementation changed');
  }
  return source.replace(before, after);
}

export function patchHistoryControllerSource(source) {
  const before = 'if (address.kind === "session" && source.source === "prepared") {';
  const after = 'if (address.kind === "session" && source.source === "prepared" && this.ctx.get("sessionPersistence")?.rufaExactHistory !== true) {';
  if (source.includes(after)) {
    if (source.split(after).length !== 2) throw new Error('Ambiguous company read-only history gate');
    return source;
  }
  if (source.split(before).length !== 2 || !source.includes('this.promote(promotion);')) throw new Error('Pinned Harness history promotion implementation changed');
  return source.replace(before, after);
}

export function patchCommandHistoryWarmSource(source) {
  const before = 'warm: (session) => {\n\t\t\t\t\t\tthis.directory.warm(session.sessionId);\n\t\t\t\t\t}';
  const after = 'warm: () => { /* Rufajx: load commands on user interaction, never promote cold history on mount. */ }';
  if (source.includes(after)) {
    if (source.split(after).length !== 2) throw new Error('Ambiguous company command warm gate');
    return source;
  }
  if (source.split(before).length !== 2 || !source.includes('this.directory.ensureReady(session.sessionId, req.signal)')) throw new Error('Pinned Harness command prewarm implementation changed');
  return source.replace(before, after);
}

export async function patchHistoryRuntime(runtimeRoot) {
  const root = resolve(runtimeRoot);
  const manifest = JSON.parse(await readFile(join(root, 'rufa-runtime.json'), 'utf8'));
  if (manifest.upstreamCommit !== '687f282e8625c6b8d11ff58211a90524be2e4317') throw new Error('Unsupported Harness runtime revision');
  const edits = await Promise.all([
    ['dsh-session-query', 'index.js', patchHistorySource], ['dsh-api-session-controller', 'index.js', patchHistoryControllerSource],
    ['dsh-client-ui-commands', 'client.js', patchCommandHistoryWarmSource],
  ].map(async ([name, file, patch]) => {
    const path = join(root, 'node_modules/@deepseek-ai', name, 'lib', file);
    const source = await readFile(path, 'utf8');
    return { path, source, patched: patch(source) };
  }));
  for (const { path, source, patched } of edits) if (source !== patched) {
    const temporary = `${path}.rufa-${randomUUID()}.tmp`;
    try { await writeFile(temporary, patched, { flag: 'wx' }); await rename(temporary, path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { exactCompanyHistory: true, readOnlyObservation: true, changed: edits.some(({ source, patched }) => source !== patched) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node history-runtime.mjs <materialized-runtime>');
  console.log(JSON.stringify(await patchHistoryRuntime(process.argv[2])));
}
