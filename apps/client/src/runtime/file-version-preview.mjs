import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';

const fallback = () => ({ kind: 'binary', summary: '暂无法展示内容差异',
  notice: '可恢复已保存的完整版本；内容对比暂时不可用。', changes: [], truncated: false });

// Paths must be authorized CAS paths obtained from file-version-store, never
// browser/model supplied paths. Extraction cannot modify files or call a model.
export async function previewFileVersions({ beforePath, afterPath, name, pythonPath, signal }) {
  if (typeof name !== 'string' || !name || !isAbsolute(pythonPath ?? '')
    || [beforePath, afterPath].some(path => path != null && (typeof path !== 'string' || !isAbsolute(path)))) {
    throw new TypeError('文件版本预览参数无效。');
  }
  signal?.throwIfAborted();
  if (beforePath === afterPath) return { kind: 'text', summary: '两个版本内容相同', changes: [], truncated: false };
  return new Promise((resolve, reject) => {
    execFile(pythonPath, ['-I', '-B', fileURLToPath(new URL('./file-version-preview.py', import.meta.url)),
      '--before', beforePath ?? '', '--after', afterPath ?? '', '--name', name],
    { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', signal }, (error, stdout) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      if (error) { resolve(fallback()); return; }
      try {
        const result = JSON.parse(stdout);
        if (!['office', 'text', 'binary'].includes(result.kind) || typeof result.summary !== 'string'
          || !Array.isArray(result.changes) || result.changes.length > 200
          || result.changes.some(row => !row || ['location', 'before', 'after'].some(key => typeof row[key] !== 'string'))) throw new Error('Invalid preview');
        resolve(result);
      } catch { resolve(fallback()); }
    });
  });
}
