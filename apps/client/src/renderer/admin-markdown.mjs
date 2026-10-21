// Small, inert Markdown renderer. All content goes through text nodes; HTML,
// images, URLs and file references never become executable/navigation targets.
const node = (tag, text) => { const result = document.createElement(tag); if (text != null) result.textContent = text; return result; };
function inline(parent, text, depth = 0) {
  if (depth > 2) { parent.append(document.createTextNode(text)); return; }
  const pattern = /(`+)([^\n]*?)\1|\*\*([^\n]+?)\*\*|__([^\n]+?)__|!?\[([^\]\n]*)\]\(([^\n)]*)\)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(offset, match.index)));
    if (match[1]) parent.append(node('code', match[2]));
    else if (match[3] || match[4]) { const strong = node('strong'); inline(strong, match[3] || match[4], depth + 1); parent.append(strong); }
    else { const ref = node('span', (match[0][0] === '!' ? '图片引用：' : '') + match[5] + (match[6] ? '（' + match[6] + '）' : '')); ref.className = 'inert-reference'; parent.append(ref); }
    offset = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}
const cells = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(value => value.trim().replace(/\\\|/g, '|'));
const tableRule = line => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line ?? '');
export function markdown(text) {
  const root = node('div'); root.className = 'admin-markdown'; const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]; if (!line.trim()) { i++; continue; }
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const body = []; i++;
      while (i < lines.length && !new RegExp('^\\s*' + fence[1][0] + '{' + fence[1].length + ',}\\s*$').test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      const wrap = node('div'); wrap.className = 'code-block'; if (fence[2].trim()) wrap.append(node('div', fence[2].trim()));
      const pre = node('pre'), code = node('code', body.join('\n')); pre.append(code); wrap.append(pre); root.append(wrap); continue;
    }
    if (i + 1 < lines.length && line.includes('|') && tableRule(lines[i + 1])) {
      const wrap = node('div'); wrap.className = 'table-scroll'; const table = node('table'), head = node('thead'), tr = node('tr');
      for (const value of cells(line)) { const th = node('th'); inline(th, value); tr.append(th); } head.append(tr); table.append(head); i += 2;
      const tbody = node('tbody'); while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row = node('tr'); for (const value of cells(lines[i++])) { const td = node('td'); inline(td, value); row.append(td); } tbody.append(row);
      }
      table.append(tbody); wrap.append(table); root.append(wrap); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { const h = node('h' + Math.min(heading[1].length + 1, 6)); inline(h, heading[2]); root.append(h); i++; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { root.append(node('hr')); i++; continue; }
    const list = /^\s*(?:[-+*]|\d+[.)])\s+/.exec(line);
    if (list) {
      const ordered = /^\s*\d/.test(line), ul = node(ordered ? 'ol' : 'ul');
      if (ordered) ul.start = Number(line.trim().match(/^\d+/)[0]);
      while (i < lines.length && /^\s*(?:[-+*]|\d+[.)])\s+/.test(lines[i]) && /^\s*\d/.test(lines[i]) === ordered) {
        const li = node('li'); inline(li, lines[i++].replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '')); ul.append(li);
      } root.append(ul); continue;
    }
    if (/^\s*>/.test(line)) { const quote = []; while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, '')); const block = node('blockquote'); inline(block, quote.join('\n')); root.append(block); continue; }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(?:#{1,6}\s|`{3,}|~{3,}|>|[-+*]\s|\d+[.)]\s)/.test(lines[i]) && !tableRule(lines[i + 1])) paragraph.push(lines[i++]);
    const p = node('p'); inline(p, paragraph.join('\n')); root.append(p);
  }
  return root;
}
