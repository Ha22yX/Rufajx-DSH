import { createRequire } from 'node:module';
import type { NsisUpdater } from 'electron-updater';
import type { InstallOptions } from 'electron-updater/out/BaseUpdater.js';
import { allowedUpdateRequest, COMPANY_UPDATE_FEED, type UpdaterPort } from './startup-update.js';
import { launchStartupInstaller } from './startup-installer.js';

function startupNsisUpdater(): NsisUpdater {
  const require = createRequire(import.meta.url);
  const Base: typeof NsisUpdater = require('electron-updater').NsisUpdater;
  class StartupNsisUpdater extends Base {
    protected doInstall(options: InstallOptions): boolean {
      launchStartupInstaller({ installerPath: this.installerPath, isAdminRightsRequired: options.isAdminRightsRequired,
        failed: () => this.emit('error', new Error('Installer could not start')),
        started: () => { require('electron').autoUpdater.emit('before-quit-for-update'); this.app.quit(); },
      });
      // 6.8.9 normally queues quit immediately, before its async spawn errors.
      // The native spawn event above is the sole point allowed to quit instead.
      return false;
    }
  }
  return new StartupNsisUpdater({ provider: 'generic', url: COMPANY_UPDATE_FEED, channel: 'latest', useMultipleRangeRequest: false });
}

/** Main-process only. The updater partition never receives company auth data. */
export function createCompanyUpdater(instance?: NsisUpdater): UpdaterPort {
  const updater: NsisUpdater = instance ?? startupNsisUpdater();
  updater.logger = null;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = true;
  updater.requestHeaders = null;
  updater.setFeedURL({ provider: 'generic', url: COMPANY_UPDATE_FEED, channel: 'latest', useMultipleRangeRequest: false });
  // This catches cross-origin redirects as well as unapproved metadata URLs.
  updater.netSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedUpdateRequest(details.url) }));
  updater.netSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const name of Object.keys(headers)) if (/^(authorization|proxy-authorization|cookie|x-api-key)$/i.test(name)) delete headers[name];
    callback({ requestHeaders: headers });
  });
  let checked: Awaited<ReturnType<NsisUpdater['checkForUpdates']>>;
  let disposed = false;
  let installingError: (() => void) | undefined;
  const handleError = () => installingError?.();
  // Keep a non-logging error listener even after disposal for late native requests.
  updater.on('error', handleError);
  return {
    async check(signal) {
      signal.throwIfAborted();
      const result = await updater.checkForUpdates();
      signal.throwIfAborted();
      if (disposed || !result) throw new Error('Update check unavailable');
      checked = result;
      return result.updateInfo;
    },
    async download(signal, progress) {
      signal.throwIfAborted();
      const cancel = () => checked?.cancellationToken?.cancel();
      updater.on('download-progress', progress); signal.addEventListener('abort', cancel, { once: true });
      try {
        if (disposed) throw new Error('Updater disposed');
        const paths = await updater.downloadUpdate(checked?.cancellationToken);
        signal.throwIfAborted();
        if (disposed) throw new Error('Updater disposed');
        return paths;
      } finally { updater.removeListener('download-progress', progress); signal.removeEventListener('abort', cancel); }
    },
    install(onError) {
      if (disposed) throw new Error('Updater disposed');
      installingError = onError;
      updater.quitAndInstall(true, true);
    },
    dispose() { disposed = true; installingError = undefined; checked?.cancellationToken?.cancel(); },
  };
}
