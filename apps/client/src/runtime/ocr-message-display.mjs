// Display projection only. Stored messages and model input remain unchanged.
// Native UserMessageNodeView/UserContent keep ownership of clocks, copy actions,
// reference labels, image loaders and file cards.
export function rufaOcrDisplayContent(content) {
  const header = /<attached_file name=("(?:\\.|[^"\\])*") kind=("(?:\\.|[^"\\])*")(?: size=(\d+) chars=(\d+))?>\n/g;
  const close = '\n</attached_file>';
  let changed = false;
  const result = [];
  for (let index = 0; index < content.length; index++) {
    const block = content[index];
    if (block?.type !== 'text' || typeof block.text !== 'string') { result.push(block); continue; }
    const original = [block], files = [], visible = [];
    let text = block.text;
    // A serialized reference can span adjacent native text blocks. Join only
    // that contiguous text run; image/file ordering and other blocks stay intact.
    while (content[index + 1]?.type === 'text' && typeof content[index + 1].text === 'string') {
      original.push(content[++index]); text += content[index].text;
    }
    let cursor = 0, match;
    header.lastIndex = 0;
    while ((match = header.exec(text)) !== null) {
      const start = header.lastIndex;
      const end = match[4] === undefined ? text.indexOf(close, start) : start + Number(match[4]);
      const bytes = match[3] === undefined ? undefined : Number(match[3]);
      if (end < start || !Number.isSafeInteger(end) || text.slice(end, end + close.length) !== close
        || (bytes !== undefined && !Number.isSafeInteger(bytes))) continue;
      let name, kind;
      try { name = JSON.parse(match[1]); kind = JSON.parse(match[2]); } catch { continue; }
      if (typeof name !== 'string' || !name || typeof kind !== 'string' || !kind) continue;
      visible.push(text.slice(cursor, match.index));
      // This metadata is consumed only by the native file-card renderer, which
      // reads name/bytes. Do not invent a file id, path or downloadable payload.
      files.push({ type: 'file', attachment: { name, ...(bytes === undefined ? {} : { bytes }) } });
      cursor = end + close.length; header.lastIndex = cursor;
    }
    if (files.length === 0) { result.push(...original); continue; }
    changed = true;
    visible.push(text.slice(cursor));
    const remaining = visible.join('').replace(/\n{3,}/g, '\n\n').trim();
    if (remaining) result.push({ ...block, text: remaining });
    result.push(...files);
  }
  return changed ? result : content;
}
