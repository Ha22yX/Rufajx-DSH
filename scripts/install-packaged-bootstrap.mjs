// Fixed electron-builder 26.15.3 applies executable metadata after afterPack.
// Preserve the fully prepared/signed Electron image before adding the stable
// bootstrap; otherwise the launcher gets edited and Electron keeps its old name.
import {fileURLToPath} from 'node:url';
import {installBootstrap} from '../apps/client/scripts/install-bootstrap.mjs';
import {verifyBootstrap} from './verify-packaged-preinstalled.mjs';
export default async function afterSign(context) {
  await installBootstrap(context.appOutDir,fileURLToPath(new URL('../apps/client/',import.meta.url)));
  await verifyBootstrap(context.appOutDir);
}
