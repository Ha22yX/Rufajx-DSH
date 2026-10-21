// A normal Harness client package: its browser half uses supported UI slots.
import { existsSync, readFileSync } from 'node:fs';
import { installContinuationProjection } from '../company-continuation.mjs';
import { emptyInputState, emptyConversationState } from '../empty-session-policy.mjs';
import { installUnusedSessionUi } from '../unused-session-ui.mjs';
import { installFileVersionsUi } from '../file-versions-ui.mjs';
import { installWorkPreferencesUi } from '../preferences-ui.mjs';

function companyMark() {
  const bundled = new URL('./rufajx-mark.png', import.meta.url);
  // Source-level checks use the canonical asset; built and packaged plugins carry their own copy.
  const source = existsSync(bundled) ? bundled : new URL('../../../assets/rufajx-mark.png', import.meta.url);
  return `data:image/png;base64,${readFileSync(source).toString('base64')}`;
}

export function publicCompanyUser(value) {
  if (!value || typeof value.username !== 'string' || !value.username || !['employee', 'admin'].includes(value.role)) return null;
  return { username: value.username, displayName: typeof value.displayName === 'string' ? value.displayName : value.username,
    jobTitle: typeof value.jobTitle === 'string' ? value.jobTitle : '', role: value.role };
}
export async function apply(ctx, config = {}) {
  await installContinuationProjection(ctx);
  const user = publicCompanyUser(config.user);
  const mark = companyMark();
  ctx.on('webserver/index-inject', table => table.push(
    { kind: 'global', name: '__RUFA_COMPANY_USER__', value: user },
    { kind: 'global', name: '__RUFA_COMPANY_MARK__', value: mark },
    { kind: 'script', placement: 'head', text: 'document.title = "Rufajx-DSH";' },
    { kind: 'script', placement: 'head', text: `window.__RUFA_UNUSED_SESSION_UI__ = ${installUnusedSessionUi}; window.__RUFA_EMPTY_POLICY__ = {emptyInputState: ${emptyInputState}, emptyConversationState: ${emptyConversationState}};` },
    { kind: 'script', placement: 'head', text: `window.__RUFA_FILE_VERSIONS_UI__ = ${installFileVersionsUi};` },
    { kind: 'script', placement: 'head', text: `window.__RUFA_PREFERENCES_UI__ = ${installWorkPreferencesUi};` },
    { kind: 'style', text: readFileSync(new URL('./motion.css', import.meta.url), 'utf8') + `\n#rufa-startup { --rufa-startup-mark: url("${mark}"); }` },
    { kind: 'script', placement: 'head', text: readFileSync(new URL('./startup.js', import.meta.url), 'utf8') },
    { kind: 'html', placement: 'body', html: readFileSync(new URL('./startup.html', import.meta.url), 'utf8') },
    // The pinned HeroShell has no badge slot. Limit the override to the company hero, not attachment previews.
    { kind: 'style', text: '[class$="_headline"]:has([data-rufa-brand="mark"]) [class$="_previewBadge"] { display: none !important; }' },
  ));
}
