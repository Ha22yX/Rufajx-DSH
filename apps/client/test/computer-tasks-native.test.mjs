import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function response({ text, tool, args }, id) {
  const rows = [{ type: 'message_start', message: { id: `mock-${id}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: `call-${id}`, name: tool, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];
  return rows.map(row => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join('');
}

test('native send_message cannot cold-resume a dedicated child before or after a full client restart',
  { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 180000 }, async t => {
    const { startWorkbenchFixture, until } = await import('../../../tests/fixtures/desktop-workbench.mjs');
    const requests = [], issued = new Set(); let phase = 'create', childId;
    const f = await startWorkbenchFixture(t, { prefix: 'rufa-computer-cold-resume-', captureGatewayBodies: true, role: 'employee',
      async seed({ account }) {
        await mkdir(account.profileRoot, { recursive: true });
        await writeFile(join(account.profileRoot, 'package.json'), JSON.stringify({ name: 'synthetic-computer-resume', private: true,
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
        await writeFile(join(account.profileRoot, 'cordis.yml'), '[]\n');
        await writeFile(join(account.profileRoot, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'rufa-test-computer-resume',
          name: new URL('./fixtures/computer-resume-probe.mjs', import.meta.url).href }] }]));
      },
      configureServer(server) {
        server.addHook('preValidation', async (request, reply) => {
          if (!request.url.includes('/gateway/')) return;
          const body = request.body, names = (body.tools ?? []).map(tool => tool.name ?? tool.function?.name);
          requests.push({ phase, body }); let result;
          if (names.includes('company_computer_progress')) result = { text: '隔离电脑子任务已结束；本次未操作桌面。' };
          else if (names.includes('company_computer_task')) {
            if (!issued.has(phase)) {
              issued.add(phase);
              result = phase === 'create' ? { tool: 'company_computer_task', args: { action: 'start', kind: 'application', task: '这是隔离验收，不调用任何电脑工具，直接报告已结束。' } }
                : { tool: 'rufa_test_native_send_message', args: { childId, message: '这是旧任务冷恢复的拒绝验收；若被允许，不要操作桌面，只回复。' } };
            } else result = { text: `${phase}验收已返回。` };
          } else if (JSON.stringify(body.system).includes('final authorization reviewer')) result = { text: '{"risk":"low","decision":"allow"}' };
          else result = { text: '隔离测试' };
          reply.header('content-type', 'text/event-stream; charset=utf-8').send(response(result, requests.length));
        });
      },
    });
    t.diagnostic(`Native cold resume artifacts: ${f.temporary}`);
    const events = id => {
      const db = new DatabaseSync(join(f.account.companyHome, 'company-history.sqlite'), { readOnly: true });
      try { return db.prepare('SELECT event FROM events WHERE session_id=? ORDER BY seq').all(id).map(row => JSON.parse(row.event)); }
      finally { db.close(); }
    };
    const send = async text => {
      await until(() => f.harness.evaluate('Boolean(document.querySelector("[contenteditable=true]"))'), 'composer');
      await f.harness.evaluate('document.querySelector("[contenteditable=true]").focus()');
      await f.harness.call('Input.insertText', { text });
      await until(() => f.harness.evaluate('Boolean(document.querySelector("button[aria-label=发送消息]:not(:disabled)"))'), 'send enabled');
      await f.harness.evaluate('document.querySelector("button[aria-label=发送消息]").click()');
    };
    const idle = () => until(() => f.harness.evaluate('!document.querySelector("button[aria-label=停止]")&&!document.querySelector("button[aria-label=停止生成]")'), 'turn ended');
    const rejectionSeen = () => requests.some(row => row.phase === phase && JSON.stringify(row.body.messages).includes('电脑专用子任务不能直接恢复'));
    try {
      await send('请委派独立电脑子任务做隔离验收，只报告结果，不操作桌面。');
      await until(() => requests.some(row => JSON.stringify(row.body.messages).includes('隔离电脑子任务已结束；本次未操作桌面。')), 'parent completion'); await idle();
      const child = await until(() => f.cache().find(row => row.header.origin === 'subagent'), 'persisted child'); childId = child.id;
      const descriptor = events(childId).find(event => event.type === 'subagent/descriptor');
      assert.equal(descriptor.data.provider, 'rufa-computer-spawn');
      const childRequests = requests.filter(row => row.body.tools?.some(tool => tool.name === 'company_computer_progress')).length;
      assert.equal(childRequests, 1);
      phase = 'cold'; await send('请测试原生send_message尝试恢复刚才的电脑子任务，预期必须拒绝，不要操作桌面。');
      await until(rejectionSeen, 'cold resume rejected', 45000); await idle();
      assert.equal(requests.filter(row => row.phase === 'cold' && row.body.tools?.some(tool => tool.name === 'company_computer_progress')).length, 0);
      await f.restart();
      phase = 'restart'; await send('重启后再次测试原生send_message恢复同一电脑子任务，预期必须拒绝，不要操作桌面。');
      await until(rejectionSeen, 'restart cold resume rejected', 45000); await idle();
      assert.equal(requests.filter(row => row.phase === 'restart' && row.body.tools?.some(tool => tool.name === 'company_computer_progress')).length, 0);
      assert.equal(events(childId).filter(event => event.type === 'turn/start').length, 1, 'Rejected resumes never create another child turn');
    } finally { await writeFile(join(f.temporary, 'synthetic-requests.json'), JSON.stringify(requests, null, 2)); }
  });
