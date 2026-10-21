import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// Locale-independent key ordering. Do not change the legacy global canonical
// function: old preference receipts and session headers still use that format.
function canonicalEvent(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalEvent).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalEvent(record[key])}`).join(',')}}`;
}
export const sessionEventDigest = (event: unknown) => `v2:${createHash('sha256').update(canonicalEvent(event)).digest('hex')}`;

/** Legacy digests are not rewritten. Read their original JSON only on mismatch.
 * Object key order is irrelevant; values, Unicode keys and array order are exact. */
export function matchesSessionEvent(digest: string, stored: () => unknown, incoming: unknown): boolean {
  return digest === sessionEventDigest(incoming) || isDeepStrictEqual(stored(), incoming);
}
