import type { StoredEvent } from './types.js';

/** Derive a bounded list title without altering any canonical upstream event. */
export function latestSessionTitle(events: readonly StoredEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index].event;
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const value = event as { type?: unknown; data?: unknown };
    if (value.type !== 'session/title' || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) continue;
    const title = (value.data as { title?: unknown }).title;
    if (typeof title !== 'string') continue;
    const trimmed = title.trim();
    if (trimmed.length > 0 && trimmed.length <= 500) return trimmed;
  }
  return undefined;
}
