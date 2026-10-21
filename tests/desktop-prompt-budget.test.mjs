import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startWorkbenchFixture, until } from './fixtures/desktop-workbench.mjs';

// Measure native serialized requests against a local refusal gateway. No real
// account, API key, paid request, or heuristic presented as billed tokens.
for (const role of ['admin', 'employee']) test(`native ${role} prompt retains tools and two-turn input`,
  { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 120000 }, async t => {
  const f = await startWorkbenchFixture(t, { prefix: `rufa-prompt-${role}-`, captureGatewayBodies: true, role });
  const evaluate = expression => f.harness.evaluate(expression);
  const texts = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(texts)
    : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, v]) => key === 'text' ? texts(v) : ['content', 'messages', 'system'].includes(key) ? texts(v) : []) : [];
  const send = async text => {
    const start = f.gatewayRequests.length;
    await until(() => evaluate('Boolean(document.querySelector("[contenteditable=true]"))'), 'composer ready');
    await evaluate('document.querySelector("[contenteditable=true]").focus()');
    await f.harness.call('Input.insertText', { text });
    await until(() => evaluate('Boolean(document.querySelector("button[aria-label=发送消息]:not(:disabled)"))'), 'send enabled');
    await evaluate('document.querySelector("button[aria-label=发送消息]").click()');
    const request = await until(() => f.gatewayRequests.slice(start).find(body => body?.tools?.length > 20 && texts(body.messages).some(s => s.includes(text))), 'native agent request captured');
    await until(() => evaluate('!document.querySelector("button[aria-label=停止]")&&!document.querySelector("button[aria-label=停止生成]")'), 'mock refusal complete');
    return request;
  };
  const first = await send('请记住：本次验收代号为橙色纸船。');
  const second = await send('请继续保留刚才的验收代号。');
  assert.ok(texts(second.messages).some(s => s.includes('橙色纸船')), 'Earlier user content remains in native model history');
  const system = texts(first.system).join('\n') || (first.messages ?? []).filter(m => m.role === 'system').flatMap(texts).join('\n');
  const tools = first.tools ?? [];
  const persona = (await readFile(join(resolve(process.env.RUFA_TEST_CLIENT_ROOT || 'apps/client'), 'dist/runtime/company-persona.md'), 'utf8')).trim();
  assert.ok(system.startsWith(persona), 'Company prefix reaches the real native system prompt');
  assert.ok(system.includes('如发机械'));
  assert.equal((system.match(/你是 Rufajx-DSH/g) ?? []).length, 1, 'Company persona is not duplicated');
  assert.ok(tools.length > 20, 'Full native tool catalog is available');
  const names = tools.map(tool => tool.name ?? tool.function?.name);
  assert.equal(names.some(name => name?.startsWith('rufa_admin_')), role === 'admin');
  assert.deepEqual(second.tools, tools, 'Second turn preserves the complete tool schemas');
  const report = { role, systemChars: system.length, systemUtf8Bytes: Buffer.byteLength(system),
    tools: tools.length, toolsChars: JSON.stringify(tools).length,
    toolNames: names, toolSchemaSha256: createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
    model: first.model, thinking: first.thinking, outputConfig: first.output_config, maxTokens: first.max_tokens,
    nativePromptSha256: createHash('sha256').update(system.slice(persona.length)).digest('hex'),
    firstMessageChars: JSON.stringify(first.messages ?? []).length, secondMessageChars: JSON.stringify(second.messages ?? []).length };
  if (process.env.RUFA_PROMPT_BASELINE) {
    const before = JSON.parse(await readFile(join(process.env.RUFA_PROMPT_BASELINE, `${role}.json`), 'utf8'));
    assert.equal(report.toolSchemaSha256, before.toolSchemaSha256, 'Every tool parameter and description is unchanged');
    assert.equal(report.model, before.model);
    assert.deepEqual(report.thinking, before.thinking);
    assert.deepEqual(report.outputConfig, before.outputConfig, 'Reasoning effort is unchanged');
    assert.equal(report.maxTokens, before.maxTokens);
    assert.equal(report.nativePromptSha256, before.nativePromptSha256, 'Every non-company system instruction remains byte-identical');
    assert.ok(report.systemChars < before.systemChars, 'Native system prompt is smaller');
    report.savedSystemChars = before.systemChars - report.systemChars;
    report.systemReductionPercent = 100 * report.savedSystemChars / before.systemChars;
  }
  if (process.env.RUFA_PROMPT_REPORT) {
    await mkdir(process.env.RUFA_PROMPT_REPORT, { recursive: true });
    await writeFile(join(process.env.RUFA_PROMPT_REPORT, `${role}.json`), JSON.stringify(report, null, 2));
    await writeFile(join(process.env.RUFA_PROMPT_REPORT, `${role}-system.txt`), system);
  }
  t.diagnostic(JSON.stringify(report));
});
