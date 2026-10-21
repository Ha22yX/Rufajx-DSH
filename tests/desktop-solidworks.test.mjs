import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { startWorkbenchFixture, until } from './fixtures/desktop-workbench.mjs';

function stream(result, id) {
  const events = [{ type: 'message_start', message: { id: `mock-${id}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: result.tool ? { type: 'tool_use', id: `call-${id}`, name: result.tool, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: result.tool ? { type: 'input_json_delta', partial_json: JSON.stringify(result.args) } : { type: 'text_delta', text: result.text } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: result.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }, { type: 'message_stop' }];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

test('synthetic employee: native schemas load only on request, reviewed CAD call is versioned, ordinary chat unloads',
  { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 180000 }, async t => {
    const helper = join(process.env.RUFA_TEST_RUNTIME_ROOT, 'company-tools/solidworks/solidworks_runner.py');
    const original = await readFile(helper);
    // Only this isolated runtime gets a deterministic COM substitute. Native
    // Electron, auth, schemas, reviewer and file-version hooks remain real.
    await writeFile(helper, `import json,sys,pathlib,os
sys.stdin.reconfigure(encoding='utf-8')
step=0
for line in sys.stdin:
 r=json.loads(line)
 result={'requestId':r.get('requestId'),'stepComplete':True,'instanceAlive':True,'retained':True,'cleanup':False,'mockCOM':True,'instanceId':'synthetic-'+str(os.getpid())}
 if r['operation']=='run':
  p=pathlib.Path(r['cwd'])/'sw-native-pipeline.txt'
  step+=1
  if step==2: assert p.read_text(encoding='utf-8')=='after1'
  p.write_text('after'+str(step),encoding='utf-8')
  result.update(status='completed',files=[str(p)],stepNumber=step)
 elif r['operation']=='release': result.update(status='released',released=True)
 elif r['operation']=='status': result.update(status='ready')
 else: result={'installed':True,'mockCOM':True}
 print(json.dumps(result),flush=True)
 if r['operation'] in ('release','detect'): break
`);
    t.after(() => writeFile(helper, original));
    const requests = []; let stage = 'ordinary', queried = false, ran = 0;
    const f = await startWorkbenchFixture(t, { prefix: 'rufa-native-sw-', role: 'employee', captureGatewayBodies: true,
      configureServer(server) {
        server.addHook('preValidation', async (request, reply) => {
          if (!request.url.includes('/gateway/')) return;
          const body = request.body; requests.push({ stage, body });
          const names = (body.tools ?? []).map(tool => tool.name ?? tool.function?.name);
          let result;
          if (JSON.stringify(body.system).includes('final authorization reviewer')) result = { text: '{"risk":"low","decision":"allow"}' };
          else if (stage === 'cad' && names.includes('company_solidworks')) {
            if (!queried) { queried = true; result = { tool: 'company_solidworks', args: { operation: 'member', library: 'sldworks', query: 'FeatureExtrusion3' } }; }
            else if (ran < 2) { ran++; result = { tool: 'company_solidworks_run', args: { stepTitle: '合成步骤' + ran, code: 'print("Synthetic step ' + ran + '; no actual CAD in this test")' } }; }
            else result = { text: 'CAD_NATIVE_PIPELINE_COMPLETE' };
          } else result = { text: stage === 'after' ? 'ORDINARY_CHAT_RESTORED' : 'ORDINARY_CHAT_READY' };
          reply.header('content-type', 'text/event-stream; charset=utf-8').send(stream(result, requests.length));
        });
      },
    });
    t.diagnostic(`Synthetic artifacts: ${f.temporary}`);
    t.after(() => writeFile(join(f.temporary, 'requests.json'), JSON.stringify(requests, null, 2)));
    const send = async text => {
      await until(() => f.harness.evaluate('Boolean(document.querySelector("[contenteditable=true]"))'), 'composer');
      await f.harness.evaluate('document.querySelector("[contenteditable=true]").focus()');
      await f.harness.call('Input.insertText', { text });
      // The hidden WebView can expose the previous enabled send button before
      // React has committed the inserted text to its send handler.
      await f.harness.evaluate('new Promise(resolve => setTimeout(resolve, 200))');
      await until(() => f.harness.evaluate('Boolean(document.querySelector("button[aria-label=发送消息]:not(:disabled)"))'), 'send');
      await f.harness.evaluate('document.querySelector("button[aria-label=发送消息]").click()');
    };
    const waitText = async text => {
      try {
        await until(() => f.harness.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), text, 70000);
        await until(() => f.harness.evaluate('!document.querySelector("button[aria-label=停止]")&&!document.querySelector("button[aria-label=停止生成]")'), 'turn complete');
      } catch (error) {
        await f.capture('failure').catch(() => {});
        await writeFile(join(f.temporary, 'failure.txt'), await f.harness.evaluate('document.body.innerText').catch(() => 'unavailable'));
        throw error;
      }
    };
    await send('你好，请回复一句问候。'); await waitText('ORDINARY_CHAT_READY');
    assert.ok(requests.filter(row => row.stage === 'ordinary').every(({ body }) => !(body.tools ?? []).some(tool => tool.name?.startsWith('company_solidworks'))));
    const current = f.cache().find(row => row.header.origin !== 'subagent');
    assert.ok(current?.header.cwd);
    await writeFile(join(current.header.cwd, 'sw-native-pipeline.txt'), 'before');
    stage = 'cad'; await send('请用SolidWorks2016建模，先检查接口。此次是合成环境中的建模流程验收。');
    await waitText('CAD_NATIVE_PIPELINE_COMPLETE');
    const cadRequests = requests.filter(row => row.stage === 'cad');
    assert.ok(cadRequests.some(({ body }) => (body.tools ?? []).some(tool => tool.name === 'company_solidworks_run')));
    assert.ok(cadRequests.some(({ body }) => JSON.stringify(body.system).includes('final authorization reviewer')));
    assert.equal(ran, 2);
    assert.equal(await readFile(join(current.header.cwd, 'sw-native-pipeline.txt'), 'utf8'), 'after2');
    stage = 'after'; await send('现在换个话题，帮我写一句邮件问候。'); await waitText('ORDINARY_CHAT_RESTORED');
    assert.ok(requests.filter(row => row.stage === 'after').every(({ body }) => !(body.tools ?? []).some(tool => tool.name?.startsWith('company_solidworks'))));
    await writeFile(join(f.temporary, 'requests.json'), JSON.stringify(requests, null, 2));
    const db = new DatabaseSync(join(f.account.companyHome, 'file-versions/versions.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT phase,hash,status FROM versions WHERE tool=? ORDER BY seq').all('company_solidworks_run');
      const hashes = ['before', 'after1', 'after2'].map(text => createHash('sha256').update(text).digest('hex'));
      assert.equal(rows[0].phase, 'before');
      for (const hash of hashes) assert.ok(rows.some(row => row.hash === hash), 'Each step must retain its file version');
      assert.equal(rows.at(-1).hash, hashes[2]);
      assert.equal(rows.at(-1).status, 'completed');
    } finally { db.close(); }
  });
