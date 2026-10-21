/** Read-only history paging. nextSeq is the whole log head, never a page cursor. */
export function appendEventPage(existing, page) {
  if (!page || !Array.isArray(page.events) || !Number.isSafeInteger(page.nextSeq) || page.nextSeq < 0) throw new Error('服务器记录响应不完整，请重试。');
  const next = existing.length ? existing.at(-1).seq + 1 : 0;
  if (page.nextSeq < next) throw new Error('服务器记录范围发生变化，请重新打开会话。');
  const accepted = [], seen = new Map(existing.map(record => [record.seq, record]));
  let expected = next;
  for (const record of page.events) {
    if (!record || !Number.isSafeInteger(record.seq) || record.seq < 0 || !record.event || typeof record.event !== 'object' || Array.isArray(record.event)) throw new Error('收到无法识别的记录，已保留当前阅读位置。');
    if (record.event.seq != null && record.event.seq !== record.seq) throw new Error('记录编号不一致，请重试。');
    if (seen.has(record.seq)) {
      if (JSON.stringify(seen.get(record.seq)) !== JSON.stringify(record)) throw new Error('相同编号的记录内容发生变化，请重新打开会话。');
      continue;
    }
    if (record.seq !== expected || record.seq >= page.nextSeq) throw new Error('记录分页存在缺口，请从当前位置重试。');
    accepted.push(record); seen.set(record.seq, record); expected++;
  }
  if (!accepted.length && expected < page.nextSeq) throw new Error('服务器未返回下一段记录，请重试；当前内容仍保留。');
  return { added: accepted, records: [...existing, ...accepted], next: expected, head: page.nextSeq, complete: expected >= page.nextSeq };
}
export function dateRange(from, through) {
  const query = {};
  for (const [key, value] of [['from', from], ['to', through]]) {
    if (!value) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效日期。');
    const [year, month, day] = value.split('-').map(Number), date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error('请选择有效日期。');
    if (key === 'to') date.setDate(date.getDate() + 1);
    query[key] = date.toISOString();
  }
  if (query.from && query.to && query.from >= query.to) throw new Error('结束日期不能早于开始日期。');
  return query;
}
