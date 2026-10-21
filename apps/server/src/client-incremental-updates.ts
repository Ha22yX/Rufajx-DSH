import { constants, createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { AppError } from './types.js';
import { ReleaseFiles, UpdateCapacity, fileIdentity, isReleaseVersion, matchesEtag, missingRelease, parseLegacyManifest, releaseObject, sendUpdateArtifact, sha256Digest, sha512Digest, unavailableRelease, updatePrefix, type DownloadArtifact } from './client-update-files.js';

export const INCREMENTAL_MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
export const INCREMENTAL_MAX_FILES = 200_000;
const missing = missingRelease, unavailable = unavailableRelease;
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validSize = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const versionCompare = (a: string, b: string) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};
interface Payload { size: number; sha256: string; sha512: string }
interface Descriptor { url: string; size: number; sha512: string; algorithm: 'rsa-sha256'; keyId: string; signature: string }
interface IncrementalRelease {
  version: string; body: string; cacheKey: string; descriptor: Descriptor; manifest: DownloadArtifact; payloads: Map<string, Payload>;
}
export interface IncrementalArtifact extends DownloadArtifact { sha256: string }

/** Manifest paths name Windows package files only; no commands or URLs. */
export function validIncrementalPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || /[\uD800-\uDFFF]/u.test(value)
    || /[\\\x00-\x1f\x7f<>:"|?*]/u.test(value)) return false;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.length > 255 || /[. ]$/.test(part)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)(?:\.|$)/i.test(part))) return false;
  const root = parts[0].toUpperCase();
  return root !== 'RUFAJX-DSH.EXE' && root !== 'RUFAJX-DSH.EXE.CONFIG' && root !== '.RUFA-UPDATE' && !/^UNINSTALL.*\.EXE$/.test(root);
}

export function parseIncrementalManifest(raw: unknown, version: string, releaseDate: string): { minUpdaterVersion: string; payloads: Map<string, Payload> } {
  if (!releaseObject(raw) || !exact(raw, ['schema', 'version', 'platform', 'arch', 'releaseDate', 'minUpdaterVersion', 'files'])
    || raw.schema !== 1 || raw.version !== version || raw.platform !== 'win32' || raw.arch !== 'x64' || raw.releaseDate !== releaseDate
    || !isReleaseVersion(raw.minUpdaterVersion) || versionCompare(raw.minUpdaterVersion, '0.3.0') < 0 || versionCompare(raw.minUpdaterVersion, version) > 0
    || !Array.isArray(raw.files) || raw.files.length < 1 || raw.files.length > INCREMENTAL_MAX_FILES) throw unavailable();
  const payloads = new Map<string, Payload>(), files = new Set<string>(), directories = new Set<string>(); let total = 0;
  for (const entry of raw.files) {
    if (!releaseObject(entry) || !exact(entry, ['path', 'size', 'sha256', 'sha512']) || !validIncrementalPath(entry.path)
      || !validSize(entry.size) || !sha256Digest(entry.sha256) || !sha512Digest(entry.sha512)) throw unavailable();
    // Conservative Windows case folding also rejects file/directory ancestors,
    // independently of the ordering of records in a signed manifest.
    const name = entry.path.toUpperCase();
    if (files.has(name) || directories.has(name)) throw unavailable();
    const parts = name.split('/'); let parent = '';
    for (const part of parts.slice(0, -1)) { parent = parent ? `${parent}/${part}` : part; if (files.has(parent)) throw unavailable(); directories.add(parent); }
    files.add(name); total += entry.size; if (!Number.isSafeInteger(total)) throw unavailable();
    const prior = payloads.get(entry.sha256);
    if (prior && (prior.size !== entry.size || prior.sha512 !== entry.sha512)) throw unavailable();
    payloads.set(entry.sha256, { size: entry.size, sha256: entry.sha256, sha512: entry.sha512 });
  }
  if (!files.has('RUFAJX-DSH-APP.EXE') || !files.has('RESOURCES/APP.ASAR')) throw unavailable();
  return { minUpdaterVersion: raw.minUpdaterVersion, payloads };
}

