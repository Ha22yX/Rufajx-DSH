// Adapt only the pinned npm artifacts, after validating every input before writing.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createSidebarGuard } from './sidebar-compat.mjs';

const MARKER = '// RUFA MEDIA PREVIEW COMPATIBILITY v4';
const digest = value => createHash('sha256').update(value).digest('hex');
const playerFiles = JSON.parse(readFileSync(new URL('../preinstalled/media-preview/player.lock.json', import.meta.url), 'utf8')).files.map(item => item.file);

// Embedded verbatim in each host. It owns the file descriptor through stat and
// streaming; requests never use browser cwd or require a session write lease.
export function createMediaRuntime({ fs, path, AsyncLocalStorage, createGuard, environment }) {
  const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
  const guard = createGuard({ fs, path, AsyncLocalStorage, environment,
    forbidden: message => failure(403, 'forbidden', message) });
  const header = (req, key) => typeof req.headers[key] === 'string' ? req.headers[key] : undefined;
  const respond = (res, status, value, method) => {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(method === 'HEAD' ? undefined : body);
  };
  function rangeOf(raw, size) {
    if (raw === undefined) return null;
    const match = /^bytes=(\d*-\d*)(?:\s*,.*)?$/i.exec(raw.trim());
    if (!match || match[1] === '-') return null;
    const [left, right] = match[1].split('-');
    const start = left === '' ? undefined : Number(left);
    const last = right === '' ? undefined : Number(right);
    if ((start !== undefined && !Number.isSafeInteger(start)) || (last !== undefined && !Number.isSafeInteger(last))) return null;
    if (size === 0) return 'unsatisfiable';
    if (start === undefined) return last === 0 ? 'unsatisfiable' : { start: Math.max(0, size - last), end: size - 1 };
    if (start >= size || (last !== undefined && last < start)) return 'unsatisfiable';
    return { start, end: Math.min(last ?? size - 1, size - 1) };
  }
  return async function handle(req, res, ctx, config) {
    let file;
    try {
      const connection = ctx.connection ?? ctx.get?.('connection');
      if (typeof connection?.requestRejection !== 'function') throw failure(503, 'unavailable', '连接认证服务尚未就绪。');
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) throw failure(rejection === 401 ? 401 : 403, 'forbidden', '媒体访问未获授权。');
      const url = new URL(req.url ?? '/', 'http://dsh.internal');
      const pathname = url.pathname.replace(/\/+$/, '');
      const methods = ['GET', 'HEAD'];
      if (!methods.includes(req.method)) {
        res.writeHead(405, { allow: methods.join(', '), 'cache-control': 'no-store' }); res.end(); return;
      }
      const meta = config.kind === 'audio' && pathname === '/audio-preview/meta';
      const media = config.kind === 'audio' ? pathname === '/audio-preview/media'
        : pathname === '/video';
      if (!meta && !media) throw failure(404, 'not-found', '媒体路径不存在。');
      const sessionId = url.searchParams.get('sessionId'), raw = url.searchParams.get('path');
      if (!sessionId || !raw) throw failure(400, 'bad-request', 'sessionId and path are required');
      const cwd = await guard.sessionRoot(ctx, sessionId);
      const target = guard.target(cwd, config.resolvePath(raw, cwd));
      if (!config.accepts(target)) throw failure(403, 'unsupported-media', '此入口仅支持相应媒体文件。');
      const canonical = fs.realpathSync.native(target);
      guard.target(cwd, canonical);
      file = await fs.promises.open(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile()) throw failure(400, 'fs-error', '不是普通媒体文件。');
      // Detect replacement between resolution and open. Stream the checked
      // descriptor, never reopen the caller's lexical path after validation.
      const current = fs.realpathSync.native(target);
      guard.target(cwd, current);
      const currentInfo = await fs.promises.stat(current);
      if (path.relative(canonical, current) !== '' || info.dev !== currentInfo.dev || info.ino !== currentInfo.ino)
        throw failure(409, 'file-changed', '文件已变化，请重新打开预览。');
      if (config.kind === 'video' && info.size === 0) throw failure(400, 'fs-error', '视频文件为空。');
      const mime = config.contentType(target);
      if (meta) {
        respond(res, 200, { ok: true, value: { path: target, name: path.basename(target), size: info.size, mime } }, req.method);
        return;
      }
      const modified = new Date(Math.floor(info.mtimeMs / 1000) * 1000).toUTCString();
      const ifRange = header(req, 'if-range');
      // We publish Last-Modified, not an invented strong content ETag. Unknown
      // tags (including weak tags), invalid and stale dates get the full file.
      const rangeAllowed = ifRange === undefined || (!/^W\/|^"/.test(ifRange) && Date.parse(ifRange) === Date.parse(modified));
      const range = rangeAllowed ? rangeOf(header(req, 'range'), info.size) : null;
      const headers = { 'content-type': mime, 'accept-ranges': 'bytes', 'last-modified': modified,
        'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
      if (range === 'unsatisfiable') {
        res.writeHead(416, { ...headers, 'content-range': `bytes */${info.size}`, 'content-length': '0' }); res.end(); return;
      }
      const start = range?.start ?? 0, end = range?.end ?? info.size - 1;
      headers['content-length'] = String(range === null ? info.size : end - start + 1);
      if (range !== null) headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
      res.writeHead(range === null ? 200 : 206, headers);
      if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
      const stream = file.createReadStream({ start, end, autoClose: true });
      file = undefined; // Stream now owns the descriptor, including cancellation.
      const close = () => stream.destroy();
      res.once('close', close);
      stream.once('close', () => res.off('close', close));
      stream.once('error', () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error.status ?? (error.code === 'ENOENT' ? 404 : error.code === 'EACCES' ? 403 : 500);
      respond(res, status, { ok: false, error: { code: error.status ? error.code : 'fs-error',
        message: error.status ? error.message : '无法读取此会话中的媒体文件。' } }, req.method);
    } finally { await file?.close(); }
  };
}

// Public decoder code, never user media: still enforce native connection admission
// and serve only a build-verified asset allowlist under the immutable runtime.
export function createPlayerAssetRuntime({ fs, path, environment, files }) {
  const allowed = new Set(files);
  return async function handle(req, res, ctx) {
    let file;
    const reject = status => { res.writeHead(status, { 'cache-control': 'no-store', 'content-length': '0' }); res.end(); };
    try {
      const connection = ctx.connection ?? ctx.get?.('connection');
      if (typeof connection?.requestRejection !== 'function') return reject(503);
      const denied = connection.requestRejection(req);
      if (denied !== undefined) return reject(denied === 401 ? 401 : 403);
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('allow', 'GET, HEAD'); return reject(405); }
      const name = new URL(req.url, 'http://dsh.internal').pathname.slice('/rufa-media-player/'.length);
      if (!allowed.has(name)) return reject(404);
      if (!environment.RUFA_RUNTIME_ROOT) return reject(503);
      const root = fs.realpathSync.native(path.join(environment.RUFA_RUNTIME_ROOT, 'company-tools/media-player'));
      const target = path.join(root, name), canonical = fs.realpathSync.native(target), relative = path.relative(root, canonical);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return reject(403);
      file = await fs.promises.open(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const info = await file.stat(), current = await fs.promises.stat(target);
      if (!info.isFile() || info.dev !== current.dev || info.ino !== current.ino || fs.realpathSync.native(target) !== canonical) return reject(409);
      res.writeHead(200, { 'content-type': name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8',
        'content-length': String(info.size), 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = file.createReadStream({ autoClose: true }); file = undefined;
      const close = () => stream.destroy(); res.once('close', close);
      stream.once('close', () => res.off('close', close)); stream.once('error', () => res.destroy()); stream.pipe(res);
    } catch { if (res.headersSent) res.destroy(); else reject(404); }
    finally { await file?.close(); }
  };
}

function extension() {
  return `\n${MARKER}\nimport * as rufaMediaFs from 'node:fs';\nimport * as rufaMediaPath from 'node:path';\nimport { AsyncLocalStorage as RufaMediaStorage } from 'node:async_hooks';\nconst rufaMediaHandle = (${createMediaRuntime.toString()})({ fs: rufaMediaFs, path: rufaMediaPath, AsyncLocalStorage: RufaMediaStorage, createGuard: (${createSidebarGuard.toString()}), environment: process.env });\nconst rufaPlayerAssets = (${createPlayerAssetRuntime.toString()})({ fs: rufaMediaFs, path: rufaMediaPath, environment: process.env, files: ${JSON.stringify(playerFiles)} });\n// END RUFA MEDIA PREVIEW COMPATIBILITY\n`;
}

const videoApply = `export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/rufa-media-player',
    handler: (req, res) => rufaPlayerAssets(req, res, ctx),
  }), 'dsh-video-preview: offline player assets');
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/video',
    handler: (req, res) => rufaMediaHandle(req, res, ctx, {
      kind: 'video', resolvePath: (raw, cwd) => resolve(cwd, raw),
      accepts: file => Object.hasOwn(VIDEO_TYPES, extname(file).toLowerCase()),
      contentType: file => VIDEO_TYPES[extname(file).toLowerCase()],
    }),
  }), 'dsh-video-preview: company media route');
}
`;
const audioHandler = `async function handleAudioRequest(request, response, ctx) {
  return rufaMediaHandle(request, response, ctx, { kind: 'audio',
    resolvePath: resolveMediaPath, accepts: isAudioPath, contentType: contentTypeForAudio });
}
`;

const ARTIFACTS = [
  { package: 'dsh-video-preview', version: '0.1.4', file: 'index.js',
    sha: '6ce626e7266602e643d4c847875f11341121a81734e2446e5abed121cdad75b9', host: 'video', legacy: ['44f88ed8bdf2859ffed35145422379fa3a7a618953953ebf49ba1e2cf8538331', '53a22272aebb9361f4e90ba2b956e11d3bb6e79094e1d0e284d749a37f233702'] },
  { package: 'dsh-video-preview', version: '0.1.4', file: 'client.js',
    sha: '52d80a7df54138dd1ce7641bc28c06acf46b21339864e2c912e79ad57da5de35', client: 'video' },
  { package: 'dsh-video-preview', version: '0.1.4', file: 'package.json',
    sha: '0a1692e817a79ff60a2a3e804c9daba5c1f286a888d5c02692bd00195e725442', manifest: true },
  { package: '@huanlin/dsh-plugin-better-sidebar-plugin-audio', version: '0.1.0', file: 'lib/index.js',
    sha: 'b86bada09934a042df32c229b54bcb69eacaf0e100defe476c7597ab78a32686', host: 'audio', legacy: ['64939ec422131f5d4b9738b1008599c2dfbd117d123b0199f221b9fdcfadf79d', '0009bc2cfccc60a038a96eb12efcc15712df9c19a431396525ff5a0e6afce38f'] },
  { package: '@huanlin/dsh-plugin-better-sidebar-plugin-audio', version: '0.1.0', file: 'lib/client.js',
    sha: '54dedae6d28992c7dbed798ef972bbe3ab69b5b84a6dfe2311aaadcf883cf8af', client: 'audio' },
  { package: '@huanlin/dsh-plugin-better-sidebar-plugin-audio', version: '0.1.0', file: 'package.json',
    sha: '63aeb6317bc365f8bd31d9b42542563c45e9672d4ea6c7c355269293875c0699' },
];

function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Pinned media patch anchor changed');
  return source.replace(before, after);
}

// The original body is retained as a comment for reversible verification. A
// changed source, stale patch or edited extension fails closed on the next run.
function patchArtifact(source, artifact) {
  if (artifact.host) {
    const suffix = extension();
    const start = artifact.host === 'video' ? 'export function apply(ctx) {' : 'async function handleAudioRequest(request, response, ctx) {';
    const tail = artifact.host === 'video' ? null : '/**\n* Register the media routes on the host webserver.';
    const injectBefore = artifact.host === 'video' ? "export const inject = ['webServer', 'sessions', 'webRuntime']" : 'const inject = [\n\t"webServer",\n\t"sessions",\n\t"webRuntime"\n];';
    const injectAfter = artifact.host === 'video' ? "export const inject = ['webServer', 'sessions', 'connection', 'sessionQuery']" : 'const inject = [\n\t"webServer",\n\t"sessions",\n\t"connection",\n\t"sessionQuery"\n];';
    const body = artifact.host === 'video' ? videoApply : audioHandler;
    let original = source;
    const legacy = /\/\/ RUFA MEDIA PREVIEW COMPATIBILITY v[23]\b/.exec(source);
    if (source.includes(MARKER) || legacy) {
      if (legacy) {
        if (!artifact.legacy.includes(digest(source))) throw new Error('Legacy media compatibility differs from verified version');
        original = source.slice(0, legacy.index - 1);
      } else {
        if (!source.endsWith(suffix)) throw new Error('Media compatibility extension differs from expected version');
        original = source.slice(0, -suffix.length);
      }
      const saved = /\/\* RUFA ORIGINAL ROUTE ([A-Za-z0-9+/=]+) \*\//.exec(original);
      if (!saved) throw new Error('Missing original media route');
      const begin = original.indexOf(start);
      if (begin < 0 || begin >= saved.index || original[saved.index + saved[0].length] !== '\n') throw new Error('Invalid original media route placement');
      original = original.slice(0, begin) + Buffer.from(saved[1], 'base64').toString('utf8') + original.slice(saved.index + saved[0].length + 1);
      original = once(original, injectAfter, injectBefore);
    }
    if (digest(original) !== artifact.sha) throw new Error(`Unrecognized ${artifact.package} ${artifact.file}`);
    const at = original.indexOf(start), end = tail === null ? original.length : original.indexOf(tail, at);
    if (at < 0 || end < 0) throw new Error('Missing pinned media route');
    const previous = original.slice(at, end);
    const patched = once(original, previous, `${body}/* RUFA ORIGINAL ROUTE ${Buffer.from(previous).toString('base64')} */\n`);
    const result = once(patched, injectBefore, injectAfter) + suffix;
    if (source.includes(MARKER) && source !== result) throw new Error('Media compatibility body differs from expected version');
    return result;
  }
  if (artifact.manifest) {
    const before = '"@deepseek-ai/dsh-client-runtime"';
    // JSON remains ordinary JSON; the exact indentation comes from the pinned manifest.
    const old = '"inject": [\n        '+before+'\n      ]', next = '"inject": []';
    const original = source.includes(before) ? source : once(source, next, old);
    if (digest(original) !== artifact.sha) throw new Error('Unrecognized video package manifest');
    return once(original, old, next);
  }
  if (digest(source) !== artifact.sha) throw new Error(`Unrecognized ${artifact.package} ${artifact.file}`);
  return source;
}

export async function applyMediaPreviewCompatibility(runtimeInput) {
  const runtime = path.resolve(runtimeInput), updates = [];
  const { patchMediaPreviewClient, restoreMediaPreviewClient } = await import('../apps/client/scripts/media-preview-client.mjs');
  for (const spec of ARTIFACTS) {
    const file = path.join(runtime, 'node_modules', spec.package, spec.file);
    const source = await readFile(file, 'utf8');
    if (spec.file === 'package.json') {
      const manifest = JSON.parse(source);
      if (manifest.name !== spec.package || manifest.version !== spec.version) throw new Error('Unsupported media plugin version');
    }
    let patched;
    if (spec.client) {
      const original = restoreMediaPreviewClient(source, spec.client);
      if (digest(original) !== spec.sha) throw new Error(`Unrecognized ${spec.package} ${spec.file}`);
      patched = patchMediaPreviewClient(original, spec.client);
      // restoreMediaPreviewClient validates current or exact, previously shipped
      // legacy bytes before returning the pinned original source.
    } else patched = patchArtifact(source, spec);
    updates.push({ file, relative: `${spec.package}/${spec.file}`, source, patched });
  }
  for (const { file, source, patched } of updates) if (source !== patched) {
    const temp = `${file}.rufa-${randomUUID()}.tmp`;
    try { await writeFile(temp, patched, { flag: 'wx' }); await rename(temp, file); }
    finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { mediaPreviewCompatibility: 4, changed: updates.some(item => item.source !== item.patched),
    versions: { video: '0.1.4', audio: '0.1.0' },
    files: updates.map(item => ({ file: item.relative, sha256: digest(item.patched), changed: item.source !== item.patched })) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/media-preview-compat.mjs <materialized-runtime>');
  console.log(JSON.stringify(await applyMediaPreviewCompatibility(process.argv[2])));
}
