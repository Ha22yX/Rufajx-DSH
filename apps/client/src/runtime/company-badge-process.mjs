import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { badgeFormats } from './company-badge-paths.mjs';

const failed = () => new Error('徽章署名处理未完成，请检查文件后重试。');
const cancelled = () => new Error('徽章署名操作已取消，请核对文件及历史版本。');

export function badgeProcessEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(key)));
}

function resultOf(value, operation) {
  const keys = operation === 'stamp' ? ['authors', 'format', 'changed'] : ['authors', 'format'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))
    || !badgeFormats.has(value.format) || !Array.isArray(value.authors) || value.authors.length > 1000
    || value.authors.some(name => typeof name !== 'string' || !name.trim() || name.length > 128 || /[\0-\x1f\x7f]/.test(name))
    || operation === 'stamp' && typeof value.changed !== 'boolean') throw failed();
  return value;
}

// Keep the mutation lock until close: an aborted or failed child must no longer
// be able to write when the caller records the final raw-byte version.
export function runBadgeHelper({ pythonPath, helperPath, request, signal, beforePublish, timeoutMs = 30000 }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child, error, result, state = 'initial', pending = '', bytes = 0, stderrBytes = 0, killTimer, closed = false;
    const local = new AbortController(), workSignal = AbortSignal.any([signal, local.signal]);
    const fail = reason => {
      if (error) return;
      error = reason; local.abort();
      if (closed) return;
      // Publication permission has already been sent: EOF cannot revoke it.
      // Terminate immediately; if the OS replacement already committed, the
      // caller still captures that actual outcome after the child closes.
      if (state === 'published' || state === 'final') { child?.kill(); return; }
      // EOF denies publication and lets the helper remove its temporary file.
      child?.stdin.end();
      killTimer = setTimeout(() => child?.kill(), 750);
    };
    const abort = () => fail(cancelled());
    let queue = Promise.resolve();
    const line = async raw => {
      if (error) return;
      let value; try { value = JSON.parse(raw); } catch { throw failed(); }
      if (request.operation === 'stamp' && value?.ready === true && Object.keys(value).length === 1 && state === 'initial') {
        state = 'checking';
        let onAbort;
        try {
          await Promise.race([beforePublish(workSignal), new Promise((_, rejectGate) => {
            onAbort = () => rejectGate(cancelled());
            workSignal.addEventListener('abort', onAbort, { once: true });
            if (workSignal.aborted) onAbort();
          })]);
        } finally { workSignal.removeEventListener('abort', onAbort); }
        workSignal.throwIfAborted();
        if (closed || error) throw failed();
        state = 'published';
        child.stdin.end(`${JSON.stringify({ publish: true })}\n`);
      } else {
        if (result || state !== (request.operation === 'stamp' ? 'published' : 'initial')) throw failed();
        result = resultOf(value, request.operation); state = 'final';
      }
    };
    const addLine = raw => { queue = queue.then(() => line(raw)).catch(reason => fail(reason)); };
    try {
      child = spawn(pythonPath, ['-I', '-B', helperPath], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, cwd: dirname(helperPath), env: badgeProcessEnvironment(),
      });
    } catch { reject(failed()); return; }
    const timer = setTimeout(() => fail(new Error('徽章署名处理超时，请检查文件后重试。')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) { fail(failed()); return; }
      pending += chunk;
      let end; while ((end = pending.indexOf('\n')) >= 0) {
        const raw = pending.slice(0, end); pending = pending.slice(end + 1);
        if (raw.trim()) addLine(raw);
      }
    });
    // Diagnostic text is deliberately never surfaced or inherited by logs.
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 8192) fail(failed()); });
    child.stdin.on('error', () => fail(failed()));
    child.on('error', () => fail(failed()));
    child.once('close', async code => {
      closed = true; clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', abort);
      if (pending.trim()) addLine(pending);
      // Do not await a network gate that is no longer meaningful after exit.
      local.abort();
      await queue;
      if (signal.aborted) error ??= cancelled();
      if (code !== 0 || !result || state !== 'final' || error) reject(error ?? failed());
      else resolve(result);
    });
    if (!error) child.stdin.write(`${JSON.stringify({ ...request, deferPublish: true })}\n`);
  });
}
