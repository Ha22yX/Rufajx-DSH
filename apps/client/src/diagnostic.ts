import type { Writable } from 'node:stream';

// Diagnostics are optional; a disconnected console must not interrupt shutdown or IPC.
export function protectDiagnostic(sink?: (text: string) => void): (text: string) => void {
  let enabled = Boolean(sink);
  return text => {
    if (!enabled) return;
    try { sink?.(text); } catch { enabled = false; }
  };
}

export function createDiagnosticWriter(stream: Writable): (text: string) => void {
  let enabled = true;
  const disable = () => { enabled = false; };
  // Writable failures may arrive after write() returns, including EPIPE on Windows.
  // Keep the listener for the stream's lifetime to handle pending writes as well.
  stream.on('error', disable);
  stream.once('close', disable);
  return protectDiagnostic(text => {
    if (!enabled || stream.destroyed || stream.writableEnded || !stream.writable) return;
    stream.write(text, error => { if (error) disable(); });
  });
}
