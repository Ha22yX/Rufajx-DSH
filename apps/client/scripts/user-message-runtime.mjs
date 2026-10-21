// Bounded changes to OCR 2.0.0 and the pinned native Chat display projection.
import { rufaOcrDisplayContent } from '../src/runtime/ocr-message-display.mjs';
import { createHash } from 'node:crypto';

function replaceExact(source, before, after, label) {
  if (source.includes(after)) {
    if (source.split(after).length !== 2 || source.replace(after, '').includes(before)) throw new Error(`Ambiguous ${label} patch`);
    return source;
  }
  if (source.split(before).length !== 2) throw new Error(`Pinned ${label} implementation changed`);
  return source.replace(before, () => after);
}

export function patchOcrMessageRendererSource(source) {
  for (const [kind, component] of [['user', 'SentUserFileMessage'], ['steering', 'SentSteeringFileMessage']]) {
    const before = `ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
\t\t\t\tname: "conversation.chat.node",
\t\t\t\tkey: "${kind}",
\t\t\t\tpriority: -10
\t\t\t}, ${component}));`;
    source = replaceExact(source, before,
      `/* Rufajx: native ${kind} message renderer owns time, copy and attachment chrome. */`, `OCR ${kind} renderer`);
  }
  return source;
}

export function patchNativeUserMessageSource(source) {
  const marker = '// Rufajx legacy OCR display projection v1';
  const before = 'function contentParts(content) {\n\t\t\tconst texts = [];';
  const projection = rufaOcrDisplayContent.toString().replaceAll('\r\n', '\n');
  const after = `${marker}\n${projection}\n\t\tfunction contentParts(content) {\n\t\t\tcontent = rufaOcrDisplayContent(content);\n\t\t\tconst texts = [];`;
  if (source.includes(marker) && !source.includes(after)) {
    const start = source.indexOf(`${marker}\n`) + marker.length + 1;
    const end = source.indexOf('\n\t\tfunction contentParts(content) {\n\t\t\tcontent = rufaOcrDisplayContent(content);\n\t\t\tconst texts = [];', start);
    const previous = source.slice(start, end);
    if (source.split(marker).length !== 2 || end < start
      || createHash('sha256').update(previous).digest('hex') !== '3b365933119753858992f709bf9f74c749aa0d20cf68bd5a99617fb0116a93fc') {
      throw new Error('Native user message projection patch is modified');
    }
    // Upgrade only the exact first candidate, never an unrecognized helper.
    source = source.slice(0, start) + projection + source.slice(end);
  }
  source = replaceExact(source, before, after, 'native user message projection');
  // Legacy wrappers have no byte count. Preserve that unknown value instead of
  // inventing a size or allowing the native formatter to display NaNGB.
  return replaceExact(source, '(0, _deepseek_ai_dsh_client_ui_primitives.fileSizeText)(attachment.file.bytes)',
    '(attachment.file.bytes === void 0 ? "" : (0, _deepseek_ai_dsh_client_ui_primitives.fileSizeText)(attachment.file.bytes))', 'legacy OCR unknown size');
}
