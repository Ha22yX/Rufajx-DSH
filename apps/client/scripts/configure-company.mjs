import { writeFile } from 'node:fs/promises';
import { normalizeServerUrl } from '../dist/company-api.js';
const [serverInput, mode = 'production'] = process.argv.slice(2);
if (!serverInput || !['production', 'development'].includes(mode)) throw new Error('Usage: node configure-company.mjs <server-origin> [production|development]');
const serverUrl = normalizeServerUrl(serverInput, mode === 'development');
await writeFile(new URL('../company-config.json', import.meta.url), JSON.stringify({ mode, serverUrl }, null, 2));
console.log(`Company endpoint configured: ${serverUrl} (${mode})`);
