import { createHash, verify } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { COMPANY_UPDATE_FEED, isNewerStableVersion } from './startup-update.js';

export const BOOTSTRAP_VERSION = '0.3.0';
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
export interface ReleaseFile { path: string; size: number; sha256: string; sha512: string }
export interface IncrementalManifest { schema: 1; version: string; platform: 'win32'; arch: 'x64'; releaseDate: string; minUpdaterVersion: string; files: ReleaseFile[] }
export interface IncrementalRelease {
  schema: 1; version: string; releaseDate: string; minUpdaterVersion: string;
  manifest: { url: string; size: number; sha512: string; keyId: string; algorithm: 'rsa-sha256'; signature: string };
  installer: { url: string; size: number; sha512: string };
}
export interface UpdateTrust { keyId: string; publicKey: string }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid update document');
  return value as Record<string, unknown>;
}
export function stableVersion(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value); }
export function validHash(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value; }
export function managedPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) || /[\\\x00-\x1f\x7f<>:"|?*]/.test(value)) return false;
  const parts = value.split('/');
  if (parts.some(p => !p || p.length > 255 || p === '.' || p === '..' || /[. ]$/.test(p) || /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(p))) return false;
  const first = parts[0].toLowerCase();
  return !['.rufa-update', 'rufajx-dsh.exe', 'rufajx-dsh.exe.config'].includes(first)
    && !/^uninstall.*\.exe$/i.test(first);
}
export function parseRelease(input: unknown): IncrementalRelease {
  const value = object(input), manifest = object(value.manifest), installer = object(value.installer);
  if (value.schema !== 1 || !stableVersion(value.version) || !stableVersion(value.minUpdaterVersion)
    || typeof value.releaseDate !== 'string' || !Number.isFinite(Date.parse(value.releaseDate))) throw new Error('Invalid release');
  if (manifest.url !== `releases/${value.version}/incremental-manifest.json` || !validHash(manifest.sha512)
    || !Number.isSafeInteger(manifest.size) || Number(manifest.size) < 1 || Number(manifest.size) > MAX_MANIFEST_BYTES
    || typeof manifest.keyId !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.keyId)
    || manifest.algorithm !== 'rsa-sha256' || typeof manifest.signature !== 'string' || !/^[A-Za-z0-9+/]{512}$/.test(manifest.signature)) throw new Error('Invalid signed manifest');
  if (installer.url !== `releases/${value.version}/Rufa-DSH-${value.version}-x64-Setup.exe` || !validHash(installer.sha512)
    || !Number.isSafeInteger(installer.size) || Number(installer.size) < 1) throw new Error('Invalid fallback installer');
  return value as unknown as IncrementalRelease;
}
export function verifyManifest(bytes: Buffer, release: IncrementalRelease, trust: UpdateTrust): IncrementalManifest {
  if (bytes.length !== release.manifest.size || bytes.length > MAX_MANIFEST_BYTES || release.manifest.keyId !== trust.keyId
    || createHash('sha512').update(bytes).digest('base64') !== release.manifest.sha512
    || !verify('RSA-SHA256', bytes, trust.publicKey, Buffer.from(release.manifest.signature, 'base64'))) throw new Error('Release signature mismatch');
  const value = object(JSON.parse(bytes.toString('utf8')));
  if (value.schema !== 1 || value.version !== release.version || value.platform !== 'win32' || value.arch !== 'x64'
    || value.minUpdaterVersion !== release.minUpdaterVersion || value.releaseDate !== release.releaseDate
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 200_000) throw new Error('Invalid manifest');
  const paths = new Set<string>(); let size = 0;
  for (const item of value.files) {
    const file = object(item);
    if (!managedPath(file.path) || !Number.isSafeInteger(file.size) || Number(file.size) < 0 || !validHash(file.sha512)
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid manifest file');
    const key = file.path.toUpperCase(); if (paths.has(key)) throw new Error('Duplicate manifest file'); paths.add(key);
    size += Number(file.size); if (!Number.isSafeInteger(size)) throw new Error('Manifest too large');
  }
  for (const key of paths) { const parts = key.split('/'); parts.pop(); while (parts.length) { if (paths.has(parts.join('/'))) throw new Error('File directory collision'); parts.pop(); } }
  if (!paths.has('RUFAJX-DSH-APP.EXE') || !paths.has('RESOURCES/APP.ASAR')) throw new Error('Incomplete application manifest');
  return value as unknown as IncrementalManifest;
}
/** Check every existing ancestor, including the install root, before any file I/O.
 * Junctions are not an alternate update destination. */
export async function safeLocalPath(root: string, relative: string): Promise<string> {
  if (!managedPath(relative) && !/^\.rufa-update\/(?:download\/[a-f0-9]{64}(?:\.[a-f0-9]{32}\.part)?|pending(?:-manifest)?\.json(?:\.[a-f0-9]{32}\.writing)?|current(?:-manifest)?\.json)$/.test(relative)) throw new Error('Unsafe update path');
  const base = resolve(root), target = resolve(base, ...relative.split('/'));
  if (!target.startsWith(base + sep)) throw new Error('Unsafe update root');
  const segments = [base, ...relative.split('/').map((_, i, a) => join(base, ...a.slice(0, i + 1)))];
  for (let parent = dirname(base); ; parent = dirname(parent)) { segments.push(parent); if (parent === dirname(parent)) break; }
  for (const path of segments) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Update links are not allowed'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}
export async function matchesFile(path: string, file: ReleaseFile, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  let info; try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unexpected installed file');
  if (info.size !== file.size) return false;
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat(); if (before.ino !== info.ino || before.dev !== info.dev) throw new Error('File changed');
    const sha256 = createHash('sha256'), sha512 = createHash('sha512');
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) { sha256.update(chunk); sha512.update(chunk); }
    const after = await handle.stat(); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('File changed');
    return sha256.digest('hex') === file.sha256 && sha512.digest('base64') === file.sha512;
  } finally { await handle.close(); }
}
export function bootstrapSupports(release: IncrementalRelease): boolean { return !isNewerStableVersion(release.minUpdaterVersion, BOOTSTRAP_VERSION); }
export function updateUrl(relative: string): string {
  if (relative !== 'incremental/latest.json' && !/^releases\/(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\/(?:incremental-manifest\.json|payloads\/[a-f0-9]{64})$/.test(relative)) throw new Error('Unexpected update endpoint');
  return COMPANY_UPDATE_FEED + relative;
}
