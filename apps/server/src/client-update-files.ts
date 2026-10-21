import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './types.js';

export const updatePrefix = '/api/v1/client-updates/windows/x64';
export const missingRelease = () => new AppError(404, 'CLIENT_RELEASE_NOT_FOUND', '暂无可用的客户端版本');
export const unavailableRelease = () => new AppError(503, 'CLIENT_RELEASE_UNAVAILABLE', '客户端版本暂时不可用');
export const busyRelease = () => new AppError(503, 'CLIENT_RELEASE_BUSY', '更新服务繁忙，请稍后重试');
const numeric = '(?:0|[1-9][0-9]{0,8})';
const stableVersion = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}$`);
export const isReleaseVersion = (value: unknown): value is string => typeof value === 'string' && stableVersion.test(value);
export const releaseObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const sha256Digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function sha512Digest(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value;
}
export const fileIdentity = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
export const releaseEtag = (hash: string) => `"sha512-${Buffer.from(hash, 'base64').toString('hex')}"`;
export const matchesEtag = (header: string | undefined, etag: string) => header?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag) ?? false;
export function validReleaseDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');
}
export interface LegacyManifest {
  version: string; releaseDate: string; files: [{ url: string; sha512: string; size: number }]; path: string; sha512: string;
}
export function parseLegacyManifest(raw: unknown, version: string) {
  if (!releaseObject(raw) || raw.version !== version || !validReleaseDate(raw.releaseDate)
    || !Array.isArray(raw.files) || raw.files.length !== 1 || !releaseObject(raw.files[0])) throw unavailableRelease();
  const file = raw.files[0], filename = `Rufa-DSH-${version}-x64-Setup.exe`, url = `releases/${version}/${filename}`;
  const size = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
  if (file.url !== url || !sha512Digest(file.sha512) || !size(file.size) || raw.path !== url || raw.sha512 !== file.sha512) throw unavailableRelease();
  const manifest: LegacyManifest = { version, releaseDate: raw.releaseDate, files: [{ url, sha512: file.sha512, size: file.size }], path: url, sha512: file.sha512 };
  const declarations = [{ filename, size: file.size, sha512: file.sha512 }];
  if (raw.blockmap !== undefined) {
    if (!releaseObject(raw.blockmap) || !size(raw.blockmap.size) || !sha512Digest(raw.blockmap.sha512)) throw unavailableRelease();
    declarations.push({ filename: `${filename}.blockmap`, size: raw.blockmap.size, sha512: raw.blockmap.sha512 });
  }
  return { manifest, declarations };
}

/** Only deployment-owned paths composed by the server, never caller file paths. */
export class ReleaseFiles {
  private readonly root: string;
  constructor(directory: string) { this.root = resolve(directory); }
  protected async checkPath(parts: string[], directory = false): Promise<{ path: string; stat: BigIntStats }> {
    const target = resolve(this.root, ...parts);
    if (!inside(this.root, target)) throw unavailableRelease();
    const volume = parse(target).root, components = relative(volume, target).split(sep).filter(Boolean);
    let path = volume, stat = await lstat(volume, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unavailableRelease();
    for (const [index, component] of components.entries()) {
      path = join(path, component); stat = await lstat(path, { bigint: true });
      const folder = index < components.length - 1 || directory;
      if (stat.isSymbolicLink() || (folder ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) throw unavailableRelease();
    }
    if (!samePath(await realpath(target), target)) throw unavailableRelease();
    return { path: target, stat };
  }
  protected async checkedOpen(parts: string[]): Promise<{ handle: FileHandle; stat: BigIntStats }> {
    const checked = await this.checkPath(parts), handle = await open(checked.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat({ bigint: true }), after = await this.checkPath(parts);
      if (!stat.isFile() || stat.nlink !== 1n || fileIdentity(stat) !== fileIdentity(checked.stat) || fileIdentity(stat) !== fileIdentity(after.stat)) throw unavailableRelease();
      return { handle, stat };
    } catch (error) { await handle.close(); throw error; }
  }
  protected async boundedBytes(parts: string[], maxBytes: number): Promise<{ bytes: Buffer; fingerprint: string; stat: BigIntStats }> {
    const { handle, stat } = await this.checkedOpen(parts);
    try {
      if (stat.size < 0n || stat.size > BigInt(maxBytes)) throw unavailableRelease();
      // One extra byte detects extension after stat, without an unbounded readFile.
      const data = Buffer.alloc(Number(stat.size) + 1); let length = 0;
      while (length < data.length) {
        const { bytesRead } = await handle.read(data, length, data.length - length, length);
        if (!bytesRead) break; length += bytesRead;
      }
      if (BigInt(length) !== stat.size || fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(stat)) throw unavailableRelease();
      return { bytes: data.subarray(0, length), fingerprint: fileIdentity(stat), stat };
    } finally { await handle.close(); }
  }
  protected async smallJson(parts: string[]): Promise<{ value: unknown; fingerprint: string }> {
    const read = await this.boundedBytes(parts, 16384);
    if (read.bytes.length < 2) throw unavailableRelease();
    return { value: JSON.parse(read.bytes.toString('utf8')), fingerprint: read.fingerprint };
  }
}

/** A single capacity pool for both legacy and incremental distribution. */
export class UpdateCapacity {
  private hashing = 0;
  private downloading = 0;
  hash() {
    if (this.hashing >= 2) throw busyRelease(); this.hashing++;
    let done = false; return () => { if (!done) { done = true; this.hashing--; } };
  }
  download() {
    if (this.downloading >= 8) throw busyRelease(); this.downloading++;
    let done = false; return () => { if (!done) { done = true; this.downloading--; } };
  }
}

/** Exactly one range. Empty objects have no satisfiable byte range. */
export function clientDownloadRange(header: string, length: number): { start: number; end: number } | undefined {
  if (length === 0 || header.length > 128) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  const total = BigInt(length);
  if (!match[1]) {
    const suffix = BigInt(match[2]); if (suffix === 0n) return undefined;
    return { start: Number(suffix >= total ? 0n : total - suffix), end: length - 1 };
  }
  const start = BigInt(match[1]), end = match[2] ? BigInt(match[2]) : total - 1n;
  if (start >= total || end < start) return undefined;
  return { start: Number(start), end: Number(end >= total ? total - 1n : end) };
}
function permitRange(header: string | string[] | undefined, etag: string, modified: string) {
  return header === undefined || header === etag || (typeof header === 'string' && !header.startsWith('W/') && !header.startsWith('"') && Number.isFinite(Date.parse(header)) && Date.parse(header) >= Date.parse(modified));
}

export interface DownloadArtifact { filename: string; size: number; sha512: string; modified: string; fingerprint: string }
export async function sendUpdateArtifact(request: FastifyRequest, reply: FastifyReply, artifact: DownloadArtifact,
  openFile: () => Promise<FileHandle>, capacity: UpdateCapacity, contentType = 'application/octet-stream') {
  const etag = releaseEtag(artifact.sha512);
  if (matchesEtag(request.headers['if-none-match'], etag)) return reply.header('ETag', etag).code(304).send();
  let bounds = { start: 0, end: artifact.size - 1 };
  if (request.headers.range && permitRange(request.headers['if-range'], etag, artifact.modified)) {
    const requested = clientDownloadRange(request.headers.range, artifact.size);
    if (!requested) return reply.code(416).header('Content-Range', `bytes */${artifact.size}`).header('Content-Length', '0').send();
    bounds = requested;
  }
  const release = request.method === 'HEAD' ? undefined : capacity.download();
  reply.type(contentType).header('Accept-Ranges', 'bytes').header('ETag', etag)
    .header('Last-Modified', artifact.modified).header('Content-Disposition', `attachment; filename="${artifact.filename}"`);
  if (bounds.start !== 0 || bounds.end !== artifact.size - 1 || request.headers.range && permitRange(request.headers['if-range'], etag, artifact.modified)) {
    reply.code(206).header('Content-Range', `bytes ${bounds.start}-${bounds.end}/${artifact.size}`);
  }
  reply.header('Content-Length', artifact.size === 0 ? 0 : bounds.end - bounds.start + 1);
  if (request.method === 'HEAD') return reply.send();
  let handle: FileHandle;
  try { handle = await openFile(); }
  catch (error) {
    release!();
    for (const header of ['Content-Length', 'Content-Range', 'Content-Type', 'Content-Disposition', 'ETag', 'Last-Modified', 'Accept-Ranges']) reply.removeHeader(header);
    throw error;
  }
  if (artifact.size === 0) { try { await handle.close(); } finally { release!(); } return reply.send(Buffer.alloc(0)); }
  const stream = handle.createReadStream({ ...bounds, autoClose: true, highWaterMark: 256 * 1024 });
  const abort = () => stream.destroy(); reply.raw.once('close', abort);
  stream.once('close', () => { release!(); reply.raw.removeListener('close', abort); });
  if (reply.raw.destroyed || request.raw.aborted) stream.destroy();
  return reply.send(stream);
}
