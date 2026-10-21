// The store returns immutable records newest-first in SQLite insertion order.
// A byte hash can merge adjacent ordinary snapshots, but never proves ancestry.
const labels = { before: '修改前', after: '修改后', 'before-restore': '恢复前保留', restored: '恢复结果' };
const ordinary = row => !['restored', 'before-restore'].includes(row.phase) && row.operationStatus !== 'unknown';

export function buildFileVersionGraph(rows) {
  const nodes = [], rawToNode = new Map(), byRaw = new Map(), compareByRaw = new Map();
  let previous;
  for (const row of [...rows].reverse()) {
    // Only adjacent ordinary records collapse. Restore and backup records stay
    // explicit, and the first original ID remains stable as history grows.
    if (previous && ordinary(row) && ordinary(previous) && row.hash === previous.hash) {
      const node = rawToNode.get(previous.id);
      rawToNode.set(row.id, node); byRaw.set(row.id, row);
      compareByRaw.set(row.id, node.compareBeforeId); previous = row; continue;
    }
    const last = previous ? rawToNode.get(previous.id) : null;
    let parentId = last?.id ?? null, compareBeforeId = parentId, kind = row.phase === 'before-restore' ? 'backup' : 'snapshot';
    let restoredFromId, restoredFromCurrentId, notice;
    if (row.phase === 'restored') {
      const source = byRaw.get(row.restoredFromId), current = byRaw.get(row.restoredFromCurrentId);
      const valid = row.operationStatus === 'completed' && source && current
        && source.hash !== null && source.hash === row.hash
        && current.phase === 'before-restore' && current.operationId === row.operationId
        && source.path === row.path && current.path === row.path;
      if (valid) {
        kind = 'restored';
        restoredFromId = rawToNode.get(source.id).id;
        restoredFromCurrentId = rawToNode.get(current.id).id;
        parentId = restoredFromId; compareBeforeId = restoredFromCurrentId;
      } else {
        // An incomplete journal or unavailable source never creates a guessed
        // restore branch, even when identical bytes exist elsewhere in history.
        kind = 'uncertain'; parentId = null;
        notice = '这次恢复的来源或结果尚不能确认，请核对文件。';
      }
    } else if (row.operationStatus === 'unknown') {
      notice = '上次恢复中断；这是恢复前保留的文件。';
    }
    const node = { id: row.id, parentId, compareBeforeId, number: nodes.length + 1,
      name: row.name, label: labels[row.phase] ?? '已保存', createdAt: row.createdAt,
      size: row.size, canRestore: row.hash !== null, kind,
      ...(restoredFromId ? { restoredFromId, restoredFromCurrentId } : {}), ...(notice ? { notice } : {}) };
    nodes.push(node); rawToNode.set(row.id, node); byRaw.set(row.id, row);
    compareByRaw.set(row.id, compareBeforeId); previous = row;
  }
  return { nodes, rawToNode, compareByRaw, latestId: previous ? rawToNode.get(previous.id).id : null };
}

export function fileVersionTree(rows, graph, current) {
  const latest = rows[0], node = latest && graph.rawToNode.get(latest.id);
  let currentId = null, currentState = 'unavailable', notice;
  if (!current || !Object.hasOwn(current, 'hash')) notice = '暂时无法确认当前文件内容。';
  else if (current.hash === null) { currentState = 'missing'; notice = '当前文件不存在，已保存的版本仍可查看。'; }
  else if (latest?.operationStatus === 'unknown' || node?.kind === 'uncertain') notice = '上次恢复结果尚不能确认，请核对当前文件。';
  else if (latest && latest.hash === current.hash) { currentState = 'recorded'; currentId = node.id; }
  else { currentState = 'changed'; notice = '当前文件与最新保存版本不同，可能已被其他程序修改。'; }
  return { nodes: graph.nodes, currentId, currentState, ...(notice ? { notice } : {}) };
}
