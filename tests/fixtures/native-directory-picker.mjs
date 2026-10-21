// Stub only the OS picker result in an isolated runtime. The real UI, host
// controller, validation and project persistence remain in the exercised path.
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, unlink, realpath, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

export async function installNativeDirectoryPickerFixture(runtimeRoot, temporary) {
  assert.equal(process.env.RUFA_DESKTOP_E2E, '1');
  assert.ok(runtimeRoot, 'Explicit isolated runtime required');
  const root = await realpath(runtimeRoot), temp = await realpath(tmpdir());
  const suffix = relative(temp, root);
  assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), 'Never patch the actual client runtime');
  const file = join(root, 'node_modules/@deepseek-ai/dsh-host-directory-picker-native/lib/index.js');
  const source = await readFile(file, 'utf8');
  const anchor = 'pick: (signal) => pickNativeDirectory(signal)';
  assert.equal(source.split(anchor).length, 2, 'Pinned native picker adapter changed');
  const queue = join(temporary, 'native-directory-picker.json');
  await writeFile(queue, JSON.stringify({ choices: [], calls: [] }), { flag: 'wx' });
  const replacement = `pick: (signal) => pickNativeDirectory(signal, { pickWin32Dialog: async () => {
    if (signal.aborted) return null;
    const fs = await import('node:fs/promises');
    const queue = ${JSON.stringify(queue)};
    const state = JSON.parse(await fs.readFile(queue, 'utf8'));
    if (!state.choices.length) throw new Error('No synthetic OS directory selection was prepared');
    const selected = state.choices.shift(); state.calls.push(selected);
    await fs.writeFile(queue, JSON.stringify(state));
    if (selected && typeof selected === 'object') {
      while (!signal.aborted) {
        try { await fs.access(selected.release); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (signal.aborted) return null;
      if (selected.error) throw new Error(selected.error);
      return selected.path;
    }
    return selected;
  } })`;
  const patched = source.replace(anchor, replacement);
  const backup = file + '.rufa-directory-test-backup';
  await copyFile(file, backup, constants.COPYFILE_EXCL);
  const replace = async content => {
    // Test runtime copies may share hardlinks with the build cache.
    const pending = file + '.' + randomUUID() + '.pending';
    try { await writeFile(pending, content, { flag: 'wx' }); await rename(pending, file); }
    finally { await unlink(pending).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  };
  await replace(patched);
  return {
    async select(path) {
      assert.ok(path === null || isAbsolute(path));
      const state = JSON.parse(await readFile(queue, 'utf8'));
      state.choices.push(path); await writeFile(queue, JSON.stringify(state));
    },
    async calls() { return JSON.parse(await readFile(queue, 'utf8')).calls; },
    async hold(path, error) {
      assert.ok(path === null || isAbsolute(path));
      const release = join(temporary, `picker-release-${randomUUID()}`);
      const state = JSON.parse(await readFile(queue, 'utf8'));
      state.choices.push({ path, release, error }); await writeFile(queue, JSON.stringify(state));
      return () => writeFile(release, 'release', { flag: 'wx' });
    },
    async restore() {
      assert.equal(await readFile(file, 'utf8'), patched, 'Test runtime changed while the picker fixture was installed');
      assert.equal(await readFile(backup, 'utf8'), source);
      await replace(source); await unlink(backup);
    },
  };
}
