// Read-only structural audit. Prints counts and lengths, never conversation
// bodies, credentials, names, paths from messages, or model request payloads.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

if (!process.argv[2]) throw new Error('Pass an explicit company-history.sqlite path');
const db = new DatabaseSync(resolve(process.argv[2]), { readOnly: true });
try {
  const usage = { completedAssistantResponses: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const systemChars = [], runtimeContextChars = [], toolCatalogs = [];
  let personaDuplicateEvents = 0;
  const text = blocks => (blocks ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  for (const row of db.prepare('SELECT event FROM events ORDER BY session_id, seq').iterate()) {
    const event = JSON.parse(row.event);
    if (event.type === 'assistant/message' && event.data.usage) {
      const source = event.data.usage;
      usage.completedAssistantResponses++;
      usage.uncachedInput += source.inputTokens ?? 0;
      usage.cacheRead += source.cacheReadTokens ?? 0;
      usage.cacheWrite += source.cacheWriteTokens ?? 0;
      usage.output += source.outputTokens ?? 0;
    } else if (event.type === 'system/message') {
      const value = text(event.data.message.content);
      systemChars.push(value.length);
      if ((value.match(/你是 Rufajx-DSH/g) ?? []).length > 1) personaDuplicateEvents++;
    } else if (event.type === 'user/message' && event.data.source?.kind === 'runtime-context') {
      runtimeContextChars.push(text(event.data.content).length);
    } else if (event.type === 'request/header') {
      const tools = event.data.header.tools ?? [];
      toolCatalogs.push({ tools: tools.length, serializedChars: JSON.stringify(tools).length });
    }
  }
  const input = usage.uncachedInput + usage.cacheRead + usage.cacheWrite;
  console.log(JSON.stringify({
    scope: 'Stored completed assistant-response sample; excludes auxiliary requests/attempts and is not a billing total. Fork-inherited records may overlap.',
    units: 'Character counts are UTF-16 lengths, not exact model tokens.',
    usage, inputCacheReadPercent: input ? 100 * usage.cacheRead / input : null,
    systemChars, runtimeContextChars, personaDuplicateEvents, toolCatalogs,
  }, null, 2));
} finally { db.close(); }
