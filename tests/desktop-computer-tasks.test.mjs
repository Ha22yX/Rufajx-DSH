import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startWorkbenchFixture, until } from './fixtures/desktop-workbench.mjs';

// Native Electron + company profile + in-process spawn. The company gateway is
// local and scripted; no paid requests, screenshots, keyboard or mouse actions.
const taskTool = 'company_computer_task', progressTool = 'company_computer_progress';
const desktop = name => name.startsWith('mcp__wincu__windows_computer_use_');
function response({ text, tool, args }, id) {
  const events = [{ type: 'message_start', message: { id: `mock-${id}`, type: 'message',
    role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }];
  events.push({ type: 'content_block_start', index: 0, content_block: tool
    ? { type: 'tool_use', id: `call-${id}`, name: tool, input: {} } : { type: 'text', text: '' } });
  events.push({ type: 'content_block_delta', index: 0, delta: tool
    ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text } });
  events.push({ type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: 'message_stop' });
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

test('native dedicated computer child keeps its trace separate and reports completion to parent',
  { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 120000 }, async t => {
  const requests = [];
  let delegated = false, progressed = false;
  const final = '电脑子任务验收完成；未操作真实桌面。';
  const f = await startWorkbenchFixture(t, { prefix: 'rufa-native-computer-', captureGatewayBodies: true, role: 'employee',
    configureServer(server) {
      server.addHook('preValidation', async (request, reply) => {
        if (!request.url.includes('/gateway/')) return;
        const body = request.body;
        requests.push(body);
        const names = (body.tools ?? []).map(tool => tool.name ?? tool.function?.name ?? '');
        let result;
        if (names.includes(progressTool)) {
          if (!progressed) { progressed = true; result = { tool: progressTool, args: { step: 'browser' } }; }
          else result = { text: final };
        } else if (names.includes(taskTool)) {
          if (!delegated) { delegated = true; result = { tool: taskTool, args: { action: 'start', kind: 'browser',
            task: '这是本机隔离验收，只调用 company_computer_progress 更新查看浏览器意图，不截图、不点击、不发送键盘输入，随后报告结果。' } }; }
          else result = { text: JSON.stringify(body.messages).includes(final) ? `已收到：${final}` : '等待电脑子任务结果。' };
        } else if (JSON.stringify(body.system).includes('final authorization reviewer')) result = { text: '{"risk":"low","decision":"allow"}' };
        else result = { text: '本机测试' };
        reply.header('content-type', 'text/event-stream; charset=utf-8').send(response(result, requests.length));
      });
    },
  });
  t.diagnostic(`Native computer task artifacts: ${f.temporary}`);
  const evaluate = value => f.harness.evaluate(value);
  const message = '请通过专用电脑子智能体验收进度，不要实际操作桌面。父会话独有代号：MAIN_ONLY_7148。';
  await until(() => evaluate('Boolean(document.querySelector("[contenteditable=true]"))'), 'composer');
  await evaluate('document.querySelector("[contenteditable=true]").focus()');
  await f.harness.call('Input.insertText', { text: message });
  await until(() => evaluate('Boolean(document.querySelector("button[aria-label=发送消息]:not(:disabled)"))'), 'send enabled');
  await evaluate('document.querySelector("button[aria-label=发送消息]").click()');
  try {
    await until(() => requests.some(body => (body.tools ?? []).some(tool => tool.name === progressTool)), 'native child model request', 45000);
    await until(() => requests.some(body => (body.tools ?? []).some(tool => tool.name === taskTool) && JSON.stringify(body.messages).includes(final)), 'native completion delivered to parent', 45000);
    await until(() => evaluate('!document.querySelector("button[aria-label=停止]")&&!document.querySelector("button[aria-label=停止生成]")'), 'complete');
  } finally {
    await writeFile(join(f.temporary, 'synthetic-requests.json'), JSON.stringify(requests, null, 2));
    await f.capture('completion').catch(() => {});
  }
  const childRequests = requests.filter(body => body.tools?.some(tool => tool.name === progressTool));
  const mainRequests = requests.filter(body => body.tools?.some(tool => tool.name === taskTool));
  assert.ok(childRequests.length >= 2 && mainRequests.length >= 2);
  for (const body of childRequests) {
    const names = body.tools.map(tool => tool.name);
    assert.ok(names.some(desktop));
    assert.ok(names.every(name => desktop(name) || [progressTool, 'structured_output'].includes(name)), names.join(','));
    assert.equal(JSON.stringify(body.messages).includes('MAIN_ONLY_7148'), false, 'Main history is not copied into child');
    assert.equal(body.model, mainRequests[0].model);
    assert.deepEqual(body.thinking, mainRequests[0].thinking);
  }
  for (const body of mainRequests) {
    assert.equal(body.tools.some(tool => desktop(tool.name)), false);
    assert.equal(JSON.stringify(body.messages).includes('已记录操作意图；完成状态仍由实际工具结果决定'), false, 'Child tool result does not pollute main history');
  }
  assert.ok(requests.every(body => body.model === 'deepseek-flash'));
  assert.ok(f.cache().some(row => row.header.origin === 'subagent'), 'Native child history remains available separately');
});
