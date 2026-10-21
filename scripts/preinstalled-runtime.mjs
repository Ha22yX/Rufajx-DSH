import { readFile, writeFile, rename, unlink, access, mkdir, readdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { patchOcrMessageRendererSource, patchNativeUserMessageSource } from '../apps/client/scripts/user-message-runtime.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.pending`;
  try { await writeFile(temporary, value); await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function replaceOnce(source, from, to, label) {
  if (source.includes(to)) return source;
  if (source.split(from).length !== 2) throw new Error(`Pinned ${label} implementation changed`);
  return source.replace(from, to);
}

export function patchOcrHostSource(source) {
  source = replaceOnce(source, 'encoding: "utf8",\n\t\t\tenv: cleanEnvironment(),',
    'encoding: "utf8",\n\t\t\twindowsHide: true,\n\t\t\tenv: cleanEnvironment(),', 'OCR subprocess');
  return replaceOnce(source, 'resolve(JSON.parse(stdout));',
    'try {\n\t\t\t\tconst value = JSON.parse(stdout);\n\t\t\t\tif (typeof value?.kind !== "string" || typeof value.text !== "string") throw new Error("Invalid extraction response");\n\t\t\t\tresolve(value);\n\t\t\t} catch { reject(new Error("文件解析响应无效，请重试。")); }', 'OCR response');
}

export function patchOcrClientSource(source) {
  source = replaceOnce(source, `/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\tclassName: FileAttachments_module_css_default.attachButton,
\t\t\t\t\t\tdisabled: busy,
\t\t\t\t\t\t"aria-label": "添加文件 / Add file",
\t\t\t\t\t\t"aria-busy": busy,
\t\t\t\t\t\ttitle: error ?? "添加文件 / Add file",
\t\t\t\t\t\tonClick: () => {
\t\t\t\t\t\t\tpicker.current?.click();
\t\t\t\t\t\t},
\t\t\t\t\t\tchildren: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FileIcon, { size: 16 })
\t\t\t\t\t})`, 'null /* Rufajx: use the existing + file entry; keep OCR drop handlers mounted. */', 'OCR duplicate upload button');
  source = replaceOnce(source, '_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16,',
    '_deepseek_ai_dsh_client_ui_primitives.IconCloseOutlineRegular,', 'OCR close icon');
  source = replaceOnce(source, 'const onDrop = (event) => {\n\t\t\t\t\tif (!hasFiles(event)) return;',
    'const onDrop = (event) => {\n\t\t\t\t\treset();\n\t\t\t\t\tif (!hasFiles(event)) return;', 'OCR empty drop');
  source = replaceOnce(source, 'const onDragLeave = (event) => {\n\t\t\t\t\tif (!hasFiles(event)) return;',
    'const onDragLeave = (event) => {\n\t\t\t\t\tif (!hasFiles(event) && dragDepth.current === 0) return;', 'OCR external drag leave');
  source = replaceOnce(source, 'window.addEventListener("dragend", reset);',
    'window.addEventListener("dragend", reset);\n\t\t\t\tconst onEscape = event => { if (event.key === "Escape") reset(); };\n\t\t\t\twindow.addEventListener("blur", reset);\n\t\t\t\twindow.addEventListener("pagehide", reset);\n\t\t\t\tdocument.addEventListener("visibilitychange", reset);\n\t\t\t\tdocument.addEventListener("keydown", onEscape, true);\n\t\t\t\tdocument.addEventListener("pointerdown", reset, true);', 'OCR cancel listeners');
  source = replaceOnce(source, 'window.removeEventListener("dragend", reset);',
    'window.removeEventListener("dragend", reset);\n\t\t\t\t\twindow.removeEventListener("blur", reset);\n\t\t\t\t\twindow.removeEventListener("pagehide", reset);\n\t\t\t\t\tdocument.removeEventListener("visibilitychange", reset);\n\t\t\t\t\tdocument.removeEventListener("keydown", onEscape, true);\n\t\t\t\t\tdocument.removeEventListener("pointerdown", reset, true);', 'OCR cancel disposal');
  source = replaceOnce(source, 'const FILE_SOURCE = "file-attachment";', `const FILE_SOURCE = "file-attachment";
        // Native composer spans use one character per chip; its public draft
        // expands each chip to clipboard text. Keep edits in the native plane.
        function rufaOcrDetectOffset(snapshot, offset) {
          let result = offset;
          for (const item of snapshot.occurrences) if (item.offset < offset) result -= item.length - 1;
          const command = snapshot.claim?.token?.trimEnd();
          if (command && offset >= command.length && snapshot.draft.startsWith(command)) result -= command.length - 1;
          return result;
        }`, 'OCR composer coordinates');
  source = replaceOnce(source, 'start: snapshot.draft.length,\n\t\t\t\t\t\t\tend: snapshot.draft.length,',
    'start: rufaOcrDetectOffset(snapshot, snapshot.draft.length),\n\t\t\t\t\t\t\tend: rufaOcrDetectOffset(snapshot, snapshot.draft.length),', 'OCR multi-attachment insert');
  source = replaceOnce(source, 'const { input } = scopedInput(sessionId);\n\t\t\t\t\t\tconst snapshot = input.state.getSnapshot();',
    'const { actx, input } = scopedInput(sessionId);\n\t\t\t\t\t\tconst snapshot = input.state.getSnapshot();\n\t\t\t\t\t\tif (!["plain", "claimed"].includes(snapshot.phase)) return;', 'OCR reference removal scope');
  source = replaceOnce(source, 'if (occurrence !== void 0) input.setDraft(snapshot.draft.slice(0, occurrence.offset) + snapshot.draft.slice(occurrence.offset + 1));',
    `if (occurrence !== void 0) {
              const start = rufaOcrDetectOffset(snapshot, occurrence.offset);
              if (actx.bail(actx, "slash/input-insert-text", { text: "", span: { start, end: start + 1, draftRev: snapshot.draftRev } }) !== true) return;
            }`, 'OCR reference removal');
  source = replaceOnce(source, 'const projected = project(texts.join(""));',
    `const projected = project(texts.join(""));
            // Current Harness persists native files as separate attachment blocks.
            // Render their public metadata as cards instead of dumping protocol JSON.
            for (let index = rest.length - 1; index >= 0; index--) {
              const block = rest[index];
              if (block.type !== "file" || !block.attachment) continue;
              const name = block.attachment.name || "文件";
              const extension = name.split(".").at(-1).toLowerCase();
              const kind = ({ pdf: "pdf", docx: "word", doc: "word", xlsx: "excel", xls: "excel", pptx: "powerpoint", ppt: "powerpoint", txt: "text", csv: "text" })[extension] || "file";
              projected.files.unshift({ name, kind, size: block.attachment.bytes || 0 });
              rest.splice(index, 1);
            }`, 'OCR native file transcript');
  return source;
}

export function patchAttachmentExportsSource(source) {
  // The pinned upstream still contains these two existing, unchanged components,
  // but its newer entry stopped exporting them. Restore only these legacy names
  // in our materialized copy so the requested community UI keeps its full design.
  if (!source.includes('function DropOverlay(') || !source.includes('function ImageGallery(')) throw new Error('Pinned attachment components changed');
  return replaceOnce(source, 'exports.apply = apply;\n\t\texports.inject = inject;',
    'exports.apply = apply;\n\t\texports.inject = inject;\n\t\texports.DropOverlay = DropOverlay;\n\t\texports.ImageGallery = ImageGallery;', 'attachment exports');
}

export async function checkPreinstalledRuntime(runtimeInput, { syncWrappers = false } = {}) {
  const runtime = resolve(runtimeInput);
  const rawLock = await readFile(join(project, 'preinstalled.lock.json'));
  const lock = JSON.parse(rawLock);
  let marker;
  try { marker = JSON.parse(await readFile(join(runtime, 'rufa-preinstalled.json'), 'utf8')); }
  catch (error) { throw new Error(`Office/PDF/OCR dependencies are not prepared. Run scripts/prepare-company-plugins.py for this runtime. ${error.message}`); }
  if (marker.lockSha256 !== sha256(rawLock)) throw new Error('Preinstalled dependency lock differs from the prepared runtime');
  const runtimeManifest = JSON.parse(await readFile(join(runtime, 'rufa-runtime.json'), 'utf8'));
  if (runtimeManifest.upstreamCommit !== lock.upstreamCommit) throw new Error('Preinstalled plugins require the pinned Harness revision');
  for (const [name, version] of [[lock.office.name, lock.office.version], ['@deepseek-ai/libreoffice-kit', lock.office.libreofficeKitVersion], ['dsh-file-upload-ocr-plugin', '2.0.0']]) {
    const manifest = JSON.parse(await readFile(join(runtime, 'node_modules', name, 'package.json'), 'utf8'));
    if (manifest.name !== name || manifest.version !== version) throw new Error(`Unexpected preinstalled package: ${name}`);
  }
  for (const entry of ['company-python/python.exe', 'company-python/python312._pth', 'company-python/rufa-dependencies.json',
    'company-tools/dsh-read-pdf/pdf_tools.py', 'company-tools/dsh-read-pdf/LICENSE',
    'node_modules/dsh-file-upload-ocr-plugin/lib/client.js', 'node_modules/dsh-file-upload-ocr-plugin/extract.py',
    'node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/libreoffice-kit.exe']) await access(join(runtime, entry));

  // The reviewed community build targets an older Harness API. Limit this
  // compatibility declaration to this adapted package and our exact fixed peer
  // versions; never relax the native compatibility checker for other plugins.
  const ocrManifestPath = join(runtime, 'node_modules/dsh-file-upload-ocr-plugin/package.json');
  const ocrManifestRaw = await readFile(ocrManifestPath, 'utf8');
  const ocrManifest = JSON.parse(ocrManifestRaw);
  let peerChanged = false;
  // Session services moved out of the old type/runtime umbrella in this source
  // revision. The browser code uses the same `sessions` service, not an import
  // from that removed package.
  if (ocrManifest.peerDependencies['@deepseek-ai/dsh-client-runtime']) {
    delete ocrManifest.peerDependencies['@deepseek-ai/dsh-client-runtime'];
    ocrManifest.peerDependencies['@deepseek-ai/dsh-api-session-controller'] = lock.office.version;
    ocrManifest.dsh.client.inject = ocrManifest.dsh.client.inject.map(name => name === '@deepseek-ai/dsh-client-runtime' ? '@deepseek-ai/dsh-api-session-controller' : name);
    peerChanged = true;
  }
  for (const [name, required] of Object.entries(ocrManifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue;
    const actual = JSON.parse(await readFile(join(runtime, 'node_modules', name, 'package.json'), 'utf8')).version;
    if (actual !== lock.office.version || !['0.1.0-rc.5', actual].includes(required)) throw new Error(`Unreviewed OCR peer: ${name}`);
    if (required !== actual) { ocrManifest.peerDependencies[name] = actual; peerChanged = true; }
  }
  if (peerChanged) {
    await writeFile(join(runtime, 'node_modules/dsh-file-upload-ocr-plugin/UPSTREAM-package.json'), ocrManifestRaw, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await atomic(ocrManifestPath, `${JSON.stringify(ocrManifest, null, 2)}\n`);
  }

  for (const [entry, patch] of [
    ['dsh-file-upload-ocr-plugin/lib/index.js', patchOcrHostSource],
    ['dsh-file-upload-ocr-plugin/lib/client.js', source => patchOcrMessageRendererSource(patchOcrClientSource(source))],
    ['@deepseek-ai/dsh-client-ui-chat/lib/client.js', patchNativeUserMessageSource],
    ['@deepseek-ai/dsh-client-ui-attachment/lib/client.js', patchAttachmentExportsSource],
  ]) {
    const file = join(runtime, 'node_modules', entry);
    const original = await readFile(file, 'utf8');
    const patched = patch(original);
    if (patched !== original) await atomic(file, patched); // Break any NTFS hardlink.
  }
  for (const [folder, name] of [['office', 'dsh-office-bundle'], ['read-pdf', 'dsh-read-pdf-bundle']]) {
    const source = join(project, 'apps/client/preinstalled/bundles', folder);
    const target = join(runtime, 'node_modules/@rufa', name);
    if (syncWrappers) {
      await mkdir(target, { recursive: true });
      for (const file of await readdir(source, { withFileTypes: true })) {
        if (!file.isFile()) throw new Error(`Unexpected nested company bundle asset: ${file.name}`);
        const bytes = await readFile(join(source, file.name));
        const current = await readFile(join(target, file.name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!current?.equals(bytes)) await atomic(join(target, file.name), bytes);
      }
    }
    await access(join(target, 'package.json'));
    await access(join(target, 'cordis.patch.yml'));
  }
  // RuntimeResolution only admits packages in the installation dependency graph.
  // A bundle can be found on disk yet its same-package browser entry be omitted
  // without this declaration. Register only the assets verified above.
  const installationPath = join(runtime, 'package.json');
  const installation = JSON.parse(await readFile(installationPath, 'utf8'));
  const dependencies = { ...installation.dependencies };
  for (const name of ['dsh-file-upload-ocr-plugin', '@rufa/dsh-office-bundle', '@rufa/dsh-read-pdf-bundle']) {
    dependencies[name] = JSON.parse(await readFile(join(runtime, 'node_modules', name, 'package.json'), 'utf8')).version;
  }
  if (JSON.stringify(dependencies) !== JSON.stringify(installation.dependencies)) {
    installation.dependencies = dependencies;
    await atomic(installationPath, `${JSON.stringify(installation, null, 2)}\n`);
  }
  // Keep the fixed source hashes and all upstream dependency licenses with the
  // distribution. Python wheels retain their original .dist-info licenses.
  if (syncWrappers) {
    await copyFile(join(project, 'preinstalled.lock.json'), join(runtime, 'PREINSTALLED-LOCK.json'));
    await copyFile(join(project, 'apps/client/preinstalled/THIRD_PARTY_NOTICES.md'), join(runtime, 'PREINSTALLED-NOTICES.md'));
  }
  return { office: lock.office.version, pdfRevision: lock.sources.find(item => item.id === 'pdf').commit, ocr: '2.0.0', python: lock.python.version };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const runtime = process.argv[2];
  if (!runtime) throw new Error('Usage: node scripts/preinstalled-runtime.mjs <runtime> [--sync-wrappers]');
  console.log(JSON.stringify(await checkPreinstalledRuntime(runtime, { syncWrappers: process.argv.includes('--sync-wrappers') })));
}
