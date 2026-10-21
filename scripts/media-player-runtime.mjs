// Build-time asset preparation; playback is fully local and decodes original bytes.
import { readFile, writeFile, mkdir, rename, unlink, realpath, rmdir } from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
const project = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function atomic(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.pending`;
  try { await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, file); }
  finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
async function checked(file, item) {
  const bytes = await readFile(file);
  if (bytes.length !== item.bytes || digest(bytes) !== item.sha256) throw new Error(`Media player asset checksum mismatch: ${item.file}`);
  return bytes;
}
export async function prepareMediaPlayerRuntime(runtimeInput, { download = false } = {}) {
  const runtime = resolve(runtimeInput);
  const lockBytes = await readFile(join(project, 'preinstalled/media-preview/player.lock.json'));
  const lock = JSON.parse(lockBytes);
  if (lock.schema !== 1 || lock.version !== '1.3.1' || lock.sourceRevision !== '152f629d3021fd8013efa464fcb7b55f9fbe7753')
    throw new Error('Unsupported media player lock');
  const names = new Set();
  for (const item of lock.files) {
    if (!/^(?:[\w.-]+\.js(?:\.LICENSE\.txt)?|COPYING\.(?:L?GPLv3)|wasm\/(?:decode|resample|stretchpitch|scale)\/[a-z0-9]+-simd\.wasm)$/.test(item.file) || names.has(item.file) || !/^[a-f0-9]{64}$/.test(item.sha256))
      throw new Error('Invalid player asset lock');
    names.add(item.file);
  }
  const target = join(runtime, 'company-tools/media-player');
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < lock.files.length) {
      const item = lock.files[next++], dest = join(target, item.file);
      try { await checked(dest, item); continue; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!process.env.LOCALAPPDATA) throw new Error('Media player build cache requires LOCALAPPDATA');
      const cached = join(process.env.LOCALAPPDATA, 'RufaDSH/build-cache/media-player', lock.version, item.file);
      let bytes;
      try { bytes = await checked(cached, item); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (!download) throw new Error('Prepare the offline media player on the build machine first');
        const url = new URL(item.url);
        if (url.protocol !== 'https:' || !['unpkg.com', 'raw.githubusercontent.com'].includes(url.hostname)) throw new Error('Untrusted player asset source');
        const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error(`Player asset download failed (${response.status})`);
        bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length !== item.bytes || digest(bytes) !== item.sha256) throw new Error('Player download checksum mismatch');
        await atomic(cached, bytes);
      }
      await atomic(dest, bytes);
    }
  }));
  await atomic(join(target, 'PLAYER-LOCK.json'), lockBytes);
  await atomic(join(target, 'NOTICE.txt'), `libmedia AVPlayer ${lock.version}\nCopyright (c) libmedia contributors.\nLicense: LGPL-3.0-or-later; see COPYING.LGPLv3 and COPYING.GPLv3.\nExact source and build instructions: ${lock.source}\nUnmodified UMD JavaScript and decode/resample/stretchpitch/scale WASM are distributed as separate replaceable files. No encoders or transcoder are included.\nApplication integration: scripts/media-preview-compat.mjs and apps/client/scripts/media-preview-client.mjs.\n`);
  return { version: lock.version, files: lock.files.length, bytes: lock.files.reduce((n, f) => n + f.bytes, 0), lockSha256: digest(lockBytes) };
}

// Remove only byte-identical components shipped by our superseded converter.
// No recursive deletion, account cache, user media or unrelated FFmpeg is touched.
export async function retireLegacyMediaConverter(runtimeInput) {
  const root = await realpath(resolve(runtimeInput));
  const legacy = {
    'company-tools/ffmpeg/CODEC-LOCK.json': 'cb9f25b7f9a17a0e31850e5eedbb01d9135ec99dee3fdcc689b1a609f6129955',
    'company-tools/ffmpeg/ffmpeg.exe': '2ce797a0f88d7f067180338fb227f7b1928ea727bd9a4d7a1d022f7c52af71a3',
    'company-tools/ffmpeg/LICENSE-FFmpeg-GPLv3.txt': '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
    'company-tools/ffmpeg/LICENSE-imageio-ffmpeg.txt': 'eca73421d0c905a92e952a553d4d58919c5a507c2c2c76e3c0cf9ba408c299e4',
    'company-tools/ffmpeg/NOTICE.txt': '1c36699ce3f7a47ea87c822fdc648f30b992f1f99f4cf531cc2e4c9c9e4886c3',
    'company-tools/media-preview/codec.mjs': '7bb6167b513286948686e34f2b60dd1a599f742e0837dd138bdf77f44ff5f169',
  };
  const remove = [];
  for (const [name, sha] of Object.entries(legacy)) {
    const file = join(root, name);
    try {
      const actual = await realpath(file), rel = relative(root, actual);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || relative(file, actual) !== '') throw new Error('Legacy media cleanup leaves runtime');
      const bytes = await readFile(actual);
      if (digest(bytes) !== sha) throw new Error('Unrecognized legacy media component; retained for inspection');
      remove.push({ file, bytes: bytes.length });
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const item of remove) await unlink(item.file);
  for (const name of ['company-tools/ffmpeg', 'company-tools/media-preview'])
    await rmdir(join(root, name)).catch(e => { if (!['ENOENT', 'ENOTEMPTY'].includes(e.code)) throw e; });
  return { removedFiles: remove.length, removedBytes: remove.reduce((n, f) => n + f.bytes, 0) };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/media-player-runtime.mjs <runtime> [--prepare]');
  console.log(JSON.stringify(await prepareMediaPlayerRuntime(process.argv[2], { download: process.argv.includes('--prepare') })));
}