function descriptor(raw: unknown, version: string): Descriptor {
  if (!releaseObject(raw) || !exact(raw, ['url', 'size', 'sha512', 'algorithm', 'keyId', 'signature'])
    || raw.url !== `releases/${version}/incremental-manifest.json` || !validSize(raw.size) || raw.size < 2 || raw.size > INCREMENTAL_MANIFEST_MAX_BYTES
    || !sha512Digest(raw.sha512) || raw.algorithm !== 'rsa-sha256' || !sha256Digest(raw.keyId)
    || typeof raw.signature !== 'string' || !/^[A-Za-z0-9+/]{512}$/.test(raw.signature)
    || Buffer.from(raw.signature, 'base64').toString('base64') !== raw.signature) throw unavailable();
  return { url: raw.url, size: raw.size, sha512: raw.sha512, algorithm: raw.algorithm, keyId: raw.keyId, signature: raw.signature };
}
class PublicKeyFile extends ReleaseFiles {
  private readonly filename: string;
  private cached?: { fingerprint: string; key: KeyObject; keyId: string };
  constructor(file: string) { const path = resolve(file); super(dirname(path)); this.filename = basename(path); }
  async read() {
    const raw = await this.boundedBytes([this.filename], 8192);
    if (this.cached?.fingerprint === raw.fingerprint) return this.cached;
    const pem = new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes);
    // createPublicKey can also derive a key from a private PEM; refuse that input.
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(pem)) throw unavailable();
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 3072) throw unavailable();
    const keyId = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
    return this.cached = { fingerprint: raw.fingerprint, key, keyId };
  }
}

/** Signed full target inventories plus version-scoped, raw content-addressed files. */
export class ClientIncrementalRepository extends ReleaseFiles {
  private readonly releases = new Map<string, IncrementalRelease>();
  private readonly pending = new Map<string, Promise<IncrementalRelease>>();
  private readonly objects = new Map<string, IncrementalArtifact>();
  private readonly objectPending = new Map<string, Promise<IncrementalArtifact>>();
  private readonly publicKey?: PublicKeyFile;
  constructor(directory: string, private readonly capacity = new UpdateCapacity(), publicKeyFile?: string) {
    super(directory); if (publicKeyFile) this.publicKey = new PublicKeyFile(publicKeyFile);
  }
  async latest() {
    let pointer;
    try { pointer = await this.smallJson(['current.json']); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw missing(); throw unavailable(); }
    if (!releaseObject(pointer.value) || !exact(pointer.value, ['version']) || !isReleaseVersion(pointer.value.version)) throw unavailable();
    return this.release(pointer.value.version, true);
  }
  async release(version: string, current = false): Promise<IncrementalRelease> {
    if (!isReleaseVersion(version)) throw missing();
    try {
      const metadata = await this.smallJson(['releases', version, 'manifest.json']).catch(error => {
        if (!current && (error as NodeJS.ErrnoException).code === 'ENOENT') throw missing(); throw error;
      });
      const { manifest: legacy } = parseLegacyManifest(metadata.value, version);
      const raw = metadata.value as Record<string, unknown>; if (raw.incremental === undefined) throw missing();
      const declared = descriptor(raw.incremental, version);
      if (!this.publicKey) throw unavailable(); const trust = await this.publicKey.read();
      if (trust.keyId !== declared.keyId) throw unavailable();
      const parts = ['releases', version, 'incremental-manifest.json'], { stat } = await this.checkPath(parts);
      if (stat.size !== BigInt(declared.size)) throw unavailable();
      const fingerprint = fileIdentity(stat), key = JSON.stringify([metadata.fingerprint, fingerprint, trust.fingerprint, trust.keyId]);
      const cached = this.releases.get(version); if (cached?.cacheKey === key) return cached;
      const pendingKey = `${version}:${key}`, pending = this.pending.get(pendingKey); if (pending) return await pending;
      const releaseHash = this.capacity.hash();
      const validation = (async () => {
        const input = await this.boundedBytes(parts, INCREMENTAL_MANIFEST_MAX_BYTES);
        if (input.fingerprint !== fingerprint || input.bytes.length !== declared.size || createHash('sha512').update(input.bytes).digest('base64') !== declared.sha512
          || !verify('sha256', input.bytes, { key: trust.key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(declared.signature, 'base64'))) throw unavailable();
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes));
        const { minUpdaterVersion, payloads } = parseIncrementalManifest(parsed, version, legacy.releaseDate);
        if ((await this.smallJson(['releases', version, 'manifest.json'])).fingerprint !== metadata.fingerprint) throw unavailable();
        const body = JSON.stringify({ schema: 1, version, releaseDate: legacy.releaseDate, minUpdaterVersion, manifest: declared, installer: legacy.files[0] }) + '\n';
        const result = { version, body, cacheKey: key, descriptor: declared, payloads,
          manifest: { filename: 'incremental-manifest.json', size: declared.size, sha512: declared.sha512, fingerprint, modified: new Date(Number(stat.mtimeMs)).toUTCString() } };
        this.releases.delete(version); this.releases.set(version, result);
        while (this.releases.size > 2) this.releases.delete(this.releases.keys().next().value!);
        return result;
      })();
      this.pending.set(pendingKey, validation);
      try { return await validation; } finally { releaseHash(); this.pending.delete(pendingKey); }
    } catch (error) {
      this.releases.delete(version); if (error instanceof AppError) throw error; throw unavailable();
    }
  }
  private objectParts(hash: string) { return ['objects', 'sha256', hash.slice(0, 2), hash]; }
  async payload(release: IncrementalRelease, hash: string): Promise<IncrementalArtifact> {
    if (!sha256Digest(hash)) throw missing();
    const declared = release.payloads.get(hash); if (!declared) throw missing();
    try {
      const parts = this.objectParts(hash), { stat } = await this.checkPath(parts);
      if (stat.size !== BigInt(declared.size)) throw unavailable();
      const fingerprint = fileIdentity(stat), cached = this.objects.get(hash);
      if (cached?.fingerprint === fingerprint && cached.size === declared.size && cached.sha512 === declared.sha512) return cached;
      const key = JSON.stringify([hash, fingerprint, declared]); const pending = this.objectPending.get(key); if (pending) return await pending;
      const releaseHash = this.capacity.hash();
      const validation = (async () => {
        const { handle, stat } = await this.checkedOpen(parts);
        try {
          if (fileIdentity(stat) !== fingerprint) throw unavailable();
          const sha256 = createHash('sha256'), sha512 = createHash('sha512'); let bytes = 0;
          const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(declared.size, 1024 * 1024)));
          while (bytes < declared.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, declared.size - bytes), bytes);
            if (!bytesRead) break; sha256.update(buffer.subarray(0, bytesRead)); sha512.update(buffer.subarray(0, bytesRead)); bytes += bytesRead;
          }
          if (bytes !== declared.size || sha256.digest('hex') !== hash || sha512.digest('base64') !== declared.sha512 || fileIdentity(await handle.stat({ bigint: true })) !== fingerprint) throw unavailable();
        } finally { await handle.close(); }
        const artifact = { ...declared, filename: hash, fingerprint, modified: new Date(Number(stat.mtimeMs)).toUTCString() };
        this.objects.delete(hash); this.objects.set(hash, artifact);
        while (this.objects.size > 1024) this.objects.delete(this.objects.keys().next().value!);
        return artifact;
      })();
      this.objectPending.set(key, validation);
      try { return await validation; } finally { releaseHash(); this.objectPending.delete(key); }
    } catch (error) { this.objects.delete(hash); if (error instanceof AppError) throw error; throw unavailable(); }
  }
  async openManifest(release: IncrementalRelease): Promise<FileHandle> {
    try {
      const { handle, stat } = await this.checkedOpen(['releases', release.version, 'incremental-manifest.json']);
      if (fileIdentity(stat) === release.manifest.fingerprint) return handle; await handle.close();
    } catch { /* No deployment paths in public errors. */ }
    this.releases.delete(release.version); throw unavailable();
  }
  async openPayload(artifact: IncrementalArtifact): Promise<FileHandle> {
    try {
      const { handle, stat } = await this.checkedOpen(this.objectParts(artifact.sha256));
      if (fileIdentity(stat) === artifact.fingerprint) return handle; await handle.close();
    } catch { /* No deployment paths in public errors. */ }
    this.objects.delete(artifact.sha256); throw unavailable();
  }
}

