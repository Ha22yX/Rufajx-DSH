import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './types.js';
import { ReleaseFiles, UpdateCapacity, parseLegacyManifest, isReleaseVersion, fileIdentity, matchesEtag as matches, releaseObject, updatePrefix, missingRelease, unavailableRelease, sendUpdateArtifact } from './client-update-files.js';
import { registerIncrementalUpdates } from './client-incremental-updates.js';

const prefix = updatePrefix;
const missing = missingRelease, unavailable = unavailableRelease;
const object = releaseObject, identity = fileIdentity;
const installerName = (value: unknown, version: string): boolean => value === `Rufa-DSH-${version}-x64-Setup.exe`;
export { isReleaseVersion, clientDownloadRange } from './client-update-files.js';
interface Artifact { filename: string; size: number; sha512: string; fingerprint: string; modified: string }
interface Release { version: string; body: string; manifestFingerprint: string; artifacts: Artifact[] }

/** Read-only, deployment-owned directory. No caller-supplied paths are opened. */
export class ClientReleaseRepository extends ReleaseFiles {
  private readonly cache = new Map<string, Release>();
  private readonly pending = new Map<string, Promise<Release>>();
  constructor(directory: string, private readonly capacity = new UpdateCapacity()) { super(directory); }

  async latest(): Promise<Release> {
    let pointer;
    try { pointer = await this.smallJson(['current.json']); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw missing(); throw unavailable(); }
    if (!object(pointer.value) || Object.keys(pointer.value).length !== 1 || !isReleaseVersion(pointer.value.version)) throw unavailable();
    return this.release(pointer.value.version, true);
  }
  async release(version: string, current = false): Promise<Release> {
    if (!isReleaseVersion(version)) throw missing();
    try {
      const saved = await this.smallJson(['releases', version, 'manifest.json']).catch(error => {
        if (!current && (error as NodeJS.ErrnoException).code === 'ENOENT') throw missing();
        throw error;
      });
      const { manifest, declarations } = parseLegacyManifest(saved.value, version);
      const artifacts: Artifact[] = [];
      for (const file of declarations) {
        const { stat } = await this.checkPath(['releases', version, file.filename]);
        if (stat.size !== BigInt(file.size)) throw unavailable();
        artifacts.push({ ...file, fingerprint: identity(stat), modified: new Date(Number(stat.mtimeMs)).toUTCString() });
      }
      const body = JSON.stringify(manifest) + '\n';
      const cached = this.cache.get(version);
      if (cached?.body === body && cached.manifestFingerprint === saved.fingerprint
        && JSON.stringify(cached.artifacts) === JSON.stringify(artifacts)) return cached;
      const key = JSON.stringify([version, saved.fingerprint, artifacts]);
      const existing = this.pending.get(key); if (existing) return await existing;
      const releaseHash = this.capacity.hash();
      const validation = (async () => {
        for (const file of artifacts) {
          const { handle, stat } = await this.checkedOpen(['releases', version, file.filename]);
          try {
            if (identity(stat) !== file.fingerprint) throw unavailable();
            const hash = createHash('sha512'); let bytes = 0;
            // Bounded streaming: multi-gigabyte installers are never buffered.
            const buffer = Buffer.allocUnsafe(Math.min(file.size, 1024 * 1024));
            while (bytes < file.size) {
              const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.size - bytes), bytes);
              if (!bytesRead) break;
              hash.update(buffer.subarray(0, bytesRead)); bytes += bytesRead;
            }
            if (bytes !== file.size || hash.digest('base64') !== file.sha512 || identity(await handle.stat({ bigint: true })) !== file.fingerprint) throw unavailable();
          } finally { await handle.close(); }
        }
        if ((await this.smallJson(['releases', version, 'manifest.json'])).fingerprint !== saved.fingerprint) throw unavailable();
        const release = { version, body, manifestFingerprint: saved.fingerprint, artifacts };
        this.cache.delete(version); this.cache.set(version, release);
        while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
        return release;
      })();
      this.pending.set(key, validation);
      try { return await validation; }
      finally { releaseHash(); this.pending.delete(key); }
    } catch (error) {
      this.cache.delete(version);
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
  }
  async openArtifact(release: Release, artifact: Artifact): Promise<FileHandle> {
    try {
      const { handle, stat } = await this.checkedOpen(['releases', release.version, artifact.filename]);
      if (identity(stat) === artifact.fingerprint) return handle;
      await handle.close();
    } catch { /* All filesystem errors stay private. */ }
    this.cache.delete(release.version); throw unavailable();
  }
}

/** A separate route scope keeps update caching/concurrency out of auth and LLM routes. */
export function registerClientUpdates(app: FastifyInstance, directory: string, publicKeyFile?: string): void {
  const capacity = new UpdateCapacity(), repository = new ClientReleaseRepository(directory, capacity);
  app.register(async scoped => {
    scoped.addHook('onSend', async (request, reply) => {
      reply.header('Cache-Control', reply.statusCode >= 400 ? 'no-store'
        : (request.routeOptions.url === `${prefix}/latest.yml` || request.routeOptions.url === `${prefix}/incremental/latest.json`) ? 'no-store, max-age=0, must-revalidate' : 'public, max-age=31536000, immutable');
      if (reply.statusCode === 503) reply.header('Retry-After', '5');
    });
    scoped.route({ method: ['GET', 'HEAD'], url: `${prefix}/latest.yml`, async handler(request, reply) {
      const release = await repository.latest();
      const etag = `"${createHash('sha256').update(release.body).digest('hex')}"`;
      reply.type('application/yaml; charset=utf-8').header('ETag', etag);
      if (matches(request.headers['if-none-match'], etag)) return reply.code(304).send();
      reply.header('Content-Length', Buffer.byteLength(release.body));
      return request.method === 'HEAD' ? reply.send() : reply.send(release.body);
    } });
    scoped.route({ method: ['GET', 'HEAD'], url: `${prefix}/releases/:version/:filename`, async handler(request: FastifyRequest, reply: FastifyReply) {
      const { version, filename } = request.params as { version: string; filename: string };
      if (!isReleaseVersion(version) || !(installerName(filename, version) || filename.endsWith('.blockmap') && installerName(filename.slice(0, -9), version))) throw missing();
      const release = await repository.release(version);
      const artifact = release.artifacts.find(file => file.filename === filename); if (!artifact) throw missing();
      return sendUpdateArtifact(request, reply, artifact, () => repository.openArtifact(release, artifact), capacity);
    } });
    registerIncrementalUpdates(scoped, directory, capacity, publicKeyFile);
  });
}
