import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startWorkbenchFixture, until } from './fixtures/desktop-workbench.mjs';

// Real native settings and persistence, using separate synthetic accounts and
// loopback-only server. The running administrator profile is never touched.
for (const scenario of [{ role: 'admin', existing: false }, { role: 'employee', existing: true }]) {
  test(`company preset reaches ${scenario.existing ? 'existing' : 'new'} ${scenario.role} and later edits survive restart`,
    { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 180000 }, async t => {
      const yaml = createRequire(join(process.env.RUFA_TEST_RUNTIME_ROOT, 'package.json'))('yaml');
      const fixture = await startWorkbenchFixture(t, {
        prefix: 'rufa-company-preset-', role: scenario.role, visibleWindow: true,
        async seed({ account }) {
          if (!scenario.existing) return;
          await mkdir(account.profileRoot, { recursive: true });
          await writeFile(join(account.profileRoot, 'package.json'), JSON.stringify({ name: 'existing-synthetic-account', private: true,
            dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
          await writeFile(join(account.profileRoot, 'cordis.yml'), '[]\n');
          await writeFile(join(account.profileRoot, 'cordis.patch.yml'), yaml.stringify([
            { id: 'ui-theme', config: { preference: 'light' } },
            { id: 'cot-translation', config: { provider: 'google', targetLanguage: 'en' } },
            { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } },
            { id: 'better-sidebar', disabled: true, config: { agentOpenTools: false,
              tabsEnabled: { editor: false, subagent: false, sidechat: false, git: true, 'terminal-bottom': true, diff: true },
              viewersEnabled: { markdown: false, html: false, jsonl: false, code: false, 'dsh-audio-preview:audio': false, video: false } } },
          ]));
          for (const marker of ['defaults', 'feature-defaults', 'office-defaults', 'better-sidebar-defaults', 'media-preview-defaults', 'agent-team-defaults', 'badge-skill-defaults']) {
            await writeFile(join(account.profileRoot, `.rufa-${marker}-v1`), '1\n');
          }
          await writeFile(join(account.companyHome, 'unrelated-account-data.txt'), 'Existing account data stays private.');
        },
      });
      const evaluate = expression => fixture.harness.evaluate(expression);
      const readPatch = async () => yaml.parse(await readFile(join(fixture.account.profileRoot, 'cordis.patch.yml'), 'utf8'));
      async function openSettings() {
        await evaluate('document.querySelector(".rufa-more-trigger").click()');
        await until(() => evaluate('[...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.includes("设置"))'), 'settings menu');
        await evaluate('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("设置")).click()');
        await until(() => evaluate('Boolean(document.querySelector("#rufa-job-title"))'), 'account settings');
        const buttons = await evaluate('[...document.querySelectorAll("[data-shortcut-modal=settings] button")].map(e=>e.textContent.trim())');
        for (const label of ['账号信息', '工作偏好', '通用设置']) assert.ok(buttons.includes(label), label);
        assert.ok(!buttons.some(label => /SideBar|Better Sidebar|侧边卡片/i.test(label)), 'Sidebar settings navigation is removed');
      }
      const homeButtons = await evaluate('[...document.querySelectorAll("button")].map(e=>e.textContent.trim())');
      assert.ok(!homeButtons.includes('插件'), 'Homepage plugin navigation is removed');
      for (const label of ['新会话', '自动化任务']) assert.ok(homeButtons.some(text => text.includes(label)), `${label}: ${JSON.stringify(homeButtons)}`);
      await fixture.capture('homepage-no-plugins');
      await openSettings();
      const rows = await readPatch();
      const sidebar = rows.find(r => r.id === 'better-sidebar');
      assert.notEqual(sidebar.disabled, true, 'Sidebar plugin stays enabled');
      for (const id of ['editor', 'subagent', 'sidechat']) assert.equal(sidebar.config.tabsEnabled[id], true, id);
      for (const id of ['git', 'terminal-bottom', 'diff']) assert.equal(sidebar.config.tabsEnabled[id], false, id);
      for (const id of ['markdown', 'html', 'jsonl', 'code', 'dsh-audio-preview:audio', 'video']) assert.equal(sidebar.config.viewersEnabled[id], true, id);
      assert.equal(rows.find(r => r.id === 'ui-theme').config.preference, 'dark');
      assert.equal(rows.find(r => r.id === 'cot-translation').config.provider, 'bing');
      assert.equal(rows.find(r => r.id === 'cot-translation').config.targetLanguage, 'auto');
      assert.equal(rows.find(r => r.id === 'agent-default-model').config.reasoningEffort, 'low');
      assert.equal(rows.find(r => r.id === 'better-sidebar').config.agentOpenTools, true);
      const actualRole = await fixture.shell.evaluate('window.rufa.call("state").then(r=>r.value.user.role)');
      assert.equal(actualRole, scenario.role);
      const overlay = JSON.parse(await readFile(join(fixture.account.companyHome, 'enterprise-overlay.json'), 'utf8'));
      const inserted = overlay.flatMap(row => row.insert ?? []);
      assert.equal(inserted.some(row => row.id === 'rufa-admin-tools'), scenario.role === 'admin');
      assert.ok(inserted.some(row => row.id === 'rufa-auto-review'));
      assert.ok(inserted.some(row => row.id === 'rufa-model'));
      await fixture.capture('settings-no-sidebar');
      await evaluate('document.querySelector("[data-shortcut-modal=settings] button[class$=_close]").click()');
      await evaluate('[...document.querySelectorAll("button")].find(e=>/打开右侧|展开右侧|Expand right/i.test(e.getAttribute("aria-label")||"")).click()');
      await until(() => evaluate('Boolean(document.querySelector("[data-sidebar-right-guide]"))'), 'right sidebar remains available');
      const guide = await evaluate('document.querySelector("[data-sidebar-right-guide]").textContent');
      for (const label of ['文件', '任务管理', '侧边对话']) assert.ok(guide.includes(label), label);
      assert.ok(!guide.includes('新建终端'));
      await fixture.capture('right-sidebar-preserved');

      // The settings entry is intentionally absent. Seed a later account preference
      // directly in this isolated fixture, proving restart does not reset it.
      const edited = await readPatch();
      edited.find(r => r.id === 'better-sidebar').config.tabsEnabled.editor = false;
      await writeFile(join(fixture.account.profileRoot, 'cordis.patch.yml'), yaml.stringify(edited));
      await fixture.restart();
      await openSettings();
      assert.equal((await readPatch()).find(r => r.id === 'better-sidebar').config.tabsEnabled.editor, false);
      if (scenario.existing) assert.equal(await readFile(join(fixture.account.companyHome, 'unrelated-account-data.txt'), 'utf8'), 'Existing account data stays private.');
      assert.equal((await fixture.api.json('GET', '/sessions')).sessions.length, 0);
      assert.equal(fixture.gatewayCalls, 0);
      t.diagnostic(`Native settings validated in ${fixture.temporary}; no model calls.`);
    });
}
