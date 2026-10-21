import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { solidworksIntent, createSolidworksGate } from '../apps/client/src/runtime/solidworks-intent.mjs';
import { createSolidworksCatalog } from '../apps/client/src/runtime/solidworks-catalog.mjs';
import { SHELL_VERSION_TOOLS, mutationWorkingDirectory, recordFileMutation } from '../apps/client/src/runtime/file-version-tracking.mjs';

const root = fileURLToPath(new URL('../preinstalled/solidworks', import.meta.url));
const messages = (...texts) => texts.map(text => ({ text }));
const event = (text, seq = 0, source = { kind: 'user', rpcId: String(seq) }) => ({ seq, type: 'user/message', data: { content: [{ type: 'text', text }], source } });
const session = events => ({ id: 'main', header: {}, snapshotEvents: () => events, isOwnSeq: () => true });

test('explicit SW modeling intent only; CAD followups persist and unrelated tasks reset it', () => {
  for (const text of ['用SolidWorks2016做一个带孔支架模型', '帮我使用 SW 2016 建模', 'Create a part in SolidWorks']) assert.equal(solidworksIntent(messages(text)), true, text);
  for (const text of ['介绍SolidWorks建模', '不用SolidWorks建模', '请写邮件', '什么是SW', 'Do not use SolidWorks to create it']) assert.equal(solidworksIntent(messages(text)), false, text);
  assert.equal(solidworksIntent(messages('用SW建模', '继续', '把孔径改成10毫米')), true);
  assert.equal(solidworksIntent(messages('用SW建模', '继续', '修改孔径为10毫米')), true);
  assert.equal(solidworksIntent(messages('用SW建模', '写一封邮件', '继续')), false);
});

test('attachments, delegated prose and inherited history cannot activate CAD', () => {
  for (const e of [event('> 用SW建模'), event('<attachment>用SW建模</attachment>'), event('```用SW建模```'), event('用SW建模', 0, { kind: 'user', rpcId: 'x', principal: 'agent' }), event('用SW建模', 0, { kind: 'subagent' })]) {
    const gate = createSolidworksGate(), s = session([e]);
    assert.equal(gate.enabled({ session: s }, true), false);
  }
  const s = session([event('用SW建模')]); s.isOwnSeq = () => false;
  assert.equal(createSolidworksGate().enabled({ session: s }, true), false);
});

test('pending native user input exposes schemas but calls require committed user authority', () => {
  const events = [], s = session(events), agent = { session: s }, gate = createSolidworksGate();
  gate.observe(agent, [event('用SolidWorks建模').data]);
  assert.equal(gate.enabled(agent), true);
  assert.equal(gate.enabled(agent, true), false);
  events.push(event('用SolidWorks建模'));
  gate.observe(agent, []);
  assert.equal(gate.enabled(agent, true), true);
  events.push(event('不用SW了，写一份邮件', 1));
  assert.equal(gate.enabled(agent, true), false);
});

test('child inherits only a live real parent request; missing/cyclic parent fails closed', () => {
  const main = { session: session([event('用SolidWorks建模')]) };
  const child = { session: { id: 'child', header: { origin: 'subagent', parentSession: 'main' } } };
  const agents = new Map([['main', main], ['child', child]]), gate = createSolidworksGate(agents);
  assert.equal(gate.enabled(child, true), true);
  agents.delete('main'); assert.equal(gate.enabled(child, true), false);
  child.session.header.parentSession = 'child'; assert.equal(gate.enabled(child, true), false);
});

test('claimed inbox batch changes first assembly without granting execution authority', () => {
  const s = session([]), agent = { session: s }, gate = createSolidworksGate();
  gate.observe(agent, [event('用SW建模', 1).data], true);
  gate.observe(agent, [event('把孔径改成10毫米', 2).data], true);
  assert.equal(gate.enabled(agent), true);
  assert.equal(gate.enabled(agent, true), false);
  gate.observe(agent, [event('请写一封邮件', 3).data], true);
  assert.equal(gate.enabled(agent), false);
  gate.observe(agent, []);
  assert.equal(gate.enabled(agent), false);
});

test('complete local catalog returns SW2016 signatures, enum values and bounded results', async () => {
  const query = createSolidworksCatalog(root);
  const index = await query({ operation: 'libraries' }); assert.equal(index.libraries.length, 20);
  const member = await query({ operation: 'member', query: 'FeatureExtrusion3', library: 'sldworks' });
  assert.ok(member.items.length); assert.equal(member.items[0].parameters.length, 23);
  assert.match(member.status, /not verified/);
  const enumeration = await query({ operation: 'enum', query: 'swMateGEAR', library: 'swconst' });
  assert.equal(enumeration.items.find(row => row.name === 'swMateGEAR').value, 10);
  const many = await query({ operation: 'search', query: 'Feature', limit: 3 });
  assert.equal(many.items.length, 3); assert.equal(many.nextOffset, 3);
  await assert.rejects(query({ operation: 'member', library: '../../secret', query: 'x' }), /类型库/);
  await assert.rejects(query({ operation: 'search', query: 'Feature', limit: 1000 }), /分页/);
});

test('test evidence retains failures and accepted counts without claiming complete coverage', async () => {
  const query = createSolidworksCatalog(root), index = await query({ operation: 'evidence', limit: 50 });
  assert.deepEqual(index.counts, { reports: 112, acceptedReports: 35, acceptedAssertions: 956 });
  assert.ok(index.items.some(row => row.status === 'historical-diagnostic' && row.failedChecks.length));
  const recipes = await query({ operation: 'recipe', query: 'cam-capsule' });
  assert.ok(recipes.items.length);
  const recipe = await query({ operation: 'recipe', id: recipes.items[0].id, limit: 10 });
  assert.match(recipe.notice, /不要执行旧脚本/); assert.ok(recipe.source.split('\n').length <= 10);
  await assert.rejects(query({ operation: 'recipe', id: '../../secret' }), /未找到/);
});

test('packaged reports and type-library metadata match their evidence hashes', async () => {
  for (const folder of ['catalog', 'evidence']) {
    const index = JSON.parse(await readFile(join(root, folder, 'index.json')));
    for (const row of index.libraries ?? index.reports) assert.equal(createHash('sha256').update(await readFile(join(root, folder, row.file))).digest('hex'), row.sha256, row.file);
  }
});

test('CAD writes participate in whole-workdir version protection and ignore model supplied workdir', async () => {
  assert.equal(SHELL_VERSION_TOOLS.has('company_solidworks_run'), true);
  const execution = { name: 'company_solidworks_run', arguments: { workdir: 'other' }, agent: { id: 'test' }, signal: new AbortController().signal };
  assert.equal(mutationWorkingDirectory(execution, 'current'), 'current');
  const calls = [];
  await assert.rejects(recordFileMutation({ execution, cwd: 'current', scopes: { grant: async () => 'current' },
    store: { capture: async (file, metadata) => { calls.push(metadata.phase); return { hash: 'hash', id: metadata.phase }; } },
    scan: async () => ({ files: ['part.SLDPRT'], excluded: [] }), authorize: async () => calls.push('authorize'),
    next: async () => { calls.push('run'); throw new Error('CAD failed'); }, report: async value => calls.push(value.status) }), /CAD failed/);
  assert.deepEqual(calls, ['before', 'authorize', 'run', 'after', 'failed']);
});
