import { cp, access, rename } from 'node:fs/promises';
import { join } from 'node:path';
/** Called after Electron has received its application resources and version.
 * The native launcher is fixed; only the real Electron binary is managed. */
export async function installBootstrap(appOutDir, clientDir) {
  const realApp = join(appOutDir, 'Rufajx-DSH-App.exe');
  try { await access(realApp); throw new Error('Bootstrap already installed in this candidate'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bootstrap = join(clientDir, 'build/updater/Rufajx-DSH.exe'); await access(bootstrap);
  await rename(join(appOutDir, 'Rufajx-DSH.exe'), realApp);
  await cp(bootstrap, join(appOutDir, 'Rufajx-DSH.exe'));
  await cp(join(clientDir, 'build/updater/Rufajx-DSH.exe.config'), join(appOutDir, 'Rufajx-DSH.exe.config'));
}