export function registerIncrementalUpdates(app: FastifyInstance, directory: string, capacity: UpdateCapacity, publicKeyFile?: string) {
  const repository = new ClientIncrementalRepository(directory, capacity, publicKeyFile);
  app.route({ method: ['GET', 'HEAD'], url: `${updatePrefix}/incremental/latest.json`, async handler(request, reply) {
    const release = await repository.latest(), etag = `"${createHash('sha256').update(release.body).digest('hex')}"`;
    reply.type('application/json; charset=utf-8').header('ETag', etag);
    if (matchesEtag(request.headers['if-none-match'], etag)) return reply.code(304).send();
    reply.header('Content-Length', Buffer.byteLength(release.body));
    return request.method === 'HEAD' ? reply.send() : reply.send(release.body);
  } });
  app.route({ method: ['GET', 'HEAD'], url: `${updatePrefix}/releases/:version/incremental-manifest.json`, async handler(request, reply) {
    const { version } = request.params as { version: string }, release = await repository.release(version);
    return sendUpdateArtifact(request, reply, release.manifest, () => repository.openManifest(release), capacity, 'application/json; charset=utf-8');
  } });
  app.route({ method: ['GET', 'HEAD'], url: `${updatePrefix}/releases/:version/payloads/:sha256`, async handler(request, reply) {
    const { version, sha256 } = request.params as { version: string; sha256: string };
    if (!sha256Digest(sha256)) throw missing();
    const release = await repository.release(version), artifact = await repository.payload(release, sha256);
    return sendUpdateArtifact(request, reply, artifact, () => repository.openPayload(artifact), capacity);
  } });
}
