import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Replayed only on an isolated, hash-checked copy of the official 19.00 sources.
export async function patchNsis7z(root) {
  const file = join(root, 'CPP/7zip/Bundles/Nsis7z/nsis7z.cpp');
  const original = await readFile(file);
  const hash = createHash('sha256').update(original).digest('hex');
  if (hash !== '6e99ce3cef822ef32da6d3bf0827cd6c6c71af4e090759035094d12c17e631cd') {
    throw new Error('Unrecognized Nsis7z source; refusing to patch.');
  }
  let source = original.toString('utf8').replaceAll('\r\n', '\n');
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Nsis7z patch anchor mismatch');
    source = source.replace(before, after);
  };
  replace('#include "StdAfx.h"', '#include "StdAfx.h"\n#include <stdio.h>\n#include <tchar.h>');
  replace('\tconst int nsisProgressMax = 30000;\n\tint val = (int)((completedSize*nsisProgressMax)/totalSize);',
    '\tconst int nsisProgressMax = 30000;\n\tif (totalSize == 0 || totalSize == (UInt64)-1) return 0;\n\tif (completedSize > totalSize) completedSize = totalSize;\n\tint val = (int)((double)completedSize / (double)totalSize * nsisProgressMax);');
  source = source.replaceAll('if (totalSize > 0)', 'if (totalSize > 0 && totalSize != (UInt64)-1)');
  replace('int g_lastVal = -1;', 'int g_lastVal = -1;\nDWORD g_lastProgressTick = 0;\nUInt64 g_lastProgressDone = (UInt64)-1;');
  replace('\tg_lastVal = -1; \\', '\tg_lastVal = -1; \\\n\tg_lastProgressTick = 0; \\\n\tg_lastProgressDone = (UInt64)-1; \\');
  replace('void CallbackProgressHandler(UInt64 completedSize, UInt64 totalSize)\n{\n\tint val = 0;', `void CallbackProgressHandler(UInt64 completedSize, UInt64 totalSize)
{
  const DWORD now = GetTickCount();
  if (completedSize == g_lastProgressDone) return;
  if (g_lastProgressTick != 0 && (DWORD)(now - g_lastProgressTick) < 100 && completedSize < totalSize) return;
  g_lastProgressTick = now;
  g_lastProgressDone = completedSize;
\tint val = 0;`);
  // Bytes processed is not a CRC/write success signal. Reserve completion until
  // the checked decoder has returned to the installer.
  replace('if (val > nsisProgressMax) return nsisProgressMax;', 'if (val >= nsisProgressMax) return nsisProgressMax - 300;');
  replace('wsprintf(buf, TEXT("%lu"), totalSize);', '_sntprintf_s(buf, _countof(buf), _TRUNCATE, TEXT("%I64u"), totalSize);');
  replace('wsprintf(buf, TEXT("%lu"), completedSize);', '_sntprintf_s(buf, _countof(buf), _TRUNCATE, TEXT("%I64u"), completedSize);');
  replace('EXTRACTFUNC(Extract)\n{', `// Return the decoder result instead of silently discarding archive/file errors.
// Catch all decoder exceptions at the DLL boundary; NSIS must never continue.
int ExtractChecked(LPTSTR archive, LPTSTR dir, ExtractProgressHandler handler)
{
  int result = 2;
  try { result = DoExtract(archive, dir, true, true, handler); }
  catch (...) { result = 2; }
  if (result != 0) g_pluginExtra->exec_flags->exec_error = 1;
  return result;
}

EXTRACTFUNC(Extract)
{`);
  for (const handler of ['SimpleProgressHandler', 'DetailsProgressHandler', 'CallbackProgressHandler']) {
    replace(`DoExtract(sArchive, outDir, true, true, (ExtractProgressHandler)${handler});`,
      `pushint(ExtractChecked(sArchive, outDir, (ExtractProgressHandler)${handler}));`);
  }
  await writeFile(file, source.replaceAll('\n', '\r\n'));
  return { before: hash, after: createHash('sha256').update(await readFile(file)).digest('hex') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await patchNsis7z(process.argv[2])));
}
