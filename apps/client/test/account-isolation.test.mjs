import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { accountRuntimePaths } from '../dist/runtime-configuration.js';
import { enterpriseOverlay } from '../dist/harness-host.js';
import { isolatedSkillConfig } from '../src/runtime/managed-policy.mjs';

test('company account and server identities own distinct stable skills, profiles and default workspaces', () => {
  const alice = accountRuntimePaths('C:/RufaDSH/harness', 'https://company.example', 'user-alice');
  const bob = accountRuntimePaths('C:/RufaDSH/harness', 'https://company.example', 'user-bob');
  const other = accountRuntimePaths('C:/RufaDSH/harness', 'https://other.example', 'user-alice');
  assert.deepEqual(alice, accountRuntimePaths('C:/RufaDSH/harness', 'https://company.example', 'user-alice'));
  for (const field of ['companyHome', 'skillsRoot', 'agentsHome', 'workspaceRoot', 'profileRoot']) {
    assert.notEqual(alice[field], bob[field]); assert.notEqual(alice[field], other[field]);
  }
  const overlay = enterpriseOverlay('C:/plugins', 'deepseek-flash', ['deepseek-flash'], undefined, alice.companyHome, 'C:/runtime');
  assert.deepEqual(overlay.find(row => row.id === 'agent-preset-registry').inject, ['rufaCompanyPolicy']);
  assert.deepEqual(overlay.find(row => row.id === 'workspace-controller').inject, ['rufaWorkspaceReady', 'rufaProjectDirectories']);
  assert.ok(overlay.find(row => row.id === 'session-controller').inject.includes('rufaProjectDirectories'));
  const rows = overlay.find(row => row.insert).insert;
  assert.equal(rows.find(row => row.id === 'rufa-workspace').config.workspaceRoot, alice.workspaceRoot);
});

test('all filesystem skill providers reject ambient/default roots and keep only current account plus explicit shipped skills', () => {
  const account = accountRuntimePaths('C:/RufaDSH/harness', 'https://company.example', 'alice');
  const bundled = join('C:/runtime', 'node_modules/@deepseek-ai/dsh-agent-preset/skills');
  const config = { ...account, allowedBuiltinSkillDirs: [bundled] };
  assert.deepEqual(isolatedSkillConfig(undefined, config).customSkillDirs, [account.skillsRoot]);
  const result = isolatedSkillConfig({ includeDefaultRoots: true, agentsHome: 'C:/Users/person/.agents',
    dshHome: 'C:/Users/person/.dsh', bundledSkillDir: 'C:/Users/person/.codex/skills',
    customSkillDirs: ['C:/Users/person/.claude/skills', bundled], watch: false }, config);
  assert.equal(result.includeDefaultRoots, false);
  assert.equal(result.dshHome, account.companyHome); assert.equal(result.agentsHome, account.agentsHome);
  assert.deepEqual(result.customSkillDirs, [account.skillsRoot, bundled]);
  assert.equal(result.bundledSkillDir, undefined); assert.equal(result.watch, false);
  assert.throws(() => isolatedSkillConfig({}, {}));
});
