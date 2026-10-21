import { readFileSync } from 'node:fs';

export const COMPANY_PERSONA = readFileSync(new URL('./company-persona.md', import.meta.url), 'utf8').trim();
const previousPersona = readFileSync(new URL('./company-persona-v1.md', import.meta.url), 'utf8').trim();
const suffixHeading = '## 当前任务或预设的补充职责';
// Recognize only complete, shipped bodies and the exact suffix boundary our
// wrapper emitted. A company name, heading, or near-match is never a marker.
const knownPreviousPersonas = [...new Set([previousPersona, previousPersona.replaceAll('\r\n', '\n'), previousPersona.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')])];
const stockPersonas = new Set([
  'You are a coding agent powered by the {{model}} model.',
  'You are a helpful software engineer assistant.',
]);

// Preserve an explicitly authored task/preset role while replacing the shipped coding-only opener.
export function companyPersonaPrefix(prefix = '') {
  const original = prefix.trimStart();
  if (original.startsWith(COMPANY_PERSONA)) return original;
  if (!original.trimEnd() || stockPersonas.has(original.trimEnd())) return COMPANY_PERSONA;
  for (const previous of knownPreviousPersonas) {
    if (original.trimEnd() === previous) return COMPANY_PERSONA;
    if (original.startsWith(`${previous}\n\n${suffixHeading}\n`) || original.startsWith(`${previous}\r\n\r\n${suffixHeading}\r\n`)) {
      return COMPANY_PERSONA + original.slice(previous.length);
    }
  }
  return `${COMPANY_PERSONA}\n\n## 当前任务或预设的补充职责\n${prefix}`;
}
