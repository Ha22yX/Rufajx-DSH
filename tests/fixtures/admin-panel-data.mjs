// Synthetic, native-format conversations for the read-only management UI.
// No employee data, external attachments or model calls are used.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { importUpstream } from '../../apps/client/src/runtime/import-upstream.mjs';

const clientRoot = process.env.RUFA_TEST_CLIENT_ROOT;
const { CompanyApi } = await import(clientRoot
  ? pathToFileURL(join(clientRoot, 'dist/company-api.js')).href
  : new URL('../../apps/client/dist/company-api.js', import.meta.url).href);

export const adminFixture = {
  conversation: 'admin-reader-native', other: 'admin-reader-other',
  longEnd: '长回复末尾完整保留-验收标记', tail: '最后一页完整保留-验收标记',
};
export function historyFingerprint(db) {
  const rows = db.prepare('SELECT session_id,seq,event,digest FROM rufa_session_events ORDER BY session_id,seq').all();
  const sessions = db.prepare('SELECT * FROM rufa_sessions ORDER BY id').all();
  return createHash('sha256').update(JSON.stringify({ sessions, events: rows })).digest('hex');
}

export async function seedAdminPanel({ api, account, temporary }) {
  const { Session } = await importUpstream('@deepseek-ai/dsh-session');
  const { createUserMessage, createAssistantMessage, createToolResultMessage } = await importUpstream('@deepseek-ai/dsh-llm');
  const users = {};
  for (const [username, displayName, jobTitle] of [['admin-read-a', '陈晓', '采购专员'], ['admin-read-b', '林然', '设计工程师']]) {
    users[username] = (await api.json('POST', '/admin/users', { username, displayName, jobTitle, role: 'employee', password: 'Synthetic-history-2026' })).user;
  }
  const employee = new CompanyApi({ read: async () => null, write: async () => {}, clear: async () => {} }, true);
  const makeHeader = id => ({ id, version: 4, createdAt: Date.now(), cwd: account.workspaceRoot, isSeeded: false, agentPreset: 'standard' });
  const makeAssistant = text => createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'deepseek', model: 'deepseek-flash' } });
  async function save(id, title, events, header) {
    await employee.json('POST', '/sessions', { id, title, upstreamHeader: header, workspaceRef: header.cwd });
    const lease = await employee.json('POST', `/sessions/${id}/lease`, { deviceId: employee.state.deviceId });
    for (let offset = 0; offset < events.length; offset += 150) {
      await employee.json('POST', `/sessions/${id}/events`, { leaseId: lease.leaseId, expectedNextSeq: offset,
        events: events.slice(offset, offset + 150).map(event => ({ seq: event.seq, event })) });
    }
    await employee.json('DELETE', `/sessions/${id}/lease`, { leaseId: lease.leaseId });
  }
  try {
    await employee.login(api.state.serverUrl, 'admin-read-a', 'Synthetic-history-2026');
    // This exceeds the old UI's inaccessible first 100 sessions.
    for (let index = 0; index < 104; index++) {
      const id = 'admin-reader-archive-' + String(index).padStart(3, '0');
      await employee.json('POST', '/sessions', { id, title: `采购资料整理 ${index + 1}`, upstreamHeader: makeHeader(id) });
    }
    const header = makeHeader(adminFixture.conversation);
    const session = Session.create(header.id, undefined, header);
    session.append('session/title', { title: '设备采购方案与供应商比较', messageSeqs: [], source: { kind: 'user' } });
    session.append('user/message', createUserMessage({ content: [
      { type: 'text', text: '请比较两份设备报价，整理采购建议，并保留合同中的交付条件。' },
      { type: 'file', attachment: { attachmentId: 'sha256:' + 'b'.repeat(64), name: '设备报价对比.xlsx', bytes: 18420 } },
      { type: 'image', attachment: { attachmentId: 'sha256:' + 'c'.repeat(64), name: '设备铭牌.png', bytes: 6400, mediaType: 'image/png', width: 800, height: 600 } },
    ], source: { kind: 'user' } }), { surfaceOp: 'append' });
    session.append('turn/start', { turn: 1 });
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'deepseek', model: 'deepseek-flash' }, content: [
      { type: 'reasoning', text: '先核对交付日期、含税价格与售后范围，再比较两家供应商。' },
      { type: 'text', text: '## 采购建议\n\n两家方案的主要区别如下：\n\n| 比较项 | 甲供应商 | 乙供应商 |\n| --- | --- | --- |\n| 含税价格 | 68,000 元 | 71,500 元 |\n| 交付周期 | 30 天 | 21 天 |\n| 质保期 | 12 个月 | 18 个月 |\n\n**建议优先核实交付时间。** 若生产排期较紧，可考虑乙方。\n\n1. 确认现有设备接口。\n2. 书面确认交付与验收条款。\n3. 留存最终报价与合同。\n\n> 以上为合成验收资料，不代表真实采购建议。\n\n```text\n交付条件：验收合格后支付尾款。\n```' },
    ] }) }, { surfaceOp: 'append' });
    session.append('tool/call', { turn: 1, step: 1, callId: 'read-quote', name: 'read_file', arguments: JSON.stringify({ path: '设备报价对比.xlsx' }) });
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'read-quote', isError: true, content: [{ type: 'text', text: '该附件只有云端引用，本次验收未上传实际文件。' }] }), error: { name: 'FixtureError', code: 'FIXTURE_ONLY', reason: '合成失败结果完整保留' }, meta: { preserved: '完整工具展示元数据' } }, { surfaceOp: 'append' });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '上下文资料注入，不应显示为员工发言。' }], source: { kind: 'fixture-context', form: 'notice', summary: '上下文更新' } }), { surfaceOp: 'append' });
    session.append('fixture/unknown', { complete: '未知插件记录仍可展开查看', nested: { payload: '<img src="file:///C:/private.png" onerror="window.__adminXss=1">' } });
    session.append('assistant/message', { turn: 2, step: 1, stream: [], message: makeAssistant(
      Array.from({ length: 700 }, (_, i) => `第 ${i + 1} 条验收说明：记录保持完整，可阅读所有内容。`).join('\n') + '\n' + adminFixture.longEnd
    ) }, { surfaceOp: 'append' });
    for (let index = 0; index < 80; index++) {
      session.append('turn/start', { turn: index + 3 });
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `补充核对第 ${index + 1} 项资料。` }], source: { kind: 'user' } }), { surfaceOp: 'append' });
      session.append('step/start', { turn: index + 3, step: 1 });
      session.append('assistant/message', { turn: index + 3, step: 1, stream: [], message: makeAssistant(`第 ${index + 1} 项资料已记录。这是测试对话。`) }, { surfaceOp: 'append' });
      session.append('step/end', { turn: index + 3, step: 1 });
      session.append('turn/end', { turn: index + 3, reason: { kind: 'completed' } });
    }
    session.append('assistant/message', { turn: 84, step: 1, stream: [], interrupted: true, message: makeAssistant(adminFixture.tail + '\n<script>window.__adminXss=1</script>\n[不安全链接](javascript:alert(1))') }, { surfaceOp: 'append' });
    session.append('turn/end', { turn: 84, reason: { kind: 'aborted', reason: { kind: 'user' } } });
    await save(header.id, '设备采购方案与供应商比较', session.snapshotEvents(), header);
    const eventCount = session.snapshotEvents().length;
    await employee.logout();
    await employee.login(api.state.serverUrl, 'admin-read-b', 'Synthetic-history-2026');
    const otherHeader = makeHeader(adminFixture.other), other = Session.create(otherHeader.id, undefined, otherHeader);
    other.append('user/message', createUserMessage({ content: [{ type: 'text', text: '请整理装配图检查清单。' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    other.append('assistant/message', { turn: 1, step: 1, stream: [], message: makeAssistant('装配图资料完整。这是另一名员工的会话。') }, { surfaceOp: 'append' });
    await save(otherHeader.id, '装配图检查清单', other.snapshotEvents(), otherHeader);
    const db = new DatabaseSync(join(temporary, 'company.sqlite'));
    let fingerprint;
    try {
      const login = db.prepare('SELECT id FROM rufa_logins WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(users['admin-read-a'].id);
      const insert = db.prepare('INSERT INTO rufa_usage(id,user_id,login_id,model,request_id,status,created_at,input_tokens,output_tokens,total_tokens) VALUES(?,?,?,?,?,?,?,?,?,?)');
      insert.run(randomUUID(), users['admin-read-a'].id, login.id, 'deepseek-flash', randomUUID(), 'completed', new Date().toISOString(), 12000, 1400, 13400);
      insert.run(randomUUID(), users['admin-read-a'].id, login.id, 'deepseek-flash', randomUUID(), 'failed', new Date().toISOString(), null, null, null);
      fingerprint = historyFingerprint(db);
    } finally { db.close(); }
    return { users, eventCount, fingerprint };
  } finally { await employee.logout(); }
}
