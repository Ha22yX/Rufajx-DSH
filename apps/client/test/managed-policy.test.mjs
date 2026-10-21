import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, installManagementPolicy, managedPlugin } from '../src/runtime/managed-policy.mjs';

function services() {
  const writes = [];
  const manager = {
    async listPlugins() { return ['rufa-model', 'rufa-admin-tools', 'llm-deepseek', 'session-persistence-jsonl', 'llm', 'web', 'session', 'optional'].map(patchId => ({ patchId, entryId: `include:${patchId}` })); },
    async listBundles() { return [{ name: 'core', rows: [{ rowId: 'llm' }] }, { name: 'optional', rows: [{ rowId: 'inspector' }] }]; },
    async setBundleEnabled(name, enabled) { writes.push({ name, enabled }); return { application: 'applied' }; },
    // Match upstream's native method: it rejects the readonly metadata before writing.
    async setPluginEnabled(id, enabled) { const row = (await this.listPlugins()).find(item => item.entryId === id); if (row.readOnlyReason) return { application: 'failed', error: { code: row.readOnlyReason } }; writes.push({ id, enabled }); return { application: 'applied' }; },
  };
  const editor = { async edit(entry, change) { const next = change(entry.options.config, {}); entry.options.config = next; writes.push(next); } };
  return { manager, editor, writes };
}
test('company management is readonly and method calls cannot disable required services or enable direct providers', async () => {
  const { manager, editor, writes } = services();
  const originalList = manager.listPlugins;
  const dispose = installManagementPolicy(manager, editor, { modelIds: ['approved'], defaultModelId: 'approved' });
  const rows = await manager.listPlugins();
  assert.ok(rows.filter(row => row.patchId !== 'optional').every(row => row.readOnlyReason === 'management-required'));
  for (const id of ['rufa-model', 'rufa-admin-tools', 'llm-deepseek', 'llm', 'web', 'session']) assert.equal((await manager.setPluginEnabled(`include:${id}`, false)).application, 'failed');
  assert.equal((await manager.setBundleEnabled('core', false)).application, 'failed'); assert.equal(writes.length, 0);
  assert.equal((await manager.setBundleEnabled('optional', true)).application, 'applied');
  assert.equal((await manager.setPluginEnabled('include:optional', false)).application, 'applied');
  assert.equal(managedPlugin('third-party-utility'), false);
  dispose(); assert.equal(manager.listPlugins, originalList);
});
test('field-level policy leaves user theme, fonts, preferences and allowed reasoning selections editable', async () => {
  const { manager, editor } = services();
  const dispose = installManagementPolicy(manager, editor, { modelIds: ['approved', 'another'], defaultModelId: 'approved' });
  const entry = (id, config = {}) => ({ options: { id, config } });
  const theme = entry('ui-theme', { preference: 'dark' });
  await editor.edit(theme, current => ({ ...current, preference: 'light', fontSize: 15 })); assert.equal(theme.options.config.preference, 'light');
  const model = entry('agent-default-model', { provider: 'deepseek-official', model: 'approved' });
  await editor.edit(model, current => ({ ...current, model: 'another', reasoningEffort: 'high' })); assert.equal(model.options.config.reasoningEffort, 'high');
  await assert.rejects(editor.edit(model, current => ({ ...current, provider: 'arbitrary' })));
  await assert.rejects(editor.edit(model, current => ({ ...current, model: 'not-approved' })));
  // The user explicitly removed the original Models and DeepSeek account pages.
  for (const id of ['ui-settings-models', 'ui-settings-account', 'deepseek-account']) {
    assert.equal(managedPlugin(id), true); await assert.rejects(editor.edit(entry(id), () => ({})));
  }
  await assert.rejects(editor.edit(entry('rufa-model'), () => ({ apiKey: 'synthetic' })));
  dispose();
});

test('tool calls fail closed before Auto is ready and if the reviewer changes while a gate is pending', async () => {
  let readiness, mode = 'auto', downstream = 0;
  const hooks = new Map();
  apply({ on: (name, listener) => hooks.set(name, listener), inject() {}, provide() {},
    get: name => name === 'rufaAutoReviewReady' ? readiness : name === 'permissionPresets' ? { current: () => mode } : undefined,
  }, {});
  const gate = hooks.get('tools/pre-execute');
  const execution = { agent: { session: {} } };
  const allow = async () => { downstream++; return { kind: 'allow' }; };
  assert.equal((await gate(execution, allow)).kind, 'deny'); assert.equal(downstream, 0);
  readiness = { active: true }; mode = 'danger-full-access';
  assert.equal((await gate(execution, allow)).kind, 'deny'); assert.equal(downstream, 0);
  mode = 'auto'; assert.equal((await gate(execution, allow)).kind, 'allow');
  assert.equal((await gate(execution, async () => { readiness = { active: true }; return { kind: 'allow' }; })).kind, 'cancel');
  readiness.active = false;
  assert.equal((await gate(execution, allow)).kind, 'deny');
});

test('protected mutations fail closed when version initialization failed or the service was disposed', async () => {
  let versions, dispatched = 0; const hooks = new Map();
  apply({ on: (name, listener) => hooks.set(name, listener), inject() {}, provide() {}, get: () => versions }, {});
  const gate = hooks.get('tools/execute'), next = () => { dispatched++; return 'native-result'; };
  const execution = { agent: { session: {} }, name: 'write', arguments: { file_path: 'example.txt' } };
  assert.throws(() => gate(execution, next), /尚未就绪/); assert.equal(dispatched, 0);
  versions = { active: true }; assert.equal(gate(execution, next), 'native-result');
  versions.active = false; assert.throws(() => gate(execution, next), /尚未就绪/);
  assert.throws(() => gate({ ...execution, name: 'company_badge', arguments: { operation: 'stamp' } }, next), /尚未就绪/);
  assert.equal(gate({ ...execution, name: 'company_badge', arguments: { operation: 'read' } }, next), 'native-result');
  assert.equal(gate({ ...execution, name: 'read' }, next), 'native-result');
  assert.equal(gate({ ...execution, name: 'str_replace_editor', arguments: { command: 'view' } }, next), 'native-result');
});

test('preinstalled ordinary plugins stay editable while the OCR interpreter remains the shipped one', () => {
  const hooks = new Map();
  apply({ on: (name, listener) => hooks.set(name, listener), inject() {}, provide() {} }, { officePython: 'C:/runtime/company-python/python.exe' });
  const intercept = hooks.get('internal/config');
  const config = intercept.call({ entry: { options: { id: 'file-upload-ocr', name: 'dsh-file-upload-ocr-plugin' } } }, {}, () => ({ pythonCommand: 'other-python', dpi: 96, maxPages: 5 }));
  assert.deepEqual(config, { pythonCommand: 'C:/runtime/company-python/python.exe', dpi: 96, maxPages: 5 });
  for (const id of ['skill-office', 'pdf-reader', 'file-upload-ocr', 'better-sidebar', 'video-preview', 'better-sidebar-audio']) assert.equal(managedPlugin(id), false);
});
