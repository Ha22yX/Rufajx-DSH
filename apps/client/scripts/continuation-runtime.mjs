// Extend only the materialized pinned InputBar. Never edit the upstream checkout.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTINUATION_PROMPT, rufaCanContinue, rufaSubmitContinuation } from '../src/runtime/continuation-ui.mjs';

const marker = '// Rufajx native composer continuation v1';
const header = 'const InputBar = (0, react.memo)(function InputBar({ useSession, useInput, inputActions, keyboard,';
function changes() {
  return [
    [header, `${marker}\nconst CONTINUATION_PROMPT = ${JSON.stringify(CONTINUATION_PROMPT)};\n${rufaCanContinue}\n${rufaSubmitContinuation}\n${header.replace('keyboard,', 'keyboard, rufaCurrentState,')}`],
    ['const primaryStops = running && subagent === null && (empty || blocked !== void 0);', `const rufaSession = useSession(s => s);
      const rufaContinuation = useProjection("rufaContinuation");
      const rufaContinueLock = (0, react.useRef)(false);
      const [rufaContinuePending, setRufaContinuePending] = (0, react.useState)(false);
      (0, react.useEffect)(() => {
        rufaContinueLock.current = false;
        setRufaContinuePending(false);
      }, [sessionId, rufaContinuation?.startSeq, rufaContinuation?.endSeq, running, promptError]);
      const primaryContinues = rufaCurrentState !== void 0 && rufaCanContinue({
        continuation: rufaContinuation, session: rufaSession, input, disabled, uploadsPending
      });
      const primaryStops = running && subagent === null && (empty || blocked !== void 0);`],
    ['const primaryDisabled = primaryStops ? stop === void 0 : empty || disabled || machineBusy || uploadsPending;',
      'const primaryDisabled = primaryStops ? stop === void 0 : primaryContinues ? rufaContinuePending : empty || disabled || machineBusy || uploadsPending;'],
    ['const primaryLabel = primaryStops ? t("input.stop") : running && steeringAvailable',
      'const primaryLabel = primaryStops ? t("input.stop") : primaryContinues ? "继续任务" : running && steeringAvailable'],
    ['if (keyboard === void 0) return;\n\t\t\t\t/* v8 ignore next -- defensive: the primary button is disabled for empty, disabled, and pending-upload states. */',
      `if (primaryContinues) {
          try {
            rufaSubmitContinuation({ current: rufaCurrentState, keyboard, inputActions, disabled, uploadsPending,
              lock: rufaContinueLock, setPending: setRufaContinuePending });
          } catch { showToast("继续任务未能提交，请重试。"); }
          return;
        }
        if (keyboard === void 0) return;
\t\t\t\t/* v8 ignore next -- defensive: the primary button is disabled for empty, disabled, and pending-upload states. */`],
    ['children: primaryStops ? (0, react_jsx_runtime.jsx)("svg", {',
      `children: primaryContinues ? (0, react_jsx_runtime.jsx)("svg", {
          viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": true,
          children: (0, react_jsx_runtime.jsx)("path", { d: "M5 2.5v11L13 8Z", fill: "currentColor" })
        }) : primaryStops ? (0, react_jsx_runtime.jsx)("svg", {`],
    ['stop: () => {\n\t\t\t\t\t\t\tstop(sessionId);\n\t\t\t\t\t\t},\n\t\t\t\t\t\thooks: {',
      `stop: () => {
\t\t\t\t\t\t\tstop(sessionId);
\t\t\t\t\t\t},
            rufaCurrentState: () => {
              const session = sessions.binding(sessionId)?.session;
              return { session: session?.getSnapshot(), continuation: session?.projections.faceOf("rufaContinuation").getSnapshot() };
            },
\t\t\t\t\t\thooks: {`],
  ];
}

export function patchContinuationSource(source) {
  const edits = changes();
  if (source.includes(marker)) {
    for (const [, after] of edits) if (source.split(after).length !== 2) throw new Error('Company continuation patch is incomplete or changed');
    return source;
  }
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error(`Pinned InputBar continuation anchor changed: ${before.slice(0, 80)}`);
    source = source.replace(before, () => after);
  }
  return source;
}

export async function patchContinuationRuntime(runtimeRoot) {
  const root = resolve(runtimeRoot);
  const manifest = JSON.parse(await readFile(join(root, 'rufa-runtime.json'), 'utf8'));
  if (manifest.upstreamCommit !== '687f282e8625c6b8d11ff58211a90524be2e4317') throw new Error('Unsupported Harness runtime revision');
  const path = join(root, 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js');
  const source = await readFile(path, 'utf8'), patched = patchContinuationSource(source);
  if (patched !== source) {
    // Atomic replacement breaks deployment hardlinks instead of mutating the reference tree.
    const temporary = `${path}.rufa-${randomUUID()}.tmp`;
    try { await writeFile(temporary, patched, { flag: 'wx' }); await rename(temporary, path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { composerContinuation: 1, changed: source !== patched };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node continuation-runtime.mjs <materialized-runtime>');
  console.log(JSON.stringify(await patchContinuationRuntime(process.argv[2])));
}
