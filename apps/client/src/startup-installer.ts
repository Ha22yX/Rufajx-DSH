import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';

type Launcher = (file: string, args: string[], options: SpawnOptions) => ChildProcess;
interface InstallRequest {
  installerPath: string | null;
  isAdminRightsRequired: boolean;
  started: () => void;
  failed: () => void;
}
/** Called only by the updater after its downloaded artifact passes verification.
 * No elevation/shell fallback may launch later after failure recovery is shown. */
export function launchStartupInstaller(request: InstallRequest, launch: Launcher = spawn): void {
  let settled = false;
  const failed = () => { if (!settled) { settled = true; request.failed(); } };
  try {
    if (request.isAdminRightsRequired || !request.installerPath || !isAbsolute(request.installerPath)
      || !/^Rufa-DSH-\d+\.\d+\.\d+-x64-Setup\.exe$/.test(basename(request.installerPath))) { failed(); return; }
    const child = launch(request.installerPath, ['--updated', '/currentuser', '--force-run'], {
      detached: true, stdio: 'ignore', shell: false, windowsHide: false,
    });
    child.once('error', failed);
    child.once('spawn', () => {
      if (settled) return;
      settled = true; child.unref(); request.started();
    });
  } catch { failed(); }
}
